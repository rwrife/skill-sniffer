import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Finding, ScoredReport, Severity } from "./types.js";

/**
 * skill-sniffer 🐕👃 — baseline + drift detection (issue #32).
 *
 * The scariest supply-chain vector for skills isn't a *new* bad file — it's a
 * benign `SKILL.md` that quietly mutates after you've already trusted it (the
 * 2026 "semantic supply-chain" pattern: adversaries change only natural-language
 * content while leaving structure intact). skill-sniffer is a static linter, so
 * it's perfectly placed to answer the one question CI actually cares about:
 * *"Did any skill get more dangerous since we last blessed it?"*
 *
 * A **baseline** freezes a known-good state so CI fails only on **regressions**,
 * not on pre-existing, already-accepted findings. This module owns two things:
 *
 *  1. **Capture** — {@link buildBaseline} turns a {@link ScoredReport} into a
 *     stable, deterministic snapshot (per file: Good Boy Score, a content hash,
 *     and a fingerprint set of its findings). {@link writeBaseline} persists it.
 *  2. **Diff** — {@link diffBaseline} compares a fresh report against a loaded
 *     baseline and classifies every finding as *baselined* (accepted debt,
 *     downgraded to `info`), *new* (real severity, gates CI), or *fixed*
 *     (present in baseline, gone now). It also flags **content drift** (a file
 *     whose hash moved) and per-file **score drops**.
 *
 * Everything is pure + offline: no network, no new deps (`crypto` is built-in).
 */

/** Schema id for the on-disk baseline; bump on breaking format changes. */
export const BASELINE_SCHEMA = "skill-sniffer/baseline@1";

/** Default filename a baseline is written to / read from. */
export const DEFAULT_BASELINE_FILE = ".skillsniffer-baseline.json";

/**
 * A single finding boiled down to a stable identity, independent of incidental
 * ordering. Two findings are "the same" when their `ruleId`, `severity`,
 * normalized `message`, and `line` match. Column is intentionally excluded:
 * it's noisy and rarely meaningful for identity.
 */
export interface FindingFingerprint {
  ruleId: string;
  severity: Severity;
  /** Normalized (trimmed, whitespace-collapsed) finding message. */
  message: string;
  /** 1-based line, or 0 for whole-file findings (kept stable/serializable). */
  line: number;
}

/** Per-file entry recorded in a baseline snapshot. */
export interface BaselineFile {
  /** Good Boy Score™ for this file at baseline time (0–100). */
  score: number;
  /** sha256 of the file's raw contents at baseline time. */
  hash: string;
  /** Sorted fingerprint set of the file's findings at baseline time. */
  findings: FindingFingerprint[];
}

/** The full, serializable baseline snapshot. */
export interface Baseline {
  schema: string;
  /** skill-sniffer version that wrote the baseline (diagnostics only). */
  version: string;
  /** ISO timestamp the baseline was captured (diagnostics only). */
  createdAt: string;
  /** Per-file entries keyed by path, always emitted in sorted-key order. */
  files: Record<string, BaselineFile>;
}

/**
 * The raw content of each checked file, keyed by path — needed to compute
 * content hashes for drift detection. The engine only sees `ParsedSkill`, so
 * callers pass a `path → raw` map alongside the report.
 */
export type RawContents = Record<string, string>;

/** sha256 hex of a string. */
export function hashContent(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

/** Normalize a finding message so trivial rewording/whitespace doesn't churn. */
function normalizeMessage(message: string): string {
  return message.trim().replace(/\s+/g, " ");
}

/** Turn a {@link Finding} into its stable {@link FindingFingerprint}. */
export function fingerprint(f: Finding): FindingFingerprint {
  return {
    ruleId: f.ruleId,
    severity: f.severity,
    message: normalizeMessage(f.message),
    line: f.line ?? 0,
  };
}

/** A stable, order-independent key for a fingerprint (for set membership). */
export function fingerprintKey(fp: FindingFingerprint): string {
  return `${fp.ruleId}\u0000${fp.severity}\u0000${fp.line}\u0000${fp.message}`;
}

/** Deterministic sort for fingerprints: ruleId → line → severity → message. */
function compareFingerprints(a: FindingFingerprint, b: FindingFingerprint): number {
  if (a.ruleId !== b.ruleId) return a.ruleId < b.ruleId ? -1 : 1;
  if (a.line !== b.line) return a.line - b.line;
  if (a.severity !== b.severity) return a.severity < b.severity ? -1 : 1;
  if (a.message !== b.message) return a.message < b.message ? -1 : 1;
  return 0;
}

/**
 * Build a {@link Baseline} snapshot from a scored report + the raw contents of
 * each checked file.
 *
 * Deterministic by construction: per-file findings are fingerprinted and sorted,
 * and files are emitted in sorted-key order by {@link writeBaseline}. A file
 * present in `raws` but absent from the report's scores (a clean file) is still
 * recorded — a clean file is a real, blessable state.
 */
export function buildBaseline(
  report: ScoredReport,
  raws: RawContents,
  version: string,
  now: Date = new Date(),
): Baseline {
  const findingsByPath = new Map<string, Finding[]>();
  for (const f of report.findings) {
    const bucket = findingsByPath.get(f.path);
    if (bucket) bucket.push(f);
    else findingsByPath.set(f.path, [f]);
  }

  // Score lookup so clean files (no findings) still record their real score.
  const scoreByPath = new Map(report.scores.map((s) => [s.path, s.score]));

  const files: Record<string, BaselineFile> = {};
  // Union of every path we know about: scored files + anything with raw content.
  const paths = new Set<string>([
    ...report.scores.map((s) => s.path),
    ...Object.keys(raws),
  ]);

  for (const path of paths) {
    const findings = findingsByPath.get(path) ?? [];
    const raw = raws[path] ?? "";
    files[path] = {
      score: scoreByPath.get(path) ?? 100,
      hash: hashContent(raw),
      findings: findings.map(fingerprint).sort(compareFingerprints),
    };
  }

  return {
    schema: BASELINE_SCHEMA,
    version,
    createdAt: now.toISOString(),
    files,
  };
}

/** Serialize a baseline to a stable, pretty-printed JSON string (sorted keys). */
export function serializeBaseline(baseline: Baseline): string {
  const sortedFiles: Record<string, BaselineFile> = {};
  for (const path of Object.keys(baseline.files).sort()) {
    sortedFiles[path] = baseline.files[path];
  }
  const ordered = {
    schema: baseline.schema,
    version: baseline.version,
    createdAt: baseline.createdAt,
    files: sortedFiles,
  };
  return JSON.stringify(ordered, null, 2) + "\n";
}

/** Persist a baseline to disk (pretty, deterministic). */
export function writeBaseline(path: string, baseline: Baseline): void {
  writeFileSync(path, serializeBaseline(baseline), "utf8");
}

/** Raised when a baseline file is missing or malformed. */
export class BaselineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BaselineError";
  }
}

/**
 * Load + validate a baseline from disk. Throws {@link BaselineError} for a
 * missing file or malformed content so the CLI can turn it into a clean usage
 * message rather than a stack trace.
 */
export function loadBaseline(path: string): Baseline {
  if (!existsSync(path)) {
    throw new BaselineError(
      `baseline file not found: ${path} — run \`skill-sniffer baseline <path>\` to create one`,
    );
  }
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new BaselineError(
      `failed to read baseline ${path}: ${(err as Error).message}`,
    );
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new BaselineError(
      `failed to parse baseline ${path}: ${(err as Error).message}`,
    );
  }
  if (
    data === null ||
    typeof data !== "object" ||
    Array.isArray(data) ||
    typeof (data as Baseline).files !== "object" ||
    (data as Baseline).files === null
  ) {
    throw new BaselineError(
      `baseline ${path} is malformed: expected an object with a "files" map`,
    );
  }
  return data as Baseline;
}

/** How the baseline diff classifies each file's content vs the snapshot. */
export type DriftKind = "unchanged" | "drifted" | "new-file" | "removed";

/** Per-file result of a baseline diff. */
export interface BaselineFileDiff {
  path: string;
  /** Findings present now AND in the baseline (accepted debt → info). */
  baselined: FindingFingerprint[];
  /** Findings present now but NOT in the baseline (gate CI). */
  newFindings: FindingFingerprint[];
  /** Findings in the baseline but gone now (informational). */
  fixed: FindingFingerprint[];
  /** Content drift classification for this file. */
  drift: DriftKind;
  /** Baseline score for this file, or `undefined` for a new file. */
  baselineScore?: number;
  /** Current score for this file. */
  currentScore: number;
  /** `currentScore - baselineScore` (negative = regression). */
  scoreDelta: number;
}

/** Aggregate result of diffing a report against a baseline. */
export interface BaselineDiff {
  perFile: BaselineFileDiff[];
  /** Total new findings across all files (what `--max-new-findings` gates). */
  totalNew: number;
  /** Total baselined (accepted-debt) findings across all files. */
  totalBaselined: number;
  /** Total fixed findings across all files. */
  totalFixed: number;
  /** Files whose content hash moved since baseline. */
  totalDrifted: number;
  /** The worst (most negative) per-file score delta; 0 when no drops. */
  worstScoreDrop: number;
}

/**
 * Diff a fresh scored report (plus raw contents) against a loaded baseline.
 *
 * For each file we compare its current fingerprint set to the baseline's:\n * - **baselined** — in both → accepted debt (caller downgrades to `info`).
 * - **new**       — only now → real regression (gates CI).
 * - **fixed**     — only baseline → resolved (informational).
 *
 * Content drift is computed from the sha256 hash: a moved hash on a known file
 * is `drifted`; a file with no baseline entry is `new-file`; a baseline file no
 * longer present is `removed` (reported once, no findings).
 */
export function diffBaseline(
  report: ScoredReport,
  raws: RawContents,
  baseline: Baseline,
): BaselineDiff {
  const findingsByPath = new Map<string, Finding[]>();
  for (const f of report.findings) {
    const bucket = findingsByPath.get(f.path);
    if (bucket) bucket.push(f);
    else findingsByPath.set(f.path, [f]);
  }
  const scoreByPath = new Map(report.scores.map((s) => [s.path, s.score]));

  const perFile: BaselineFileDiff[] = [];
  let totalNew = 0;
  let totalBaselined = 0;
  let totalFixed = 0;
  let totalDrifted = 0;
  let worstScoreDrop = 0;

  // Current files: everything scored, unioned with anything having raw content.
  const currentPaths = new Set<string>([
    ...report.scores.map((s) => s.path),
    ...Object.keys(raws),
  ]);

  for (const path of currentPaths) {
    const baseEntry = baseline.files[path];
    const currentFindings = findingsByPath.get(path) ?? [];
    const currentFps = currentFindings.map(fingerprint);
    const currentScore = scoreByPath.get(path) ?? 100;

    const baseKeys = new Set(
      (baseEntry?.findings ?? []).map(fingerprintKey),
    );
    const currentKeys = new Set(currentFps.map(fingerprintKey));

    const baselined: FindingFingerprint[] = [];
    const newFindings: FindingFingerprint[] = [];
    for (const fp of currentFps) {
      if (baseKeys.has(fingerprintKey(fp))) baselined.push(fp);
      else newFindings.push(fp);
    }
    const fixed = (baseEntry?.findings ?? []).filter(
      (fp) => !currentKeys.has(fingerprintKey(fp)),
    );

    // Content drift classification.
    let drift: DriftKind;
    if (!baseEntry) {
      drift = "new-file";
    } else {
      const currentHash = hashContent(raws[path] ?? "");
      drift = currentHash === baseEntry.hash ? "unchanged" : "drifted";
    }
    if (drift === "drifted") totalDrifted++;

    const baselineScore = baseEntry?.score;
    const scoreDelta =
      baselineScore === undefined ? 0 : currentScore - baselineScore;
    if (scoreDelta < worstScoreDrop) worstScoreDrop = scoreDelta;

    totalNew += newFindings.length;
    totalBaselined += baselined.length;
    totalFixed += fixed.length;

    perFile.push({
      path,
      baselined,
      newFindings,
      fixed,
      drift,
      baselineScore,
      currentScore,
      scoreDelta,
    });
  }

  // Baseline files that no longer exist in the current set → "removed".
  for (const path of Object.keys(baseline.files)) {
    if (currentPaths.has(path)) continue;
    const baseEntry = baseline.files[path];
    perFile.push({
      path,
      baselined: [],
      newFindings: [],
      fixed: baseEntry.findings.slice(),
      drift: "removed",
      baselineScore: baseEntry.score,
      currentScore: baseEntry.score,
      scoreDelta: 0,
    });
    totalFixed += baseEntry.findings.length;
  }

  perFile.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  return {
    perFile,
    totalNew,
    totalBaselined,
    totalFixed,
    totalDrifted,
    worstScoreDrop,
  };
}

/**
 * Apply a baseline diff to a scored report's findings: findings that are
 * "baselined" (accepted debt) are downgraded to `info`, so they no longer gate
 * on their original severity, while genuinely-new findings keep their real
 * severity. Returns a NEW findings array + recomputed severity counts; the
 * caller re-scores if it needs the score to reflect downgrades (it does not —
 * scores are computed pre-downgrade for honest drift signals).
 *
 * The downgrade only touches severity; the message is prefixed with a
 * `[baselined]` tag so reports make the acceptance visible.
 */
export function applyBaselineToFindings(
  findings: readonly Finding[],
  diff: BaselineDiff,
): { findings: Finding[]; counts: Record<Severity, number> } {
  // Build a per-path set of baselined fingerprint keys for O(1) lookup.
  const baselinedByPath = new Map<string, Set<string>>();
  for (const fd of diff.perFile) {
    if (fd.baselined.length === 0) continue;
    baselinedByPath.set(
      fd.path,
      new Set(fd.baselined.map(fingerprintKey)),
    );
  }

  const out: Finding[] = findings.map((f) => {
    const keys = baselinedByPath.get(f.path);
    if (keys && keys.has(fingerprintKey(fingerprint(f)))) {
      return {
        ...f,
        severity: "info" as Severity,
        message: `[baselined] ${f.message}`,
      };
    }
    return f;
  });

  const counts: Record<Severity, number> = { error: 0, warning: 0, info: 0 };
  for (const f of out) counts[f.severity]++;

  return { findings: out, counts };
}

/**
 * A compact, serializable summary of the baseline diff for the `--json` report's
 * `baseline` section. Mirrors the acceptance criteria: `new`, `fixed`,
 * `baselined`, `drifted`, `scoreDelta`.
 */
export interface BaselineJsonSection {
  new: number;
  fixed: number;
  baselined: number;
  drifted: number;
  /** Worst per-file score delta (most negative). */
  scoreDelta: number;
  files: Array<{
    path: string;
    drift: DriftKind;
    new: number;
    fixed: number;
    baselined: number;
    scoreDelta: number;
  }>;
}

/** Project a {@link BaselineDiff} into its JSON-report section. */
export function baselineJsonSection(diff: BaselineDiff): BaselineJsonSection {
  return {
    new: diff.totalNew,
    fixed: diff.totalFixed,
    baselined: diff.totalBaselined,
    drifted: diff.totalDrifted,
    scoreDelta: diff.worstScoreDrop,
    files: diff.perFile.map((f) => ({
      path: f.path,
      drift: f.drift,
      new: f.newFindings.length,
      fixed: f.fixed.length,
      baselined: f.baselined.length,
      scoreDelta: f.scoreDelta,
    })),
  };
}
