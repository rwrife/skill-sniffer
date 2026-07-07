import pc from "picocolors";
import type { ParsedSkill } from "./types.js";
import { estimateTokens, DEFAULT_TOKEN_BUDGET } from "./rules/token-bloat.js";

/**
 * skill-sniffer 🐕👃 — token-weight leaderboard (`skill-sniffer rank`).
 *
 * A skill's full text is injected into an agent's context every time it loads,
 * so its size is a direct, recurring tax on every turn. The `token-bloat` rule
 * *warns* when a single file crosses a budget; `rank` takes the complementary
 * view — it sorts every discovered file **heaviest-first** so you can see, at a
 * glance, which ones are eating the most context and where to trim first.
 *
 * This is a report, not a linter: it never inspects findings, never gates, and
 * always exits `0` on success. It reuses the exact same chars/4 estimate as
 * `token-bloat` (via {@link estimateTokens}) so the two views can never drift.
 *
 * Everything here is pure — {@link computeRanking} returns data and the render
 * helpers return strings — so the CLI action and unit tests share one code
 * path, the same convention `explain.ts` / `fix.ts` follow. Offline by design;
 * no tokenizer, no network.
 */

/** Stable identifier for the JSON ranking shape; bump on breaking changes. */
export const RANK_SCHEMA = "skill-sniffer/rank@1";

/** One file's entry in the leaderboard. */
export interface RankEntry {
  /** Absolute path to the file this entry ranks. */
  path: string;
  /** Estimated token weight (chars/4 heuristic over the raw file text). */
  tokens: number;
}

/**
 * A computed ranking: the heaviest-first entries plus cheap roll-ups the report
 * and JSON both render. `budget` is echoed back so consumers know which ceiling
 * `overBudget` was measured against.
 */
export interface Ranking {
  /** Every ranked file, heaviest-first (ties broken by path for stability). */
  entries: RankEntry[];
  /** Total estimated tokens across every ranked file. */
  total: number;
  /** Mean tokens per file (integer, floored), or 0 when there are no files. */
  average: number;
  /** The budget entries were measured against (for the over-budget flag). */
  budget: number;
  /** How many entries are strictly over {@link budget}. */
  overBudgetCount: number;
}

/** Options controlling how a ranking is computed. */
export interface RankOptions {
  /**
   * Only keep the heaviest `top` entries. `undefined` (or a non-positive
   * value) keeps them all. Applied *after* sorting, so the total/average still
   * reflect every discovered file — capping the list never lies about the sum.
   */
  top?: number;
  /**
   * Budget to compare each file against for the over-budget flag. Defaults to
   * the same {@link DEFAULT_TOKEN_BUDGET} `token-bloat` uses, so `rank` and the
   * lint agree on what "too heavy" means.
   */
  budget?: number;
}

/**
 * Compute the token-weight ranking for a set of parsed skills.
 *
 * Pure and total: it reads only each skill's `raw` text and returns data. The
 * entries are sorted by estimated tokens descending; ties fall back to path so
 * the order is deterministic (important for stable snapshots and CI diffs).
 *
 * `total` and `average` are computed over **all** input files, then the list is
 * truncated to `top` — so `--top 3` shows three rows but the summary still
 * reflects the whole kennel.
 */
export function computeRanking(
  skills: readonly ParsedSkill[],
  options: RankOptions = {},
): Ranking {
  const budget = options.budget ?? DEFAULT_TOKEN_BUDGET;

  const all: RankEntry[] = skills.map((s) => ({
    path: s.path,
    tokens: estimateTokens(s.raw),
  }));

  all.sort(
    (a, b) => b.tokens - a.tokens || a.path.localeCompare(b.path),
  );

  const total = all.reduce((sum, e) => sum + e.tokens, 0);
  const average = all.length > 0 ? Math.floor(total / all.length) : 0;
  const overBudgetCount = all.filter((e) => e.tokens > budget).length;

  const top = options.top;
  const entries =
    top !== undefined && top > 0 ? all.slice(0, top) : all;

  return { entries, total, average, budget, overBudgetCount };
}

/**
 * Render the ranking as a pretty terminal leaderboard: a right-aligned token
 * column, each path, an over-budget flag (💩) on files past the budget, and a
 * one-line summary (file count, total, average, heaviest). Paths are shown
 * relative to `cwd` when possible so the list stays readable.
 *
 * When `entries` were truncated by `--top`, a dim note reports how many rows
 * are hidden so the summary's file count still makes sense.
 */
export function renderRankingText(
  ranking: Ranking,
  options: { cwd?: string; totalFiles?: number } = {},
): string {
  const cwd = options.cwd ?? process.cwd();
  const totalFiles = options.totalFiles ?? ranking.entries.length;

  if (totalFiles === 0) {
    return `${pc.yellow("nothing to rank")} 🐕💨 (no agent-context files found)\n`;
  }

  const lines: string[] = [];

  // Width of the token column is the widest "~<n>" among shown entries.
  const tokenWidth = Math.max(
    ...ranking.entries.map((e) => `~${e.tokens}`.length),
  );

  for (const entry of ranking.entries) {
    const weight = `~${entry.tokens}`.padStart(tokenWidth);
    const over = entry.tokens > ranking.budget;
    const flag = over ? ` ${pc.red("💩 over budget")}` : "";
    const weightColored = over ? pc.red(weight) : pc.bold(weight);
    lines.push(`  ${weightColored}  ${relativize(entry.path, cwd)}${flag}`);
  }

  const hidden = totalFiles - ranking.entries.length;
  if (hidden > 0) {
    lines.push(pc.dim(`  … and ${hidden} more (use no --top to see all)`));
  }

  const heaviest = ranking.entries[0];
  const summaryParts = [
    `${totalFiles} file(s)`,
    `~${ranking.total} tokens total`,
    `~${ranking.average} avg`,
  ];
  if (ranking.overBudgetCount > 0) {
    summaryParts.push(
      pc.red(`${ranking.overBudgetCount} over the ${ranking.budget} budget`),
    );
  }
  lines.push("");
  lines.push(
    `${summaryParts.join(pc.dim(", "))}. ` +
      `${pc.dim("Heaviest:")} ${relativize(heaviest.path, cwd)}`,
  );

  return lines.join("\n") + "\n";
}

/**
 * Render the ranking as a stable, schema-versioned JSON string for machines/CI.
 * No colors, no relativization — absolute paths and raw numbers only, mirroring
 * the `--json` report convention.
 *
 * Shape (v1):
 * ```json
 * {
 *   "schema": "skill-sniffer/rank@1",
 *   "version": "0.1.0",
 *   "budget": 2000,
 *   "total": 7364,
 *   "average": 2455,
 *   "overBudgetCount": 1,
 *   "filesRanked": 3,
 *   "entries": [{ "path": "...", "tokens": 5212 }]
 * }
 * ```
 */
export function renderRankingJson(
  ranking: Ranking,
  version: string,
  options: { totalFiles?: number; pretty?: boolean } = {},
): string {
  const pretty = options.pretty ?? true;
  const filesRanked = options.totalFiles ?? ranking.entries.length;
  const payload = {
    schema: RANK_SCHEMA,
    version,
    budget: ranking.budget,
    total: ranking.total,
    average: ranking.average,
    overBudgetCount: ranking.overBudgetCount,
    filesRanked,
    entries: ranking.entries.map((e) => ({ path: e.path, tokens: e.tokens })),
  };
  return JSON.stringify(payload, null, pretty ? 2 : 0) + "\n";
}

/**
 * Make a path relative to `cwd` for display when it's inside it; otherwise
 * return it unchanged. Kept tiny and dependency-free — purely cosmetic, so it
 * never alters the underlying data (JSON always emits absolute paths).
 */
function relativize(absPath: string, cwd: string): string {
  const prefix = cwd.endsWith("/") ? cwd : `${cwd}/`;
  return absPath.startsWith(prefix) ? absPath.slice(prefix.length) : absPath;
}
