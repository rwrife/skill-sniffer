import type {
  Finding,
  ParsedSkill,
  Report,
  Rule,
  RuleContext,
  Severity,
} from "./types.js";
import { rules as defaultRules } from "./rules/index.js";

/** Severity ordering for stable, useful sort (loudest first). */
const SEVERITY_RANK: Record<Severity, number> = {
  error: 0,
  warning: 1,
  info: 2,
};

/**
 * Run every rule over every skill and aggregate the findings into a {@link Report}.
 *
 * Design notes:
 * - **Total, never throws.** A rule that throws is caught and converted into an
 *   `error` finding tagged to that rule, so one buggy rule can't sink the run.
 * - **Stable order.** Findings are sorted by file path, then severity (loudest
 *   first), then rule id \u2014 deterministic output for tests and diffs.
 * - **Injectable rules.** Defaults to the registry but accepts an explicit set
 *   so tests can run a single rule in isolation.
 */
export function runEngine(
  skills: ParsedSkill[],
  rules: readonly Rule[] = defaultRules,
): Report {
  const ctx = createContext();
  const findings: Finding[] = [];

  for (const skill of skills) {
    for (const rule of rules) {
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
 * Build the per-run rule context. In M3 `severityFor` simply honors the
 * finding's own chosen severity (or the rule default). Centralizing it here
 * means config-driven overrides (M-later) slot in without touching any rule.
 */
function createContext(): RuleContext {
  return {
    severityFor(rule: Rule, fallback?: Severity): Severity {
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

/** Deterministic ordering: path \u2192 severity (loudest first) \u2192 rule id \u2192 line. */
function compareFindings(a: Finding, b: Finding): number {
  if (a.path !== b.path) return a.path < b.path ? -1 : 1;
  if (a.severity !== b.severity) {
    return SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
  }
  if (a.ruleId !== b.ruleId) return a.ruleId < b.ruleId ? -1 : 1;
  return (a.line ?? 0) - (b.line ?? 0);
}

/** Count findings per severity, always returning all keys (zeroed). */
function tally(findings: Finding[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { error: 0, warning: 0, info: 0 };
  for (const f of findings) counts[f.severity]++;
  return counts;
}
