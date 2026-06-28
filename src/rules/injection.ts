import type { Finding, ParsedSkill, Rule, RuleContext } from "../types.js";
import { findMatches, offsetToPosition } from "./scan.js";

/** A bait signature: a labelled regex plus the severity it warrants. */
interface BaitPattern {
  /** What kind of injection this is, for the finding message. */
  label: string;
  /** Detector. Scanned case-insensitively over the raw text. */
  re: RegExp;
  /** Severity for hits (most are `error`; softer "voice hijack" phrasing warns). */
  severity: "error" | "warning";
}

/**
 * Classic prompt-injection bait aimed at *agents* reading the skill. These are
 * the phrases an attacker hides in a skill to override the host instructions.
 * Kept high-signal so we error confidently.
 */
const BAIT: BaitPattern[] = [
  {
    label: "instruction-override phrase",
    re: /\bignore\s+(?:all\s+|any\s+)?(?:the\s+)?(?:previous|prior|above|preceding|earlier)\s+(?:instructions?|prompts?|messages?|context|directions?)\b/i,
    severity: "error",
  },
  {
    label: "instruction-override phrase",
    re: /\bdisregard\s+(?:all\s+|any\s+)?(?:the\s+|your\s+)?(?:previous|prior|above|system)\s+(?:instructions?|prompts?|rules?|message)\b/i,
    severity: "error",
  },
  {
    label: "system-prompt override",
    re: /\b(?:disregard|ignore|forget|override)\s+(?:your\s+|the\s+)?system\s+prompt\b/i,
    severity: "error",
  },
  {
    label: "role-reassignment phrase",
    re: /\byou\s+are\s+now\s+(?:a\s+|an\s+|the\s+)?(?:[a-z]+\s+){0,4}(?:assistant|model|ai|dan|jailbreak|admin|developer|root|hacker)\b/i,
    severity: "error",
  },
  {
    label: "memory-wipe phrase",
    re: /\b(?:forget|erase|clear)\s+(?:everything|all)\s+(?:you|that|above|previously)\b/i,
    severity: "warning",
  },
  {
    label: "exfiltration prompt",
    re: /\b(?:print|reveal|output|repeat|show)\s+(?:me\s+)?(?:your\s+|the\s+)?(?:system\s+prompt|initial\s+instructions|hidden\s+(?:rules|instructions)|api[_-]?keys?|secrets?)\b/i,
    severity: "error",
  },
  {
    label: "guardrail-bypass phrase",
    re: /\b(?:do\s+not|don't)\s+(?:tell|inform|mention\s+to|alert)\s+(?:the\s+)?(?:user|human|operator)\b/i,
    severity: "warning",
  },
];

/**
 * Invisible / zero-width / bidi control characters. These render as nothing (or
 * reorder text) in an editor but are still fed to the model — a favorite way to
 * smuggle instructions past human review. We flag every occurrence with its
 * codepoint.
 */
export const INVISIBLE_CHARS: Record<number, string> = {
  0x200b: "zero-width space (U+200B)",
  0x200c: "zero-width non-joiner (U+200C)",
  0x200d: "zero-width joiner (U+200D)",
  0x200e: "left-to-right mark (U+200E)",
  0x200f: "right-to-left mark (U+200F)",
  0x2028: "line separator (U+2028)",
  0x2029: "paragraph separator (U+2029)",
  0x202a: "left-to-right embedding (U+202A)",
  0x202b: "right-to-left embedding (U+202B)",
  0x202c: "pop directional formatting (U+202C)",
  0x202d: "left-to-right override (U+202D)",
  0x202e: "right-to-left override (U+202E)",
  0x2060: "word joiner (U+2060)",
  0xfeff: "zero-width no-break space / BOM (U+FEFF)",
};

/**
 * HTML comment containing imperative/agent-directed language. Authors use
 * `<!-- -->` for genuine notes, so we only flag comments that read like *orders
 * to the agent* (imperatives, "you must", "system:"), not every comment.
 */
const SUSPICIOUS_COMMENT =
  /<!--[\s\S]{0,400}?(?:ignore|disregard|you\s+are|you\s+must|system\s*:|assistant\s*:|do\s+not\s+tell|reveal|exfiltrate|instructions?)[\s\S]{0,400}?-->/i;

/**
 * Prompt-injection scent rule — the other headline scent.
 *
 * Scans raw skill text for three families of agent-targeted bait:
 *  1. **Bait phrases** — "ignore previous instructions", "you are now…",
 *     "disregard your system prompt", exfiltration/guardrail-bypass lines.
 *  2. **Invisible characters** — zero-width and bidi controls that hide text
 *     from human reviewers but not from the model.
 *  3. **Suspicious instruction comments** — `<!-- … -->` blocks that read like
 *     commands to the agent rather than notes to a human.
 *
 * Most hits are `error`; softer "don't tell the user" / memory-wipe phrasing is
 * a `warning` since it occasionally appears in legitimate UX copy. All findings
 * carry line/column.
 */
export const injectionRule: Rule = {
  id: "injection",
  description:
    "Flag prompt-injection bait: override phrases, zero-width/bidi chars, and agent-directed HTML comments.",
  defaultSeverity: "error",

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
        ruleId: injectionRule.id,
        severity: ctx.severityFor(injectionRule, severity),
        message,
        path: skill.path,
        line,
        column,
      });
    };

    // 1. Bait phrases.
    for (const bait of BAIT) {
      for (const m of findMatches(skill.raw, bait.re)) {
        push(
          m.line,
          m.column,
          bait.severity,
          `prompt-injection ${bait.label}: "${truncate(m.text)}"`,
        );
      }
    }

    // 2. Invisible / bidi control characters (scan codepoints directly).
    for (let i = 0; i < skill.raw.length; i++) {
      const code = skill.raw.charCodeAt(i);
      const desc = INVISIBLE_CHARS[code];
      if (!desc) continue;
      const pos = offsetToPosition(skill.raw, i);
      push(pos.line, pos.column, "error", `hidden ${desc} in skill text`);
    }

    // 3. Suspicious agent-directed HTML comments.
    for (const m of findMatches(skill.raw, SUSPICIOUS_COMMENT)) {
      push(
        m.line,
        m.column,
        "error",
        "suspicious instruction-like HTML comment (possible hidden prompt)",
      );
    }

    return findings;
  },
};

/** Clip long matched snippets so the report stays one line. */
function truncate(s: string, max = 60): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
