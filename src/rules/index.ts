import type { Rule } from "../types.js";
import { frontmatterRule } from "./frontmatter.js";

/**
 * The rule registry \u2014 the single source of truth for which rules run.
 *
 * Adding a rule is a two-line change: import it and list it here. Order is the
 * order findings are produced within a file, so keep the highest-signal rules
 * first. M3 ships exactly one rule; M4/M5 append secrets, injection, token,
 * broken-path, and tool-scope rules.
 */
export const rules: readonly Rule[] = [frontmatterRule];

/** Look up a single rule by id (handy for an `explain <rule-id>` command later). */
export function getRule(id: string): Rule | undefined {
  return rules.find((r) => r.id === id);
}

export { frontmatterRule };
