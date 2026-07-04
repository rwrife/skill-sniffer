import { existsSync } from "node:fs";
import { dirname, resolve, isAbsolute } from "node:path";
import type { Finding, ParsedSkill, Rule, RuleContext } from "../types.js";
import { findMatches } from "./scan.js";

/**
 * Broken local-path rule.
 *
 * The classic skill footgun: a `SKILL.md` says "run `./scripts/setup.sh`" or
 * links `[helper](../lib/helper.py)`, the path is resolved *relative to the
 * skill file's own directory* at agent-runtime, and it doesn't actually exist —
 * so the agent fabricates or fails. This rule extracts relative path references
 * from the skill text, resolves each against `dirname(skill.path)` (exactly how
 * a host would), and flags the ones missing on disk.
 *
 * It is deliberately conservative to keep false positives near zero:
 *  - Only *relative* paths are checked. URLs (`http(s)://`, `mailto:`,
 *    protocol-relative `//host`), bare anchors (`#section`), and absolute paths
 *    are ignored — absolute paths mean something different on every machine, so
 *    flagging them would be noise.
 *  - A reference must look like a file path (contain a `/` **or** end in a
 *    recognizable file extension) so prose words in inline code don't match.
 *  - This is the one rule that touches disk (read-only `existsSync`). It never
 *    throws: an unreadable/odd path is simply treated as not-found-skippable.
 *
 * Findings carry line/column (where the reference appears) and are `error` —
 * a dangling path is a concrete, will-break-at-runtime defect.
 */

/** Schemes / shapes that are explicitly *not* local relative paths. */
const NON_LOCAL = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#|mailto:|tel:)/i;

/** Looks like a file: has a path separator or a trailing `.<ext>` (1–8 chars). */
const LOOKS_LIKE_FILE = /\/|\.[A-Za-z0-9]{1,8}$/;

/**
 * Markdown inline links / images: `[text](target)` and `![alt](target)`.
 * Captures the target (group 1), stopping at whitespace or a `)`/title so we
 * don't slurp a `"title"` suffix. The leading `!` is optional (images).
 */
const MD_LINK = /!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^)]*["'])?\s*\)/g;

/**
 * Inline code spans: `` `something` ``. We only treat the contents as a path if
 * it passes the file-shape test below, so `` `npm test` `` won't be flagged but
 * `` `./scripts/setup.sh` `` will.
 */
const INLINE_CODE = /`([^`\n]+)`/g;

export const brokenPathsRule: Rule = {
  id: "broken-paths",
  description:
    "Resolve relative file paths referenced in the skill against its own directory; flag missing ones.",
  defaultSeverity: "error",
  rationale:
    "Skills routinely point at helper scripts, templates, or docs by relative " +
    "path. If that path doesn't resolve against the skill's own directory the " +
    "instruction is dead on arrival — the agent tries to read a file that " +
    "isn't there and either errors or hallucinates. Catching it at lint time " +
    "beats discovering it mid-run. Fix the path or ship the missing file.",
  example: {
    lang: "markdown",
    bad: "Run the setup helper at `./scripts/setup.sh`.   (file does not exist)",
    good: "Run the setup helper at `./scripts/setup.sh`.   (file committed alongside SKILL.md)",
  },

  run(skill: ParsedSkill, ctx: RuleContext): Finding[] {
    // Need a real on-disk location to resolve against. In-memory/virtual skills
    // (no readable file) can't be path-checked meaningfully, so skip them.
    if (!skill.raw || !skill.path) return [];

    const baseDir = dirname(skill.path);
    const findings: Finding[] = [];
    const seen = new Set<string>();

    const consider = (candidate: string, line: number, column: number) => {
      const ref = cleanRef(candidate);
      if (!ref || !isCheckablePath(ref)) return;

      const abs = safeResolve(baseDir, ref);
      if (abs === undefined || existsSync(abs)) return;

      const key = `${line}:${column}:${ref}`;
      if (seen.has(key)) return;
      seen.add(key);

      findings.push({
        ruleId: brokenPathsRule.id,
        severity: ctx.severityFor(brokenPathsRule, "error"),
        message: `broken local path: \`${ref}\` does not exist (resolved against the skill's directory)`,
        path: skill.path,
        line,
        column,
      });
    };

    // Markdown links/images: report the position of the captured target.
    for (const m of findMatches(skill.raw, MD_LINK, 1)) {
      consider(m.text, m.line, m.column);
    }

    // Inline code spans that look like paths.
    for (const m of findMatches(skill.raw, INLINE_CODE, 1)) {
      consider(m.text, m.line, m.column);
    }

    return findings;
  },
};

/** Strip a leading `./`, trailing slashes, and an optional anchor/query tail. */
function cleanRef(raw: string): string {
  let ref = raw.trim();
  // Drop in-document anchors / query strings on links (`file.md#section`).
  const hash = ref.indexOf("#");
  if (hash > 0) ref = ref.slice(0, hash);
  const q = ref.indexOf("?");
  if (q > 0) ref = ref.slice(0, q);
  return ref.trim();
}

/** True when `ref` is a relative, file-shaped path worth checking on disk. */
function isCheckablePath(ref: string): boolean {
  if (ref.length === 0) return false;
  if (NON_LOCAL.test(ref)) return false; // URL, scheme, anchor, //host
  if (isAbsolute(ref)) return false; // machine-specific; not our call
  if (ref.startsWith("~")) return false; // home-relative; not skill-relative
  // Must look like a file reference, not an arbitrary code word.
  if (!LOOKS_LIKE_FILE.test(ref)) return false;
  // Guard against obvious non-paths that still contain a slash (e.g. "a/b" odds
  // like regexes or dates are rare in code spans; the existsSync check is the
  // real filter, this just trims noise). Spaces almost never appear in real
  // committed paths referenced this way → skip multi-word code like `cd /tmp`.
  if (/\s/.test(ref)) return false;
  return true;
}

/**
 * Resolve `ref` against `baseDir`, returning `undefined` if resolution throws
 * (malformed path). Read-only; never creates anything.
 */
function safeResolve(baseDir: string, ref: string): string | undefined {
  try {
    return resolve(baseDir, ref);
  } catch {
    return undefined;
  }
}
