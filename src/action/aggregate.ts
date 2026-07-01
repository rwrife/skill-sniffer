/**
 * skill-sniffer 🐕👃 — aggregate per-file JSON reports for the Action (issue #9).
 *
 * The GitHub Action lints the *changed* skill files in a PR. The simplest,
 * most robust way to scope to those files is to invoke the existing CLI with
 * `--json` and feed it exactly the changed paths — but we also want to be able
 * to merge several `--json` payloads (e.g. if the runner shards them) into one
 * coherent report for a single sticky comment.
 *
 * This module owns that merge. It validates the loose JSON shape emitted by
 * {@link file:../report/json.ts} and folds one-or-more reports into a single
 * {@link AggregatedReport}: concatenated findings, summed counts, the union of
 * per-file scores, and an overall score that is the *minimum* per-file score
 * (matching the CLI's "a kennel is only as good as its worst dog" rule).
 *
 * Pure and network-free, so it's unit-testable without GitHub or a real CLI.
 */

import type {
  Finding,
  Severity,
  SkillScore,
  ScoredReport,
} from "../types.js";

/** The JSON shape the CLI emits (see report/json.ts). Re-declared loosely here
 * because the runner parses untrusted stdout; we validate before trusting it. */
export interface RawJsonReport {
  schema: string;
  version: string;
  score: number;
  skillsChecked: number;
  counts: Record<Severity, number>;
  scores: SkillScore[];
  findings: Finding[];
}

/**
 * A merged report plus the `version` stamp the comment footer needs. Overall
 * `score` follows the CLI rule (min across files); an empty kennel scores 100.
 */
export interface AggregatedReport extends ScoredReport {
  /** skill-sniffer version, copied from the first report that carried one. */
  version: string;
}

const SCHEMA_PREFIX = "skill-sniffer/report@";

/** Empty severity tally. */
function zeroCounts(): Record<Severity, number> {
  return { error: 0, warning: 0, info: 0 };
}

/**
 * Narrow unknown parsed JSON to a {@link RawJsonReport}, throwing a clear error
 * on anything that doesn't match. We only assert the fields we consume; extra
 * keys are ignored so a newer minor schema still parses.
 */
export function parseRawReport(value: unknown): RawJsonReport {
  if (typeof value !== "object" || value === null) {
    throw new Error("report is not a JSON object");
  }
  const v = value as Record<string, unknown>;
  if (typeof v.schema !== "string" || !v.schema.startsWith(SCHEMA_PREFIX)) {
    throw new Error(
      `unexpected report schema: ${JSON.stringify(v.schema)} (want ${SCHEMA_PREFIX}*)`,
    );
  }
  if (!Array.isArray(v.findings) || !Array.isArray(v.scores)) {
    throw new Error("report is missing findings/scores arrays");
  }
  return value as RawJsonReport;
}

/**
 * Merge one-or-more raw reports into a single {@link AggregatedReport}.
 *
 * - `findings` are concatenated in input order.
 * - `counts` are summed per severity.
 * - `scores` are unioned by path; if the same path appears twice (shouldn't,
 *   but be defensive) the lower score wins.
 * - `skillsChecked` is the number of distinct scored files.
 * - overall `score` is the minimum per-file score, or 100 when there are none.
 */
export function aggregateReports(reports: RawJsonReport[]): AggregatedReport {
  const counts = zeroCounts();
  const findings: Finding[] = [];
  const scoreByPath = new Map<string, SkillScore>();
  let version = "0.0.0";

  for (const r of reports) {
    if (r.version) version = r.version;
    findings.push(...r.findings);
    for (const sev of ["error", "warning", "info"] as Severity[]) {
      counts[sev] += r.counts?.[sev] ?? 0;
    }
    for (const s of r.scores) {
      const prev = scoreByPath.get(s.path);
      if (!prev || s.score < prev.score) scoreByPath.set(s.path, s);
    }
  }

  const scores = [...scoreByPath.values()];
  const score = scores.length === 0
    ? 100
    : scores.reduce((min, s) => Math.min(min, s.score), 100);

  return {
    version,
    score,
    skillsChecked: scores.length,
    counts,
    scores,
    findings,
  };
}
