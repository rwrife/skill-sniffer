import type { Finding, ParsedSkill, Rule, RuleContext } from "../types.js";
import { findMatches } from "./scan.js";

/**
 * One provenance signature: a labelled regex, the severity a hit warrants, and
 * a short "why" appended to the finding message so the report teaches on the
 * spot (and points the reader at `explain provenance`).
 */
interface ProvenancePattern {
  /** Short kind label used in the finding message (e.g. "pipe-to-shell"). */
  label: string;
  /** Detector. Scanned case-insensitively, multiline, over the raw text. */
  re: RegExp;
  /** Severity for hits: remote-code-execution = `error`; unpinned = `warning`. */
  severity: "error" | "warning";
  /** One-line rationale appended after the offending snippet. */
  why: string;
  /**
   * Optional guard: return true to *reject* a candidate as a false positive
   * (e.g. a pinned package `pkg@1.2.3` or an action pinned to a full SHA).
   */
  isSafe?(text: string): boolean;
}

/**
 * A version pin that makes a `uses:` reference safe: a 40-hex commit SHA. GitHub
 * only treats full-length SHAs as immutable, so that's the bar we hold.
 */
const ACTION_SHA = /@[0-9a-f]{40}\b/i;

/**
 * A concrete package version pin (`@1.2.3`, `@1.2.3-beta.1`, `@1`, `@1.2`). We
 * accept a leading digit as "pinned enough"; floating tags like `@latest`,
 * `@next`, `@main`, or no tag at all are what we flag.
 */
const PKG_PIN = /@\d[\w.\-+]*$/;

/**
 * Strip surrounding markdown / punctuation noise from a token pulled out of
 * prose so pin detection sees the bare `pkg@1.2.3`. Handles the common cases:
 * backticks/quotes around inline code, and trailing sentence punctuation
 * (`,` `.` `)` `` ` `` `"` `'`). Leading noise is trimmed too.
 */
function cleanToken(token: string): string {
  return token.replace(/^[`'"([{]+/, "").replace(/[`'").,;:!?\]}]+$/, "");
}

/**
 * True when a `uses:` line pins to a full commit SHA (the only immutable form).
 * Tags and branches (`@main`, `@v4`, `@master`) are mutable and still fire.
 */
function actionIsPinned(text: string): boolean {
  return ACTION_SHA.test(text);
}

/**
 * True when an install target carries a concrete version pin. Operates on the
 * matched package token (e.g. `express@4.18.2`) — a leading-digit tag passes,
 * `@latest`/`@next`/bare names do not. Accepts both `pkg@1.2.3` (npm/npx) and
 * `pkg==1.2.3` (pip/uv) pin syntaxes, after stripping markdown/punctuation.
 */
function installIsPinned(pkg: string): boolean {
  const clean = cleanToken(pkg);
  if (/==\d/.test(clean)) return true; // pip/uv `pkg==1.2.3`
  const at = clean.lastIndexOf("@");
  // Ignore a leading scope `@`, e.g. `@scope/pkg` — look at the *version* `@`.
  if (at <= 0) return false;
  return PKG_PIN.test(clean.slice(at));
}

/**
 * The provenance pack. Each pattern targets a well-known "go fetch and run
 * something opaque / unpinned" shape from the 2026 skills-supply-chain research.
 * Patterns are conservative so a hit is almost certainly a real footgun.
 *
 * Ordering matters only for output grouping within a file; the highest-severity
 * remote-code-execution shapes come first.
 */
const PATTERNS: ProvenancePattern[] = [
  // ── Pipe-to-shell: curl/wget a URL straight into a shell. Classic RCE. ──
  {
    label: "pipe-to-shell",
    // curl … | sh|bash|zsh  (also `-fsSL` etc.); require an http(s) URL so we
    // don't growl at `cat file | bash`.
    re: /\b(?:curl|wget)\b[^\n|]*\bhttps?:\/\/[^\n|]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|dash)\b/i,
    severity: "error",
    why: "remote code executed straight from the network; vendor the script and review it, or pin+checksum it",
  },
  {
    label: "pipe-to-shell (PowerShell)",
    // iwr/Invoke-WebRequest … | iex/Invoke-Expression — the Windows equivalent.
    re: /\b(?:iwr|invoke-webrequest|curl)\b[^\n|]*\|\s*(?:iex|invoke-expression)\b/i,
    severity: "error",
    why: "remote code piped into Invoke-Expression; download, review, then run a pinned copy instead",
  },
  {
    label: "opaque fetch-and-run",
    // bash <(curl …)  /  sh -c "$(curl …)" — process-substitution / command-sub
    // that runs freshly fetched content.
    re: /\b(?:sudo\s+)?(?:sh|bash|zsh)\b[^\n]*(?:<\(|-c\s*["']?\$\()\s*(?:curl|wget)\b[^\n]*https?:\/\//i,
    severity: "error",
    why: "runs code fetched at execution time (nothing is reviewed or pinned); fetch to a file, inspect, then run",
  },

  // ── Unpinned package installs: floating versions are a supply-chain risk. ──
  {
    label: "unpinned npx",
    // npx pkg@latest OR bare `npx pkg` with no version. Capture the package.
    re: /\bnpx\s+(?:-y\s+|--yes\s+)?(@?[\w./-]+(?:@[\w.\-+]+)?)/i,
    severity: "warning",
    why: "pin the version (`pkg@1.2.3`) so the fetched code can't change under you",
    isSafe: (text) => {
      const m = /\bnpx\s+(?:-y\s+|--yes\s+)?(@?[\w./-]+(?:@[\w.\-+]+)?)/i.exec(text);
      return installIsPinned(m?.[1] ?? "");
    },
  },
  {
    label: "unpinned global npm install",
    // npm i -g pkg / npm install --global pkg without a version pin.
    re: /\bnpm\s+(?:i|install|add)\b[^\n]*\s(?:-g|--global)\b[^\n]*/i,
    severity: "warning",
    why: "global installs off floating versions drift; pin the version and prefer a local dev dependency",
    isSafe: (text) => {
      // Safe only if every non-flag package token is pinned.
      const rest = text.replace(/\bnpm\s+(?:i|install|add)\b/i, "");
      const tokens = rest
        .split(/\s+/)
        .map(cleanToken)
        .filter((t) => t && !t.startsWith("-"));
      if (tokens.length === 0) return false;
      return tokens.every((t) => installIsPinned(t));
    },
  },
  {
    label: "unpinned uvx/pipx run",
    // uvx pkg / pipx run pkg without a version pin.
    re: /\b(?:uvx|pipx\s+run)\s+([\w./-]+(?:(?:@|==)[\w.\-+]+)?)/i,
    severity: "warning",
    why: "pin the tool version so the fetched-and-run package is reproducible",
    isSafe: (text) => {
      const m = /\b(?:uvx|pipx\s+run)\s+([\w./-]+(?:(?:@|==)[\w.\-+]+)?)/i.exec(text);
      return installIsPinned(m?.[1] ?? "");
    },
  },
  {
    label: "pip install from URL",
    // pip install <http…> or `pip install git+https://…` — fetches+builds a
    // package straight off a URL (no index, no pin, arbitrary setup.py).
    re: /\bpip3?\s+install\b[^\n]*\b(?:git\+)?https?:\/\/[^\s]+/i,
    severity: "warning",
    why: "installing off a raw URL runs that project's build code; use a pinned index release or a vendored, hash-checked artifact",
  },

  // ── Unpinned GitHub Actions referenced in the skill text. ──
  {
    label: "unpinned GitHub Action",
    // uses: owner/repo@ref  — flag tag/branch refs; pass full-SHA pins.
    re: /\buses:\s*["']?([\w.-]+\/[\w.-]+(?:\/[\w.-]+)?)@([\w.\-/]+)/i,
    severity: "warning",
    why: "pin the action to a full commit SHA (`@<40-hex>`); tags and branches are mutable and can be repointed",
    isSafe: (text) => actionIsPinned(text),
  },

  // ── Sketchy fetch hosts: URL shorteners and raw-IP endpoints. ──
  {
    label: "fetch from URL shortener",
    // A shortener host inside a fetch command — opaque redirect target.
    re: /\b(?:curl|wget|iwr|invoke-webrequest|fetch)\b[^\n]*\bhttps?:\/\/(?:bit\.ly|t\.co|tinyurl\.com|goo\.gl|is\.gd|buff\.ly|ow\.ly|rebrand\.ly)\//i,
    severity: "warning",
    why: "shortened URLs hide their real destination; use the full, canonical URL so reviewers can see what's fetched",
  },
  {
    label: "fetch from raw IP over http",
    // A bare IPv4 host over plaintext http in a fetch command.
    re: /\b(?:curl|wget|iwr|invoke-webrequest|fetch)\b[^\n]*\bhttp:\/\/(?:\d{1,3}\.){3}\d{1,3}\b/i,
    severity: "warning",
    why: "a raw-IP plaintext endpoint is unauthenticated and opaque; fetch over https from a named, trusted host",
  },
];

/**
 * Provenance rule — flag remote-code-execution and unpinned supply-chain
 * instructions in agent-context files.
 *
 * A skill's real blast radius is often *what it tells the agent to go fetch and
 * run*: `curl … | bash`, `npx pkg@latest`, `pip install` off a URL, an unpinned
 * `uses: owner/action@main`, or a fetch from a shortener / raw IP. Those are the
 * SKILL.md equivalent of an unpinned dependency. This rule sniffs the raw text
 * for those shapes with precise line numbers; it never *makes* the request — it
 * just flags the instruction (fully static / offline, on-brand).
 *
 * Severities: pipe-to-shell and opaque fetch-and-run = `error`; unpinned
 * installs/actions and sketchy hosts = `warning`. Pinned equivalents
 * (`pkg@1.2.3`, `uses: …@<40-hex-sha>`, checksum-verified downloads) do not
 * fire, keeping false positives low. All findings carry line/column.
 */
export const provenanceRule: Rule = {
  id: "provenance",
  description:
    "Flag opaque/unpinned remote fetches: curl|bash, @latest installs, unpinned action refs, shortener/raw-IP fetches.",
  defaultSeverity: "error",
  rationale:
    "A skill's blast radius comes from what it tells the agent to fetch and run. " +
    "Piping a network script into a shell ('curl … | bash'), installing floating " +
    "versions ('npx pkg@latest', 'pip install <url>'), or referencing an unpinned " +
    "GitHub Action ('uses: owner/action@main') all run code that can silently " +
    "change under you — the natural-language equivalent of an unpinned dependency. " +
    "Pin versions to an exact release or commit SHA, vendor and review remote " +
    "scripts, and fetch over https from named, trusted hosts.",
  example: {
    lang: "bash",
    bad: "curl -fsSL https://get.example.com/install.sh | bash",
    good: "# download, review, then run a pinned + checksum-verified copy\ncurl -fsSL https://get.example.com/install-v1.2.3.sh -o install.sh\nsha256sum -c install.sh.sha256 && bash install.sh",
  },

  run(skill: ParsedSkill, ctx: RuleContext): Finding[] {
    if (!skill.raw) return [];

    const findings: Finding[] = [];
    const seen = new Set<string>();
    const push = (
      line: number,
      column: number,
      severity: "error" | "warning",
      message: string,
    ) => {
      const key = `${line}:${column}:${message}`;
      if (seen.has(key)) return;
      seen.add(key);
      findings.push({
        ruleId: provenanceRule.id,
        severity: ctx.severityFor(provenanceRule, severity),
        message,
        path: skill.path,
        line,
        column,
      });
    };

    for (const pat of PATTERNS) {
      for (const m of findMatches(skill.raw, pat.re)) {
        if (pat.isSafe?.(m.text)) continue;
        push(
          m.line,
          m.column,
          pat.severity,
          `${pat.label}: "${truncate(m.text)}" — ${pat.why}`,
        );
      }
    }

    return findings;
  },
};

/**
 * Clip long matched snippets so the report stays one line, and trim stray
 * markdown/prose noise that a broad `[^\n]*` match can pull in (a leading
 * chunk of a sentence before the command, or a trailing inline-code backtick).
 * Purely cosmetic — detection already happened; this just keeps the message tidy.
 */
function truncate(s: string, max = 80): string {
  let flat = s.replace(/\s+/g, " ").trim();
  // Drop a trailing inline-code backtick / quote the match ran into.
  flat = flat.replace(/[`'"]+$/, "").trimEnd();
  // If the snippet starts with prose before the actual command, clip to the
  // first recognized command keyword so the finding leads with the footgun.
  const cmd = /\b(?:curl|wget|iwr|invoke-webrequest|bash|sh|npx|npm|uvx|pipx|pip3?|uses:)\b/i.exec(flat);
  if (cmd && cmd.index > 0) flat = flat.slice(cmd.index);
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
