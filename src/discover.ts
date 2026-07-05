import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import fg from "fast-glob";
import type { SkillFormat } from "./types.js";
import {
  ALL_FORMATS,
  FORMAT_GLOBS,
  classifyFormat,
  isKnownFormat,
  resolveFormats,
} from "./format.js";

/**
 * Glob patterns that identify the native skill format. Anthropic-style
 * `SKILL.md` (any depth) plus the `*.skill.md` convention used by some
 * toolchains. Kept exported for back-compatibility; the full multi-format set
 * lives in {@link FORMAT_GLOBS}.
 */
export const SKILL_GLOBS = FORMAT_GLOBS.skill;

/** Directories we never want to descend into during discovery. */
const IGNORE = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/build/**",
] as const;

/**
 * Format selection for discovery. `--include` narrows to the named formats;
 * `--exclude` removes them. With neither, every known format is scanned.
 */
export interface DiscoverOptions {
  /** Only scan these formats (canonical ids or aliases). Empty ⇒ all. */
  include?: readonly string[];
  /** Never scan these formats (canonical ids or aliases). */
  exclude?: readonly string[];
}

/**
 * Discover agent-context files from one or more input paths.
 *
 * Each input may be:
 * - a **file** — included directly if it matches a known agent-context format
 *   (`SKILL.md`, `AGENTS.md`, `CLAUDE.md`, `.cursorrules`, MCP manifest, …) and
 *   that format is in the selected set; otherwise ignored;
 * - a **directory** — recursively globbed for every selected format;
 * - a **glob string** — passed through to fast-glob as-is (format filtering is
 *   still applied to the results, so an explicit glob can't smuggle in an
 *   excluded format).
 *
 * Returns a de-duplicated, sorted list of absolute paths. Missing inputs are
 * skipped silently (no throw) so the CLI degrades gracefully.
 *
 * The default (no options) scans **all** formats. Since the native skill format
 * is always among them, the historical skills-only callers keep working; the
 * broadened default is the point of issue #10 (multi-format support).
 */
export async function discoverSkills(
  inputs: string[],
  options: DiscoverOptions = {},
): Promise<string[]> {
  const formats = resolveFormats(options);
  const formatSet = new Set<SkillFormat>(formats);
  const globs = globsForFormats(formats);

  const found = new Set<string>();
  for (const input of inputs) {
    const matches = await discoverOne(input, globs, formatSet);
    for (const m of matches) found.add(m);
  }

  return [...found].sort();
}

/** Collect the discovery globs for a set of formats (de-duplicated). */
function globsForFormats(
  formats: readonly Exclude<SkillFormat, "unknown">[],
): string[] {
  const out = new Set<string>();
  for (const fmt of formats) {
    for (const g of FORMAT_GLOBS[fmt]) out.add(g);
  }
  return [...out];
}

async function discoverOne(
  input: string,
  globs: readonly string[],
  formatSet: ReadonlySet<SkillFormat>,
): Promise<string[]> {
  // A glob-looking input is handed straight to fast-glob, but its results are
  // still filtered to the selected formats so `--exclude` is always honored.
  if (isGlob(input)) {
    const matches = await globAbsolute(input);
    return matches.filter((p) => formatSet.has(classifyFormat(p)));
  }

  let info;
  try {
    info = await stat(input);
  } catch {
    // Missing path: nothing to discover, but don't crash the run.
    return [];
  }

  if (info.isDirectory()) {
    return globAbsolute(
      globs.map((g) => `${stripTrailingSlash(input)}/${g}`),
    );
  }

  // A plain file: include it only if it matches a known, selected format.
  if (info.isFile() && isKnownFormat(input) && formatSet.has(classifyFormat(input))) {
    return [resolve(input)];
  }

  return [];
}

async function globAbsolute(
  patterns: string | readonly string[],
): Promise<string[]> {
  return fg(patterns as string | string[], {
    absolute: true,
    dot: true,
    onlyFiles: true,
    ignore: [...IGNORE],
    caseSensitiveMatch: false,
    suppressErrors: true,
  });
}

/**
 * True if a filename matches the native skill naming convention — `SKILL.md`
 * (with any directory prefix, or bare) or `*.skill.md`. Case-insensitive.
 * Retained for back-compatibility; prefer {@link isKnownFormat} for the full
 * multi-format check.
 */
export function looksLikeSkillFile(filePath: string): boolean {
  return classifyFormat(filePath) === "skill";
}

/**
 * Intersect a set of discovered (absolute) skill paths with a set of changed
 * (absolute) paths, preserving discovery order. Used by `--since <ref>` (issue
 * #23): discovery still applies the normal glob + `--include`/`--exclude`
 * format filters, and this narrows the result to only the files git reports as
 * changed — so an unchanged or excluded-format file is never linted.
 *
 * Both sides are compared as resolved absolute paths, so callers must resolve
 * git's repo-relative output first. Returns a de-duplicated list in the same
 * order `discovered` was given.
 */
export function intersectChanged(
  discovered: readonly string[],
  changedAbsolute: readonly string[],
): string[] {
  const changedSet = new Set(changedAbsolute.map((p) => resolve(p)));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of discovered) {
    const abs = resolve(p);
    if (changedSet.has(abs) && !seen.has(abs)) {
      seen.add(abs);
      out.push(p);
    }
  }
  return out;
}

/** Cheap heuristic for glob metacharacters. */
function isGlob(input: string): boolean {
  return /[*?{}[\]()!]/.test(input);
}

function stripTrailingSlash(p: string): string {
  return p.replace(/\/+$/, "");
}

export { ALL_FORMATS };
