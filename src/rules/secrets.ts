import type { Finding, ParsedSkill, Rule, RuleContext } from "../types.js";
import { findMatches, redact, type Match } from "./scan.js";

/**
 * One credential signature: a labelled regex plus a guard that rejects obvious
 * placeholders so we don't growl at documentation examples.
 */
interface SecretPattern {
  /** Short, human label used in the finding message (e.g. "AWS access key id"). */
  label: string;
  /** Matches the credential. The first capture group, if present, is the value. */
  re: RegExp;
  /**
   * Which capture group holds the reported value. Defaults to 1 (most patterns
   * capture the credential itself); set to 0 for self-contained shapes like a
   * PEM header that have no inner group.
   */
  group?: number;
  /** When true, this match is a placeholder/example, not a real leak → skip it. */
  isPlaceholder?(match: Match): boolean;
}

/**
 * Substrings that, when they appear *inside* a candidate secret, mark it as an
 * obvious placeholder rather than a live credential. Keeps false positives off
 * docs like `sk-xxxxxxxx` or `AKIAIOSFODNN7EXAMPLE`.
 */
const PLACEHOLDER_HINTS = [
  "example",
  "xxxx",
  "your",
  "placeholder",
  "redacted",
  "1234567890",
  "abcdef",
  "<",
  "{{",
];

/** True when a candidate looks like a doc placeholder rather than a real key. */
function looksPlaceholder(value: string): boolean {
  const v = value.toLowerCase();
  return PLACEHOLDER_HINTS.some((h) => v.includes(h));
}

/**
 * The credential pack. Patterns are intentionally conservative — they target
 * well-known, high-confidence shapes so a hit is almost certainly a real leak.
 * Add a new key type by appending one entry here.
 */
const PATTERNS: SecretPattern[] = [
  {
    // AWS access key id: AKIA / ASIA / AGPA … + 16 base32 chars.
    label: "AWS access key id",
    re: /\b((?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA)[A-Z0-9]{16})\b/,
    isPlaceholder: (m) => looksPlaceholder(m.text),
  },
  {
    // OpenAI / Anthropic-style secret key: sk- (optionally sk-proj-/sk-ant-)
    // followed by a long token. Require length so "sk-" prose doesn't match.
    label: "OpenAI/Anthropic-style secret key",
    re: /\b(sk-(?:proj-|ant-|live-|test-)?[A-Za-z0-9_-]{20,})\b/,
    isPlaceholder: (m) => looksPlaceholder(m.text),
  },
  {
    // GitHub tokens: classic ghp_, plus the other prefixes GitHub ships.
    label: "GitHub personal access token",
    re: /\b((?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,})\b/,
    isPlaceholder: (m) => looksPlaceholder(m.text),
  },
  {
    // Slack token: xox[baprs]-… (covers bot/user/app/refresh variants).
    label: "Slack token",
    re: /\b(xox[baprs]-[A-Za-z0-9-]{10,})\b/,
    isPlaceholder: (m) => looksPlaceholder(m.text),
  },
  {
    // Google API key: AIza + 35 chars.
    label: "Google API key",
    re: /\b(AIza[0-9A-Za-z_-]{35})\b/,
    isPlaceholder: (m) => looksPlaceholder(m.text),
  },
  {
    // PEM private key header — the value *is* the leak; report the whole match.
    label: "private key block",
    re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/,
    group: 0,
  },
  {
    // Generic `API_KEY=…` / `SECRET: …` style assignments with a real-looking
    // value. We capture the value (group 1) and skip quotes/placeholders so we
    // don't flag `API_KEY=` with nothing after it or `API_KEY="your-key"`.
    label: "hardcoded secret assignment",
    re: /\b(?:[A-Z0-9_]*(?:API[_-]?KEY|SECRET|TOKEN|PASSWORD|PASSWD|ACCESS[_-]?KEY))\b\s*[:=]\s*["']?([A-Za-z0-9_\-./+=]{12,})["']?/i,
    isPlaceholder: (m) => looksPlaceholder(m.text) || /^[*•xX]+$/.test(m.text),
  },
];

/**
 * Secret-detection rule — a headline scent.
 *
 * Scans the *raw* file text (so line/column match the editor) for a pack of
 * high-confidence credential shapes: AWS keys, `sk-…` provider keys, GitHub
 * PATs, Slack/Google keys, PEM private-key headers, and generic
 * `API_KEY=value` assignments. Obvious documentation placeholders
 * (`sk-xxxx`, `AKIA…EXAMPLE`, `your-token`) are deliberately ignored to keep
 * false positives near zero.
 *
 * Every hit is an `error`: a real key in a skill file ships straight into an
 * agent's context. The reported message redacts the value so the report itself
 * never re-leaks it.
 */
export const secretsRule: Rule = {
  id: "secrets",
  description:
    "Detect leaked credentials (AWS, sk-… keys, GitHub PATs, private keys, API_KEY= assignments).",
  defaultSeverity: "error",
  rationale:
    "A skill file is code that gets shared, committed, and pasted into agent " +
    "context, so a hard-coded credential in one is a live leak: anyone who " +
    "reads the repo (or the agent's transcript) gets the key. Secrets belong " +
    "in environment variables or a secrets manager the agent reads at runtime, " +
    "never inline. Obvious placeholders (`sk-xxxx`, `YOUR_KEY_HERE`) are " +
    "ignored so examples don't trip the alarm.",
  example: {
    lang: "markdown",
    bad: 'Use the key `sk-live-9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c` when calling the API.',
    good: "Read the key from `$OPENAI_API_KEY`; never hard-code it in the skill.",
  },

  run(skill: ParsedSkill, ctx: RuleContext): Finding[] {
    if (!skill.raw) return [];

    const findings: Finding[] = [];
    const seen = new Set<string>(); // dedupe identical hits at the same spot

    for (const pattern of PATTERNS) {
      const group = pattern.group ?? 1;
      for (const match of findMatches(skill.raw, pattern.re, group)) {
        if (pattern.isPlaceholder?.(match)) continue;

        const key = `${match.line}:${match.column}:${pattern.label}`;
        if (seen.has(key)) continue;
        seen.add(key);

        findings.push({
          ruleId: secretsRule.id,
          severity: ctx.severityFor(secretsRule, "error"),
          message: `possible ${pattern.label} leaked: ${redact(match.text)}`,
          path: skill.path,
          line: match.line,
          column: match.column,
        });
      }
    }

    return findings;
  },
};
