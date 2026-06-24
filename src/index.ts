/**
 * skill-sniffer 🐕👃
 * Public entry point for the package API.
 *
 * Surfaces the CLI runner, the M2 discover/parse primitives, and the M3 rule
 * engine + reporter. Later milestones will add score/JSON here.
 */

export { run } from "./cli.js";
export { getVersion } from "./version.js";
export { discoverSkills, looksLikeSkillFile, SKILL_GLOBS } from "./discover.js";
export { parseSkill, parseSkills } from "./parse.js";
export { runEngine } from "./engine.js";
export { rules, getRule, frontmatterRule } from "./rules/index.js";
export { renderPretty } from "./report/pretty.js";
export type {
  ParsedSkill,
  Severity,
  Finding,
  Rule,
  RuleContext,
  Report,
} from "./types.js";
