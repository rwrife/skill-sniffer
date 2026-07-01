/**
 * skill-sniffer 🐕👃 — GitHub Action PR-comment rendering (issue #9).
 *
 * Pure helpers that turn an aggregated {@link ScoredReport} into the Markdown
 * body of a single *sticky* PR comment. "Sticky" means the action looks for a
 * hidden marker ({@link COMMENT_MARKER}) on an existing comment and edits it in
 * place rather than posting a fresh one each run — so a PR accumulates score
 * history in one tidy thread, not a wall of bot noise.
 *
 * Everything here is deterministic and network-free so it can be unit-tested
 * without GitHub. The thin runner in `dist/action-run.js` does the I/O (git
 * diff, CLI invocation, `gh api`) and calls into these functions.
 */

import type { Finding, Severity } from "../types.js";
import type { AggregatedReport } from "./aggregate.js";

/**
 * Hidden HTML marker stamped into every comment we post. The runner greps open
 * PR comments for this exact string to decide between "create" and "update".
 * Bump the suffix only if the comment contract changes in a way that should
 * orphan old comments (it normally shouldn't).
 */
export const COMMENT_MARKER = "<!-- skill-sniffer-report -->";

/** How many findings to surface in the comment before collapsing the rest. */
export const MAX_FINDINGS_SHOWN = 10;

/** Emoji for each severity, used in the findings table. */
const SEVERITY_EMOJI: Record<Severity, string> = {
  error: "🛑",
  warning: "⚠️",
  info: "💡",
};

/** Severity ordering for "top findings" — loudest first. */
const SEVERITY_RANK: Record<Severity, number> = {
  error: 0,
  warning: 1,
  info: 2,
};

/**
 * Inputs the comment renderer needs beyond the report itself. Kept explicit so
 * the markdown is a pure function of its arguments (great for snapshot tests).
 */
export interface CommentContext {
  /**
   * Effective `min-score` gate for this run, or `undefined` when no gate is
   * configured. Drives the pass/fail headline and the per-file ❌/✅ markers.
   */
  minScore?: number;
  /**
   * Repo root, used to render file paths relative to the repo rather than the
   * absolute runner paths the CLI emits. Trailing slash optional.
   */
  repoRoot?: string;
  /** Short commit SHA the report was produced for, shown in the footer. */
  sha?: string;
}

/** A wag/growl emoji for an overall score, mirroring the pretty reporter's vibe. */
function scoreMood(score: number): string {
  if (score >= 90) return "🐕 woof!";
  if (score >= 70) return "🐶 good boy";
  if (score >= 40) return "🐕‍🦺 needs a walk";
  return "🐺 growl";
}

/** Whether the overall run passes the (optional) min-score gate. */
export function passesGate(report: AggregatedReport, minScore?: number): boolean {
  // An error finding always fails, mirroring the CLI's own gate semantics, even
  // when no explicit min-score is set — a leaked key shouldn't pass silently.
  if (report.counts.error > 0) return false;
  if (minScore !== undefined && report.score < minScore) return false;
  return true;
}

/**
 * Render a path relative to {@link CommentContext.repoRoot} when possible, so
 * the comment shows `skills/foo/SKILL.md` instead of
 * `/home/runner/work/repo/repo/skills/foo/SKILL.md`. Falls back to the input.
 */
export function relativePath(absPath: string, repoRoot?: string): string {
  if (!repoRoot) return absPath;
  const root = repoRoot.endsWith("/") ? repoRoot : repoRoot + "/";
  return absPath.startsWith(root) ? absPath.slice(root.length) : absPath;
}

/**
 * Escape the handful of characters that would otherwise break a Markdown table
 * cell. We only touch pipes and newlines — backticks/asterisks in a finding
 * message are usually intentional and render fine inside a cell.
 */
function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/**
 * Build the per-file score table. Each row shows the file, its Good Boy Score™,
 * a pass/fail marker against `minScore` (when set), and its severity tallies.
 * Files are listed worst-score first so the problem children are up top.
 */
function renderScoreTable(report: AggregatedReport, ctx: CommentContext): string {
  const rows = [...report.scores]
    .sort((a, b) => a.score - b.score || a.path.localeCompare(b.path))
    .map((s) => {
      const file = relativePath(s.path, ctx.repoRoot);
      const ok = ctx.minScore === undefined
        ? s.counts.error > 0
          ? "❌"
          : "✅"
        : s.score >= ctx.minScore && s.counts.error === 0
          ? "✅"
          : "❌";
      const tallies = `${s.counts.error} / ${s.counts.warning} / ${s.counts.info}`;
      return `| ${ok} | \`${escapeCell(file)}\` | **${s.score}** | ${tallies} |`;
    });

  return [
    "| | File | Score | 🛑/⚠️/💡 |",
    "| - | ---- | ----- | ------- |",
    ...rows,
  ].join("\n");
}

/**
 * Build the "top findings" table — the loudest few scents across all files, so
 * a reviewer sees the worst problems without opening the CI log. Sorted by
 * severity then file/line; truncated to {@link MAX_FINDINGS_SHOWN} with a
 * trailing note when there are more.
 */
function renderFindingsTable(report: AggregatedReport, ctx: CommentContext): string {
  if (report.findings.length === 0) {
    return "_No findings — every sniffed file came back clean._ 🦴";
  }

  const sorted = [...report.findings].sort(
    (a: Finding, b: Finding) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      a.path.localeCompare(b.path) ||
      (a.line ?? 0) - (b.line ?? 0),
  );

  const shown = sorted.slice(0, MAX_FINDINGS_SHOWN);
  const rows = shown.map((f) => {
    const file = relativePath(f.path, ctx.repoRoot);
    const loc = f.line !== undefined ? `${file}:${f.line}` : file;
    return `| ${SEVERITY_EMOJI[f.severity]} | \`${f.ruleId}\` | \`${escapeCell(loc)}\` | ${escapeCell(f.message)} |`;
  });

  const table = [
    "| | Rule | Where | Scent |",
    "| - | ---- | ----- | ----- |",
    ...rows,
  ].join("\n");

  const hidden = sorted.length - shown.length;
  const more = hidden > 0
    ? `\n\n_…and ${hidden} more finding${hidden === 1 ? "" : "s"}. Run \`skill-sniffer\` locally or check the CI log for the full report._`
    : "";

  return table + more;
}

/**
 * Render the full sticky-comment body for an aggregated report.
 *
 * The body always begins with {@link COMMENT_MARKER} so the runner can find and
 * update it. The structure is: headline (pass/fail + overall score), a per-file
 * score table, the top findings, and a small footer.
 */
export function renderComment(
  report: AggregatedReport,
  ctx: CommentContext = {},
): string {
  const passed = passesGate(report, ctx.minScore);
  const gateNote = ctx.minScore !== undefined
    ? ` (min-score \`${ctx.minScore}\`)`
    : "";
  const headline = passed
    ? `### 🐕👃 skill-sniffer — passed${gateNote}`
    : `### 🐕👃 skill-sniffer — failed${gateNote}`;

  const summary =
    `**Good Boy Score™: ${report.score}/100** ${scoreMood(report.score)} · ` +
    `${report.skillsChecked} file${report.skillsChecked === 1 ? "" : "s"} sniffed · ` +
    `${report.counts.error} 🛑 ${report.counts.warning} ⚠️ ${report.counts.info} 💡`;

  const footer = ctx.sha
    ? `\n\n<sub>sniffed \`${ctx.sha}\` · skill-sniffer v${report.version}</sub>`
    : `\n\n<sub>skill-sniffer v${report.version}</sub>`;

  return [
    COMMENT_MARKER,
    headline,
    "",
    summary,
    "",
    renderScoreTable(report, ctx),
    "",
    "#### Top findings",
    "",
    renderFindingsTable(report, ctx),
    footer,
  ].join("\n");
}

/**
 * The comment body shown when a PR changed no skill files at all. Still stamped
 * with the marker so a prior failing comment gets replaced by this all-clear
 * (rather than leaving a stale red comment around once skills are reverted).
 */
export function renderNoSkillsComment(sha?: string): string {
  const footer = sha
    ? `\n\n<sub>checked \`${sha}\` · skill-sniffer</sub>`
    : "";
  return [
    COMMENT_MARKER,
    "### 🐕👃 skill-sniffer",
    "",
    "_No changed skill files in this PR — nothing to sniff._ 😴",
    footer,
  ].join("\n");
}
