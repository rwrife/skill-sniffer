import type {
  Finding,
  ParsedSkill,
  Report,
  Rule,
  RuleContext,
  Severity,
} from "./types.js";
import { rules as defaultRules } from "./rules/index.js";
import { makeTokenBloatRule } from "./rules/token-bloat.js";
import {
  defaultConfig,
  selectRules,
  type ResolvedConfig,
} from "./config.js";

/** Severity ordering for stable, useful sort (loudest first). */
const SEVERITY_RANK: Record<Severity, number> = {
  error: 0,
  warning: 1,
  info: 2,
};

/** Tuning passed to {@link runEngine}. All optional; sensible defaults apply. */
export interface EngineOptions {
  /**
   * Resolved project config. Drives which rules run (disabled rules are
   * dropped), per-rule severity overrides, and the token budget. Defaults to
   * the built-in {@link defaultConfig}.
   */
  config?: ResolvedConfig;
  /**
   * Explicit rule set to run. Defaults to the registry. Tests use this to run a
   * single rule in isolation; config-based enable/disable is layered on top.
   */
  rules?: readonly Rule[];
}

/**
 * Run every (enabled) rule over every skill and aggregate the findings into a
 * {@link Report}.
 *
 * Design notes:
 * - **Config-aware.** Disabled rules are filtered out; the token-bloat budget is
 *   taken from config; per-rule severity overrides are applied via the
 *   {@link RuleContext} so individual rules stay oblivious to config.
 * - **Total, never throws.** A rule that throws is caught and converted into an
 *   `error` finding tagged to that rule, so one buggy rule can't sink the run.
 * - **Stable order.** Findings are sorted by file path, then severity (loudest
 *   first), then rule id \u2014 deterministic output for tests and diffs.
 * - **Back-compatible.** The old `runEngine(skills, rules)` call shape still
 *   works: an array second argument is treated as the rule set.
 */
export function runEngine(
  skills: ParsedSkill[],
  optionsOrRules: EngineOptions | readonly Rule[] = {},
): Report {
  const options: EngineOptions = Array.isArray(optionsOrRules)
    ? { rules: optionsOrRules }
    : (optionsOrRules as EngineOptions);

  const config = options.config ?? defaultConfig();
  const baseRules = options.rules ?? defaultRules;
  const effectiveRules = applyConfigToRules(baseRules, config);

  const ctx = createContext(config);
  const findings: Finding[] = [];

  for (const skill of skills) {
    for (const rule of effectiveRules) {
      findings.push(...safeRun(rule, skill, ctx));
    }
  }

  findings.sort(compareFindings);

  return {
    findings,
    skillsChecked: skills.length,
    counts: tally(findings),
  };
}

/**
 * Resolve the rule set actually executed: drop config-disabled rules, then
 * swap in a token-bloat rule carrying the configured budget (when the default
 * registry's token-bloat rule is present and the budget differs from default).
 */
function applyConfigToRules(
  rules: readonly Rule[],
  config: ResolvedConfig,
): Rule[] {
  const enabled = selectRules(rules, config);
  return enabled.map((rule) =>
    rule.id === "token-bloat" ? makeTokenBloatRule(config.tokenBudget) : rule,
  );
}

/**
 * Build the per-run rule context. `severityFor` applies a config severity
 * override for the rule's id when present; otherwise it honors the finding's
 * own chosen severity (or the rule default). Centralizing it here means
 * config-driven tuning needs zero changes in any rule.
 */
function createContext(config: ResolvedConfig): RuleContext {
  return {
    severityFor(rule: Rule, fallback?: Severity): Severity {
      const override = config.rules[rule.id]?.severity;
      if (override) return override;
      return fallback ?? rule.defaultSeverity;
    },
  };
}

/** Run one rule, converting any thrown error into a single error finding. */
function safeRun(rule: Rule, skill: ParsedSkill, ctx: RuleContext): Finding[] {
  try {
    return rule.run(skill, ctx);
  } catch (err) {
    return [
      {
        ruleId: rule.id,
        severity: "error",
        message: `rule "${rule.id}" crashed: ${(err as Error).message}`,
        path: skill.path,
      },
    ];
  }
}

/** Deterministic ordering: path \u2192 severity (loudest first) \u2192 rule id \u2192 line \u2192 column. */
function compareFindings(a: Finding, b: Finding): number {
  if (a.path !== b.path) return a.path < b.path ? -1 : 1;
  if (a.severity !== b.severity) {
    return SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
  }
  if (a.ruleId !== b.ruleId) return a.ruleId < b.ruleId ? -1 : 1;
  if ((a.line ?? 0) !== (b.line ?? 0)) return (a.line ?? 0) - (b.line ?? 0);
  return (a.column ?? 0) - (b.column ?? 0);
}

/** Count findings per severity, always returning all keys (zeroed). */
function tally(findings: Finding[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { error: 0, warning: 0, info: 0 };
  for (const f of findings) counts[f.severity]++;
  return counts;
}
