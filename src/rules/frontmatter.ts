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
export function makeFrontmatterRule(options: {
  requiredFields?: readonly ("name" | "description")[];
  maxDescriptionLength?: number | null;
  parseErrorSeverity?: "error" | "warning";
} = {}): Rule {
  const required = options.requiredFields ?? ["name", "description"];
  const maxDescriptionLength = options.maxDescriptionLength === undefined
    ? MAX_DESCRIPTION_LENGTH : options.maxDescriptionLength;
  return {
    id: "frontmatter",
    description:
      "Require name + description frontmatter on skills; warn on missing or overlong description.",
    defaultSeverity: "error",
    rationale:
      "A skill's `name` and `description` are the only parts an agent sees before " +
      "deciding whether to load it, so a missing or empty one makes the skill " +
      "undiscoverable (or silently mis-picked). An overlong `description` is the " +
      "opposite problem: it's injected verbatim into context on every candidate " +
      "match, so an essay here is a recurring token tax. This contract only " +
      "applies to native SKILL.md files; other formats are checked leniently.",
    example: {
      lang: "yaml",
      bad: "---\nname: \ndescription: \n---\n# does a thing",
      good:
        "---\nname: pdf-extract\ndescription: Extract text + tables from PDFs into Markdown.\n---\n# does a thing",
    },

    run(skill: ParsedSkill, ctx: RuleContext): Finding[] {
      const findings: Finding[] = [];
      const error = (message: string) => findings.push(make(this, skill, ctx, "error", message));
      const warn = (message: string) => findings.push(make(this, skill, ctx, "warning", message));

      // Fallback parsers may accept malformed YAML, but read failures are
      // always errors: no host can load content we could not inspect.
      if (skill.error) {
        if (options.parseErrorSeverity === "warning" &&
            !skill.error.startsWith("could not read file:")) {
          warn(skill.error);
        } else {
          error(skill.error);
        }
        return findings;
      }

      const { name, description } = skill.frontmatter;

      // Other agent-context formats have no required-frontmatter contract.
      if (isSkillFormat(skill.format)) {
        if (required.includes("name") && !isNonEmptyString(name)) {
          error(
            isMissing(name)
              ? "missing required frontmatter field `name`"
              : "frontmatter field `name` must be a non-empty string",
          );
        }

        if (required.includes("description") && !isNonEmptyString(description)) {
          error(
            isMissing(description)
              ? "missing required frontmatter field `description`"
              : "frontmatter field `description` must be a non-empty string",
          );
        }
      }

      if (
        isNonEmptyString(description) &&
        maxDescriptionLength !== null &&
        description.trim().length > maxDescriptionLength
      ) {
        warn(
          `frontmatter \`description\` is ${description.trim().length} chars ` +
            `(over ${maxDescriptionLength}); trim it to save context tokens`,
        );
      }

      return findings;
    },
  };
}

export const frontmatterRule = makeFrontmatterRule();

/** Build a finding pinned to the frontmatter rule, routed through ctx for severity. */
function make(
  rule: Rule,
  skill: ParsedSkill,
  ctx: RuleContext,
  severity: Finding["severity"],
  message: string,
): Finding {
  return {
    ruleId: rule.id,
    severity: ctx.severityFor(rule, severity),
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
