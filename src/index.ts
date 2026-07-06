/**
 * skill-sniffer 🐕👃
 * Public entry point for the package API.
 *
 * Surfaces the CLI runner, the M2 discover/parse primitives, the M3 rule
 * engine + reporter, and the M6 score, JSON report, and config scaffolding.
 */

export { run } from "./cli.js";
export { getVersion } from "./version.js";
export { discoverSkills, looksLikeSkillFile, intersectChanged, SKILL_GLOBS } from "./discover.js";
export type { DiscoverOptions } from "./discover.js";
export {
  changedFilesSince,
  isGitRepo,
  refExists,
  GitError,
} from "./git.js";
export type { GitErrorKind, ChangedFilesOptions } from "./git.js";
export {
  classifyFormat,
  isKnownFormat,
  isSkillFormat,
  resolveFormats,
  canonicalFormat,
  FORMAT_GLOBS,
  FORMAT_LABELS,
  ALL_FORMATS,
} from "./format.js";
export { parseSkill, parseSkills } from "./parse.js";
export { runEngine } from "./engine.js";
export type { EngineOptions } from "./engine.js";
export {
  loadConfig,
  normalizeConfig,
  parseConfigText,
  findConfigFile,
  discoverConfigPath,
  defaultConfig,
  selectRules,
  CONFIG_FILENAMES,
  KNOWN_RULE_IDS,
} from "./config.js";
export type {
  RawConfig,
  ResolvedConfig,
  ResolvedRuleConfig,
  RuleSetting,
} from "./config.js";
export { rules, getRule, frontmatterRule } from "./rules/index.js";
export { renderPretty } from "./report/pretty.js";
export { renderJson, REPORT_SCHEMA } from "./report/json.js";
export { scoreReport, scoreFindings, PENALTIES, MAX_SCORE } from "./score.js";
export {
  writeConfigStub,
  DEFAULT_CONFIG,
  RC_FILENAME,
} from "./init.js";
export { fixContent, fixSkills, unifiedDiff } from "./fix.js";
export type {
  FixKind,
  FixChange,
  FixContentResult,
  FixFileResult,
} from "./fix.js";
export type {
  ParsedSkill,
  SkillFormat,
  Severity,
  Finding,
  Rule,
  RuleContext,
  Report,
  SkillScore,
  ScoredReport,
} from "./types.js";
