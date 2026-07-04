import type { Finding, ParsedSkill, Rule, RuleContext } from "../types.js";
import { findMatches } from "./scan.js";

/**
 * Tool-scope rule.
 *
 * Skills frequently declare which tools/commands the agent may use — in
 * frontmatter (`allowed-tools`, `tools`, `permissions`, …) and/or in prose. A
 * grant of `exec: *` or "any shell command" hands an autonomous agent an
 * unbounded blast radius: the whole point of a skill's tool list is to *narrow*
 * what it can do. This rule flags wildcards and broad catch-all grants so they
 * get a second look before shipping.
 *
 * Two surfaces are inspected:
 *  1. **Frontmatter grants** — common keys are normalized to a flat list of
 *     grant strings (arrays, comma lists, and `tool: scope` maps all collapse),
 *     then each is tested for a wildcard / "all" scope.
 *  2. **Body prose** — free-text catch-alls like "any shell command",
 *     "unrestricted access", "all tools", "run arbitrary code".
 *
 * Wildcard grants are `error` (a real over-permission); softer prose like
 * "full access" is a `warning` since it sometimes describes intent rather than
 * a literal grant. Frontmatter findings are whole-file (the YAML block has no
 * reliable per-key offset here); prose findings carry line/column.
 */

/** Frontmatter keys that conventionally hold a tool/permission grant. */
const GRANT_KEYS = [
  "allowed-tools",
  "allowed_tools",
  "allowedtools",
  "tools",
  "tool",
  "permissions",
  "permission",
  "allow",
  "grants",
  "capabilities",
];

/**
 * A single grant string is "broad" when its *scope* is a wildcard or an
 * all-quantifier. Matches `*`, `exec: *`, `bash:*`, `tool=all`, `read/write/*`,
 * and bare `all`/`any`/`*`. Tuned to catch the dangerous shapes without
 * flagging a normal `exec` (no scope) or a specific `exec: ls`.
 */
const BROAD_GRANT =
  /(^|[\s:=/,([{"'])\*($|[\s:=/,)\]}"'])|:\s*\*|=\s*\*|\b(?:all|any|\*|everything|unrestricted|arbitrary)\b/i;

/** A bare wildcard token, for a sharper message when the whole grant is `*`. */
const PURE_WILDCARD = /^[*]$|^["']?\*["']?$/;

/**
 * Body-prose catch-alls. These describe an over-broad capability in words. Kept
 * high-signal; each carries its own severity (literal grants → error, vaguer
 * "full access" phrasing → warning).
 */
const PROSE_PATTERNS: { re: RegExp; severity: "error" | "warning"; label: string }[] = [
  {
    re: /\bany\s+(?:shell\s+command|command|bash\s+command|tool|tools|code)\b/i,
    severity: "error",
    label: "grants any command/tool",
  },
  {
    re: /\b(?:run|execute)\s+arbitrary\s+(?:code|commands?|shell)\b/i,
    severity: "error",
    label: "permits arbitrary code execution",
  },
  {
    re: /\b(?:unrestricted|unlimited|full|root|admin(?:istrator)?)\s+(?:access|permissions?|privileges?|shell)\b/i,
    severity: "warning",
    label: "claims broad/unrestricted access",
  },
  {
    re: /\ball\s+(?:tools|commands|permissions)\b/i,
    severity: "warning",
    label: "grants all tools/commands",
  },
];

export const toolScopeRule: Rule = {
  id: "tool-scope",
  description:
    "Flag wildcard or overly broad tool grants (e.g. `exec: *`, \"any shell command\").",
  defaultSeverity: "error",
  rationale:
    "A skill that grants itself unrestricted tools — `exec: *`, 'any shell " +
    "command', full filesystem write — hands the agent a blank check, so one " +
    "bad instruction or injection becomes arbitrary code execution. " +
    "Least-privilege means enumerating the specific commands or scopes the " +
    "skill actually needs, which also documents its blast radius for reviewers.",
  example: {
    lang: "yaml",
    bad: "tools:\n  exec: \"*\"   # any shell command",
    good: "tools:\n  exec:\n    - git status\n    - git diff",
  },

  run(skill: ParsedSkill, ctx: RuleContext): Finding[] {
    const findings: Finding[] = [];
    const seen = new Set<string>();

    const push = (
      severity: "error" | "warning",
      message: string,
      line?: number,
      column?: number,
    ) => {
      const key = `${line ?? 0}:${column ?? 0}:${message}`;
      if (seen.has(key)) return;
      seen.add(key);
      findings.push({
        ruleId: toolScopeRule.id,
        severity: ctx.severityFor(toolScopeRule, severity),
        message,
        path: skill.path,
        ...(line !== undefined ? { line } : {}),
        ...(column !== undefined ? { column } : {}),
      });
    };

    // 1. Frontmatter grants (whole-file; no reliable per-key offset).
    for (const key of GRANT_KEYS) {
      if (!(key in skill.frontmatter)) continue;
      for (const grant of flattenGrants(skill.frontmatter[key])) {
        if (!BROAD_GRANT.test(grant)) continue;
        const detail = PURE_WILDCARD.test(grant.trim())
          ? "a bare wildcard"
          : `\`${truncate(grant)}\``;
        push(
          "error",
          `overly broad tool grant in \`${key}\`: ${detail} — scope it to the specific tools the skill needs`,
        );
      }
    }

    // 2. Body prose catch-alls (carry line/column).
    for (const { re, severity, label } of PROSE_PATTERNS) {
      for (const m of findMatches(skill.raw || skill.body, re)) {
        push(severity, `tool-scope: ${label} ("${truncate(m.text)}")`, m.line, m.column);
      }
    }

    return findings;
  },
};

/**
 * Normalize a frontmatter grant value into a flat list of grant strings.
 *
 * Handles the shapes skills use in the wild:
 *  - string  → split on commas (`"exec, read"`), but keep a `tool: *` intact.
 *  - array   → recurse into each element.
 *  - object  → `{ exec: "*" }` becomes `["exec: *"]` (key + scope pairs).
 *  - other   → stringified.
 */
function flattenGrants(value: unknown): string[] {
  if (value == null) return [];
  if (typeof value === "string") {
    // A lone "exec: *" or "*" should survive; only split plain comma lists.
    if (value.includes(",") && !value.includes(":")) {
      return value.split(",").map((s) => s.trim()).filter(Boolean);
    }
    return [value.trim()].filter(Boolean);
  }
  if (Array.isArray(value)) {
    return value.flatMap((v) => flattenGrants(v));
  }
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).map(
      ([k, v]) => `${k}: ${stringifyScope(v)}`,
    );
  }
  return [String(value)];
}

/** Render an object-map scope value for the `key: scope` form. */
function stringifyScope(v: unknown): string {
  if (Array.isArray(v)) return v.map((x) => String(x)).join(" ");
  if (v != null && typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/** Clip long grant/snippet text so the report stays one line. */
function truncate(s: string, max = 60): string {
  const flat = String(s).replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
