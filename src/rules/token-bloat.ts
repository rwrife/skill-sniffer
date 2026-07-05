import type { Finding, ParsedSkill, Rule, RuleContext } from "../types.js";

/**
 * Default token budget. A skill's full text is injected verbatim into an
 * agent's context, so its size is a direct, recurring tax on every turn that
 * loads it. 2000 tokens (~8 KB of text) is a generous ceiling for a single
 * hand-authored skill; past it you're almost certainly better off splitting or
 * trimming. M-later config can tune this per project.
 */
export const DEFAULT_TOKEN_BUDGET = 2000;

/**
 * Characters-per-token heuristic. Real tokenizers (BPE) average ~3.5–4 chars
 * per token for English prose; we use 4 deliberately so the estimate is a
 * conservative *lower* bound on token count (i.e. we don't over-warn). This is
 * the same chars/4 rule of thumb the PLAN calls for — no tokenizer dependency,
 * no network, instant.
 */
const CHARS_PER_TOKEN = 4;

/**
 * Estimate the token weight of a chunk of text via the chars/4 heuristic.
 * Whitespace is counted (it costs tokens too), so we measure the raw length.
 * Exported so a future `rank` command / score can reuse the same math.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Token-bloat rule.
 *
 * Estimates how many tokens a skill file will cost when loaded into context
 * (chars/4 heuristic over the *raw* file text) and warns when that exceeds the
 * budget. This is a `warning`, not an `error`: a heavy skill is a smell, not a
 * footgun — sometimes a skill genuinely needs the words. The finding is
 * whole-file (no line/column); the cost is the whole document, not one spot.
 *
 * The budget is overridable via {@link makeTokenBloatRule} so tests (and later
 * config) can exercise a smaller ceiling without a 8 KB fixture.
 */
export function makeTokenBloatRule(budget = DEFAULT_TOKEN_BUDGET): Rule {
  return {
    id: "token-bloat",
    description:
      "Warn when a skill's estimated token weight (chars/4) exceeds the budget.",
    defaultSeverity: "warning",
    rationale:
      "A skill's full text is injected into the agent's context every time it " +
      "loads, so its size is a direct, recurring cost on every turn — not a " +
      "one-off. Past a few thousand tokens you're usually better off splitting " +
      "the skill or trimming boilerplate. It's a warning, not an error: " +
      "sometimes a skill genuinely needs the words.",
    example: {
      lang: "markdown",
      bad: "# giant skill\n<8 KB of prose, changelog, and copy-pasted docs…>",
      good:
        "# focused skill\nOne tight page of instructions; link out to long " +
        "reference docs instead of inlining them.",
    },

    run(skill: ParsedSkill, ctx: RuleContext): Finding[] {
      if (!skill.raw) return [];

      const tokens = estimateTokens(skill.raw);
      if (tokens <= budget) return [];

      return [
        {
          ruleId: "token-bloat",
          severity: ctx.severityFor(this, "warning"),
          message:
            `skill is ~${tokens} tokens (over the ${budget} budget); ` +
            `trim it to save context on every load`,
          path: skill.path,
        },
      ];
    },
  };
}

/** The default-budget token-bloat rule registered in the engine. */
export const tokenBloatRule: Rule = makeTokenBloatRule();
