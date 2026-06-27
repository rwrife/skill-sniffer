import type { Finding, ScoredReport } from "../types.js";

/**
 * skill-sniffer 🐕👃 — machine-readable JSON report (`--json`).
 *
 * Emits a stable, schema-versioned object that CI and tooling can parse without
 * scraping the pretty terminal output. Like the other reporters, this returns a
 * string (newline-terminated) rather than writing it, so the CLI and tests
 * share one code path. No colors, no personality — just data.
 *
 * Shape (v1):
 * ```json
 * {
 *   "schema": "skill-sniffer/report@1",
 *   "version": "0.1.0",
 *   "score": 100,
 *   "skillsChecked": 3,
 *   "counts": { "error": 0, "warning": 0, "info": 0 },
 *   "scores": [{ "path": "...", "score": 100, "counts": {...} }],
 *   "findings": [{ "ruleId": "...", "severity": "...", "message": "...",
 *                  "path": "...", "line": 1, "column": 1 }]
 * }
 * ```
 */

/** Stable identifier for the JSON report shape; bump on breaking changes. */
export const REPORT_SCHEMA = "skill-sniffer/report@1";

/**
 * Render a {@link ScoredReport} as a JSON string.
 *
 * @param report  the scored report to serialize.
 * @param version the skill-sniffer version to stamp into the payload.
 * @param pretty  when true (default), pretty-print with 2-space indent;
 *                pass false for compact single-line output.
 */
export function renderJson(
  report: ScoredReport,
  version: string,
  pretty = true,
): string {
  const payload = {
    schema: REPORT_SCHEMA,
    version,
    score: report.score,
    skillsChecked: report.skillsChecked,
    counts: report.counts,
    scores: report.scores.map((s) => ({
      path: s.path,
      score: s.score,
      counts: s.counts,
    })),
    findings: report.findings.map(serializeFinding),
  };

  return JSON.stringify(payload, null, pretty ? 2 : 0) + "\n";
}

/**
 * Normalize a {@link Finding} for JSON output: always emit the core fields, and
 * only include `line`/`column` when present (keeps whole-file findings clean).
 */
function serializeFinding(f: Finding): Record<string, unknown> {
  const out: Record<string, unknown> = {
    ruleId: f.ruleId,
    severity: f.severity,
    message: f.message,
    path: f.path,
  };
  if (f.line !== undefined) out.line = f.line;
  if (f.column !== undefined) out.column = f.column;
  return out;
}
