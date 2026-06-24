import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import fg from "fast-glob";

/**
 * Glob patterns that identify a skill file. Anthropic-style `SKILL.md`
 * (any depth) plus the `*.skill.md` convention used by some toolchains.
 */
export const SKILL_GLOBS = ["**/SKILL.md", "**/*.skill.md"] as const;

/** Directories we never want to descend into during discovery. */
const IGNORE = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/build/**",
] as const;

/**
 * Discover skill files from one or more input paths.
 *
 * Each input may be:
 * - a **file** — included directly if it looks like a skill file
 *   (`SKILL.md` or `*.skill.md`), otherwise ignored;
 * - a **directory** — recursively globbed for {@link SKILL_GLOBS};
 * - a **glob string** — passed through to fast-glob as-is.
 *
 * Returns a de-duplicated, sorted list of absolute paths. Missing inputs are
 * skipped silently (no throw) so the CLI degrades gracefully.
 */
export async function discoverSkills(inputs: string[]): Promise<string[]> {
  const found = new Set<string>();

  for (const input of inputs) {
    const matches = await discoverOne(input);
    for (const m of matches) found.add(m);
  }

  return [...found].sort();
}

async function discoverOne(input: string): Promise<string[]> {
  // A glob-looking input is handed straight to fast-glob.
  if (isGlob(input)) {
    return globAbsolute(input);
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
      SKILL_GLOBS.map((g) => `${stripTrailingSlash(input)}/${g}`),
    );
  }

  // A plain file: include it only if it matches the skill naming convention.
  if (info.isFile() && looksLikeSkillFile(input)) {
    return [resolve(input)];
  }

  return [];
}

async function globAbsolute(
  patterns: string | readonly string[],
): Promise<string[]> {
  return fg(patterns as string | string[], {
    absolute: true,
    dot: false,
    onlyFiles: true,
    ignore: [...IGNORE],
    caseSensitiveMatch: false,
    suppressErrors: true,
  });
}

/**
 * True if a filename matches the skill naming convention — `SKILL.md` (with
 * any directory prefix, or bare) or `*.skill.md`. Case-insensitive.
 */
export function looksLikeSkillFile(filePath: string): boolean {
  const lower = filePath.toLowerCase().replace(/\\/g, "/");
  const base = lower.slice(lower.lastIndexOf("/") + 1);
  return base === "skill.md" || base.endsWith(".skill.md");
}

/** Cheap heuristic for glob metacharacters. */
function isGlob(input: string): boolean {
  return /[*?{}[\]()!]/.test(input);
}

function stripTrailingSlash(p: string): string {
  return p.replace(/\/+$/, "");
}
