import type { Finding, ParsedSkill, Rule, RuleContext } from "../types.js";
import { isSkillFormat } from "../format.js";

/**
 * Length past which a `description` is considered bloated. Frontmatter
 * descriptions get injected into agent context verbatim, so an essay here is
 * pure token waste. The threshold is intentionally generous for M3; M-later
 * config can tune it.
 */
const MAX_DESCRIPTION_LENGTH = 200;

/**
 * The frontmatter contract rule \u2014 the first real scent.
 *
 * Checks the YAML frontmatter every *skill* is expected to carry:
 * - `name` is present and a non-empty string  \u2192 error if missing.
 * - `description` is present and a non-empty string \u2192 error if missing.
 * - `description` isn't absurdly long \u2192 warning past {@link MAX_DESCRIPTION_LENGTH}.
 *
 * It also re-surfaces a parse-level `error` (malformed YAML / unreadable file)
 * as a finding, so the engine has something to report instead of silently
 * dropping a broken file. When the frontmatter couldn't be parsed at all we
 * skip the name/description checks (we'd just be guessing).
 *
 * **Multi-format degradation (issue #10).** The required-field contract only
 * makes sense for the native `SKILL.md` format. Other agent-context files
 * (`AGENTS.md`, `CLAUDE.md`, `.cursorrules`, MCP manifests) routinely carry no
 * frontmatter at all, so on those we *don't* demand `name`/`description` \u2014
 * we only validate a `description` when one is actually present (still catches
 * an overlong one), and we still surface genuine parse errors.
 */
export const frontmatterRule: Rule = {
  id: "frontmatter",
  description:
    "Require name + description frontmatter on skills; warn on missing or overlong description.",
  defaultSeverity: "error",

  run(skill: ParsedSkill, ctx: RuleContext): Finding[] {
    const findings: Finding[] = [];
    const error = (message: string) => findings.push(make(skill, ctx, "error", message));
    const warn = (message: string) => findings.push(make(skill, ctx, "warning", message));

    // A parse failure means the frontmatter block is untrustworthy. Report it
    // once and don't pile on with derived name/description complaints. Applies
    // to every format \u2014 malformed YAML is malformed YAML.
    if (skill.error) {
      error(skill.error);
      return findings;
    }

    const { name, description } = skill.frontmatter;

    // Required-field contract: skills only. Non-skill formats have no such
    // contract, so we skip these checks entirely and degrade gracefully.
    if (isSkillFormat(skill.format)) {
      if (!isNonEmptyString(name)) {
        error(
          isMissing(name)
            ? "missing required frontmatter field `name`"
            : "frontmatter field `name` must be a non-empty string",
        );
      }

      if (!isNonEmptyString(description)) {
        error(
          isMissing(description)
            ? "missing required frontmatter field `description`"
            : "frontmatter field `description` must be a non-empty string",
        );
      }
    }

    // Overlong-description check runs for *any* format that actually declares a
    // string description \u2014 an essay in frontmatter wastes context tokens no
    // matter the file type. For a skill missing its description the block above
    // already errored; this simply won't fire.
    if (
      isNonEmptyString(description) &&
      description.trim().length > MAX_DESCRIPTION_LENGTH
    ) {
      warn(
        `frontmatter \`description\` is ${description.trim().length} chars ` +
          `(over ${MAX_DESCRIPTION_LENGTH}); trim it to save context tokens`,
      );
    }

    return findings;
  },
};

/** Build a finding pinned to the frontmatter rule, routed through ctx for severity. */
function make(
  skill: ParsedSkill,
  ctx: RuleContext,
  severity: Finding["severity"],
  message: string,
): Finding {
  return {
    ruleId: frontmatterRule.id,
    severity: ctx.severityFor(frontmatterRule, severity),
    message,
    path: skill.path,
  };
}

/** True when a value is a string with non-whitespace content. */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Distinguish "field absent" from "field present but wrong type/empty". */
function isMissing(value: unknown): boolean {
  return value === undefined || value === null;
}
