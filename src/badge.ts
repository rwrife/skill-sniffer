/**
 * skill-sniffer 🐕👃 — the Good Boy Score™ badge (issue #38, PLAN §8.12).
 *
 * Emits a shields.io *endpoint* badge payload so a repo can advertise its skill
 * hygiene in a README. The shape is exactly what
 * `https://img.shields.io/endpoint?url=<raw-json-url>` expects:
 *
 *   { "schemaVersion": 1, "label": "good boy score", "message": "92/100", "color": "green" }
 *
 * No new scoring logic lives here — the score comes straight from `score.ts`.
 * This module only maps a 0–100 score onto shields' label/message/color.
 */

/** Fixed shields endpoint schema version (they only define `1`). */
export const SHIELDS_SCHEMA_VERSION = 1 as const;

/** Default badge label; overridable via `--label`. */
export const DEFAULT_BADGE_LABEL = "good boy score";

/**
 * A shields.io endpoint badge payload. Only the fields we set are modeled;
 * shields ignores unknown keys and fills its own defaults for omitted ones.
 */
export interface ShieldsEndpoint {
  /** Always {@link SHIELDS_SCHEMA_VERSION}; shields rejects other values. */
  schemaVersion: typeof SHIELDS_SCHEMA_VERSION;
  /** Left-hand text (e.g. "good boy score"). */
  label: string;
  /** Right-hand text; the score rendered as `"<n>/100"`. */
  message: string;
  /** A shields named color mapped from the score by {@link colorForScore}. */
  color: string;
}

/**
 * Map a 0–100 Good Boy Score™ onto a shields named color.
 *
 * Thresholds (inclusive, high → low), per issue #38:
 *   >=90 brightgreen · >=75 green · >=50 yellow · >=25 orange · else red.
 *
 * The score is clamped defensively so an out-of-range value still colors
 * sensibly rather than falling through to red on a >100 input.
 */
export function colorForScore(score: number): string {
  const s = clampScore(score);
  if (s >= 90) return "brightgreen";
  if (s >= 75) return "green";
  if (s >= 50) return "yellow";
  if (s >= 25) return "orange";
  return "red";
}

/**
 * Build the shields endpoint payload for a given overall score.
 *
 * `score` is the overall Good Boy Score™ (typically `ScoredReport.score`, the
 * minimum per-file score). `label` overrides the default badge text.
 */
export function buildBadge(
  score: number,
  label: string = DEFAULT_BADGE_LABEL,
): ShieldsEndpoint {
  const s = clampScore(score);
  return {
    schemaVersion: SHIELDS_SCHEMA_VERSION,
    label,
    message: `${s}/100`,
    color: colorForScore(s),
  };
}

/** Serialize a badge payload to pretty JSON with a trailing newline. */
export function renderBadgeJson(badge: ShieldsEndpoint): string {
  return `${JSON.stringify(badge, null, 2)}\n`;
}

/** Clamp a score into [0, 100] and round to an integer for display. */
function clampScore(n: number): number {
  if (!Number.isFinite(n)) return 0;
  const r = Math.round(n);
  if (r < 0) return 0;
  if (r > 100) return 100;
  return r;
}
