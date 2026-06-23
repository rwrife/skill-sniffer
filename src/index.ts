/**
 * skill-sniffer 🐕👃
 * Public entry point for the package API.
 *
 * Surfaces the CLI runner plus the M2 discover/parse primitives.
 * Later milestones will add engine/score/report here.
 */

export { run } from "./cli.js";
export { getVersion } from "./version.js";
export { discoverSkills, looksLikeSkillFile, SKILL_GLOBS } from "./discover.js";
export { parseSkill, parseSkills } from "./parse.js";
export type { ParsedSkill } from "./types.js";
