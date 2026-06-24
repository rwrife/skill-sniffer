import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import matter from "gray-matter";
import type { ParsedSkill } from "./types.js";

/**
 * gray-matter exposes a module-level `clearCache()` at runtime, but its bundled
 * type declarations omit it. We narrow to just the shape we use instead of
 * reaching for `any`.
 */
const clearMatterCache: () => void =
  (matter as unknown as { clearCache?: () => void }).clearCache ?? (() => {});

/**
 * Read a single skill file and parse its frontmatter + body.
 *
 * This never throws. Failures (missing file, unreadable, malformed YAML) are
 * captured on `ParsedSkill.error` so the caller can keep going and a later
 * rule can report them. The `path` is normalized to an absolute path.
 *
 * - Missing / unreadable file → `raw: ""`, `body: ""`, `frontmatter: {}`, `error` set.
 * - Empty file → `raw: ""`, `body: ""`, `frontmatter: {}`, no error.
 * - Malformed YAML frontmatter → `frontmatter: {}`, `body` falls back to the
 *   raw contents, `error` set with the YAML message.
 */
export async function parseSkill(filePath: string): Promise<ParsedSkill> {
  const abs = resolve(filePath);

  let raw: string;
  try {
    raw = await readFile(abs, "utf8");
  } catch (err) {
    return {
      path: abs,
      frontmatter: {},
      body: "",
      raw: "",
      error: `could not read file: ${(err as Error).message}`,
    };
  }

  try {
    // gray-matter memoizes by content in a module-level cache. A parse that
    // throws can poison that cache so a later parse of the *same* content
    // silently returns empty data instead of throwing. Clearing the cache
    // first makes malformed-YAML detection deterministic across calls.
    clearMatterCache();
    const parsed = matter(raw);
    const frontmatter = isPlainObject(parsed.data) ? parsed.data : {};
    return {
      path: abs,
      frontmatter: frontmatter as Record<string, unknown>,
      body: parsed.content,
      raw,
    };
  } catch (err) {
    // Malformed YAML (or any gray-matter failure): keep the raw text usable
    // as the body so token/secret/injection rules can still scan it.
    return {
      path: abs,
      frontmatter: {},
      body: raw,
      raw,
      error: `malformed frontmatter: ${(err as Error).message}`,
    };
  }
}

/**
 * Parse many skill files concurrently, preserving input order. Like
 * {@link parseSkill}, individual failures are captured per-file, so a single
 * bad file never rejects the whole batch.
 */
export async function parseSkills(filePaths: string[]): Promise<ParsedSkill[]> {
  return Promise.all(filePaths.map((p) => parseSkill(p)));
}

/** True for real object literals (not arrays, not null). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" && value !== null && !Array.isArray(value)
  );
}
