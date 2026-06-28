import type {
  Finding,
  Report,
  ScoredReport,
  Severity,
  SkillScore,
} from "./types.js";

/**
 * skill-sniffer 🐕👃 — the Good Boy Score™.
 *
 * Turns a {@link Report} into a 0–100 score per file and overall. The model is
 * deliberately simple and explainable: start every file at a perfect 100 and
 * deduct a fixed penalty per finding, weighted by severity. Errors bite hard,
 * warnings nip, info is a gentle boop. The result is clamped to [0, 100] and
 * rounded to an integer so it reads like a grade.
 *
 * The *overall* score is the minimum across files — a kennel is only as good as
 * its worst-behaved dog — so a single nasty skill can't hide behind clean ones
 * in CI gates (`--min-score`).
 */

/** Points deducted from a file's score per finding, by severity. */
export const PENALTIES: Record<Severity, number> = {
  error: 25,
  warning: 8,
  info: 2,
};

/** The best possible score: a clean file with no scents. */
export const MAX_SCORE = 100;

/**
 * Score a single file's findings into a 0–100 Good Boy Score™.
 *
 * Pure and total: with no findings it returns {@link MAX_SCORE}; each finding
 * subtracts its severity penalty; the result is clamped and rounded.
 */
export function scoreFindings(findings: readonly Finding[]): number {
  let score = MAX_SCORE;
  for (const f of findings) {
    score -= PENALTIES[f.severity];
  }
  return clamp(Math.round(score));
}

/**
 * Attach Good Boy Scores™ to a {@link Report}: one per file plus an overall.
 *
 * - **Per-file** scores cover every skill that was checked, *including clean
 *   ones* (which score 100), so the JSON report and any future leaderboard see
 *   the whole set rather than only files with findings.
 * - **Overall** is the minimum per-file score, or {@link MAX_SCORE} when no
 *   skills were checked at all (vacuously a good boy — nothing smelled off).
 *
 * Per-file order follows the report's already-sorted findings (path order),
 * with any clean files appended deterministically by path.
 */
export function scoreReport(
  report: Report,
  checkedPaths: readonly string[] = [],
): ScoredReport {
  const byPath = groupFindingsByPath(report.findings);

  // Seed the path set from findings first (preserves engine sort order), then
  // fold in any explicitly-checked paths so clean files are represented too.
  const orderedPaths: string[] = [...byPath.keys()];
  const seen = new Set(orderedPaths);
  for (const p of [...checkedPaths].sort()) {
    if (!seen.has(p)) {
      seen.add(p);
      orderedPaths.push(p);
    }
  }

  const scores: SkillScore[] = orderedPaths.map((path) => {
    const findings = byPath.get(path) ?? [];
    return {
      path,
      score: scoreFindings(findings),
      counts: tally(findings),
    };
  });

  const overall = scores.length
    ? Math.min(...scores.map((s) => s.score))
    : MAX_SCORE;

  return { ...report, score: overall, scores };
}

/** Clamp a number into the valid score range [0, MAX_SCORE]. */
function clamp(n: number): number {
  if (n < 0) return 0;
  if (n > MAX_SCORE) return MAX_SCORE;
  return n;
}

/** Group findings by file path (insertion order preserved). */
function groupFindingsByPath(
  findings: readonly Finding[],
): Map<string, Finding[]> {
  const map = new Map<string, Finding[]>();
  for (const f of findings) {
    const bucket = map.get(f.path);
    if (bucket) bucket.push(f);
    else map.set(f.path, [f]);
  }
  return map;
}

/** Count findings per severity, always returning all keys (zeroed). */
function tally(findings: readonly Finding[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { error: 0, warning: 0, info: 0 };
  for (const f of findings) counts[f.severity]++;
  return counts;
}
