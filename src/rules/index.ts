import type { Rule } from "../types.js";
import { frontmatterRule } from "./frontmatter.js";
import { secretsRule } from "./secrets.js";
import { injectionRule } from "./injection.js";
import { toolScopeRule } from "./tool-scope.js";
import { brokenPathsRule } from "./broken-paths.js";
import { tokenBloatRule } from "./token-bloat.js";

/**
 * The rule registry \u2014 the single source of truth for which rules run.
 *
 * Adding a rule is a two-line change: import it and list it here. Order is the
 * order findings are produced within a file, so keep the highest-signal rules
 * first. M4 appended the secrets + injection rules (the headline scents); M5
 * rounds out the v0.1 ruleset with tool-scope, broken-paths, and token-bloat.
 */
export const rules: readonly Rule[] = [
  frontmatterRule,
  secretsRule,
  injectionRule,
  toolScopeRule,
  brokenPathsRule,
  tokenBloatRule,
];

/** Look up a single rule by id (handy for an `explain <rule-id>` command later). */
export function getRule(id: string): Rule | undefined {
  return rules.find((r) => r.id === id);
}

export {
  frontmatterRule,
  secretsRule,
  injectionRule,
  toolScopeRule,
  brokenPathsRule,
  tokenBloatRule,
};
