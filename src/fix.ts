import { readFile, writeFile } from "node:fs/promises";
import matter from "gray-matter";
import { INVISIBLE_CHARS } from "./rules/injection.js";

/**
 * skill-sniffer 🐕👃 — `--fix` auto-cleanup (issue #7).
 *
 * Mechanically rewrites the *unambiguously safe* findings so authors don't have
 * to hand-fix boilerplate. The hard rule: `--fix` only ever touches things that
 * cannot change meaning. It strips invisible junk, tidies whitespace, and
 * reorders frontmatter keys — and it **never** rewrites prompt-injection intent
 * or redacts secrets. Those stay reported so a human decides.
 *
 * The whole module is pure string work plus one read + optional write per file.
 * {@link fixContent} is side-effect-free and idempotent (running it twice yields
 * the same text), which makes it trivial to test and safe to run in CI.
 *
 * Safe transforms, in the order they apply:
 *  1. **Strip invisible chars** — zero-width and bidi controls (the same set the
 *     injection rule flags). They render as nothing but still reach the model.
 *  2. **Reorder frontmatter** — hoist `name` then `description` to the top,
 *     preserving every key's original text/formatting (no YAML re-serialization,
 *     so quoting/comments/multiline blocks survive untouched).
 *  3. **Trim trailing whitespace** — drop trailing spaces/tabs on every line.
 *  4. **Collapse blank runs** — squeeze 3+ consecutive blank lines down to one
 *     and trim the file to a single trailing newline.
 */

/** The categories of safe rewrite `--fix` performs, for reporting. */
export type FixKind =
  | "invisible-chars"
  | "frontmatter-order"
  | "trailing-whitespace"
  | "blank-lines";

/** One applied (or previewed) change, with a count where it's meaningful. */
export interface FixChange {
  /** Which safe transform produced this change. */
  kind: FixKind;
  /** Human-readable, one-line summary for the report. */
  message: string;
  /** How many spots were affected (chars stripped, lines trimmed, …). */
  count: number;
}

/** Result of fixing a single file's contents (pure, no I/O). */
export interface FixContentResult {
  /** The rewritten text. Equal to the input when nothing was unsafe-free. */
  fixed: string;
  /** Whether {@link fixed} differs from the input. */
  changed: boolean;
  /** The individual safe changes applied, in transform order. */
  changes: FixChange[];
}

/** Per-file outcome of a {@link fixSkills} run (after read + optional write). */
export interface FixFileResult {
  /** Absolute path to the skill file. */
  path: string;
  /** Whether the file's contents would change (or did, when not a dry run). */
  changed: boolean;
  /** Whether the new contents were actually written to disk. */
  written: boolean;
  /** The safe changes applied to this file. */
  changes: FixChange[];
  /** Unified-diff preview (populated for `--dry-run`); empty otherwise. */
  diff: string;
  /** A read/parse error, if one occurred; the file is then left untouched. */
  error?: string;
}

/**
 * Apply every safe transform to a file's text. Pure and idempotent.
 *
 * Frontmatter reordering runs against the parsed matter block but re-emits the
 * *original* key lines (just reordered), so we never reformat valid YAML the
 * author wrote deliberately. Whitespace passes run over the body only when a
 * frontmatter block is present, so we don't disturb the delimiters' own lines.
 */
export function fixContent(raw: string): FixContentResult {
  const changes: FixChange[] = [];
  let text = raw;

  // 1. Strip invisible / bidi control characters anywhere in the file.
  const stripped = stripInvisible(text);
  if (stripped.count > 0) {
    text = stripped.text;
    changes.push({
      kind: "invisible-chars",
      message: `stripped ${stripped.count} invisible/bidi character${plural(stripped.count)}`,
      count: stripped.count,
    });
  }

  // 2. Reorder frontmatter keys (name, description, …rest).
  const reordered = reorderFrontmatter(text);
  if (reordered.count > 0) {
    text = reordered.text;
    changes.push({
      kind: "frontmatter-order",
      message: `reordered ${reordered.count} frontmatter key${plural(reordered.count)} (name, description first)`,
      count: reordered.count,
    });
  }

  // 3. Trim trailing whitespace on every line.
  const trimmed = trimTrailingWhitespace(text);
  if (trimmed.count > 0) {
    text = trimmed.text;
    changes.push({
      kind: "trailing-whitespace",
      message: `trimmed trailing whitespace on ${trimmed.count} line${plural(trimmed.count)}`,
      count: trimmed.count,
    });
  }

  // 4. Collapse redundant blank lines + normalize the trailing newline.
  const collapsed = collapseBlankLines(text);
  if (collapsed.count > 0) {
    text = collapsed.text;
    changes.push({
      kind: "blank-lines",
      message: `collapsed ${collapsed.count} redundant blank line${plural(collapsed.count)}`,
      count: collapsed.count,
    });
  }

  return { fixed: text, changed: text !== raw, changes };
}

/**
 * Fix many skill files. Reads each, computes the safe rewrite, and either writes
 * it back or (when `dryRun`) records a unified diff preview instead. Individual
 * read/write failures are captured per file so one bad file never aborts the
 * batch — mirroring how parsing degrades gracefully elsewhere.
 */
export async function fixSkills(
  paths: string[],
  opts: { dryRun?: boolean } = {},
): Promise<FixFileResult[]> {
  return Promise.all(paths.map((p) => fixOne(p, opts.dryRun ?? false)));
}

/** Fix a single file path (read → transform → write/preview). Never throws. */
async function fixOne(path: string, dryRun: boolean): Promise<FixFileResult> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    return {
      path,
      changed: false,
      written: false,
      changes: [],
      diff: "",
      error: `could not read file: ${(err as Error).message}`,
    };
  }

  const { fixed, changed, changes } = fixContent(raw);

  if (!changed) {
    return { path, changed: false, written: false, changes: [], diff: "" };
  }

  if (dryRun) {
    return {
      path,
      changed: true,
      written: false,
      changes,
      diff: unifiedDiff(path, raw, fixed),
    };
  }

  try {
    await writeFile(path, fixed, "utf8");
  } catch (err) {
    return {
      path,
      changed: true,
      written: false,
      changes,
      diff: "",
      error: `could not write file: ${(err as Error).message}`,
    };
  }

  return { path, changed: true, written: true, changes, diff: "" };
}

/** Remove every invisible/bidi control char the injection rule knows about. */
function stripInvisible(text: string): { text: string; count: number } {
  let count = 0;
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (INVISIBLE_CHARS[code] !== undefined) {
      count++;
      continue;
    }
    out += text[i];
  }
  return { text: out, count };
}

/**
 * Reorder top-level frontmatter keys so `name` comes first and `description`
 * second, leaving all other keys in their original relative order.
 *
 * Crucially this is *textual*: we split the raw matter block into per-key
 * chunks (a `key:` line plus any indented/continuation lines that follow it)
 * and reassemble them in the new order. Nothing is re-serialized through YAML,
 * so quoting style, inline comments, and block scalars are preserved verbatim.
 * Returns `count: 0` (and the input untouched) when there's no frontmatter, it
 * doesn't parse, or the keys are already in the desired order.
 */
function reorderFrontmatter(text: string): { text: string; count: number } {
  // Only act on a leading frontmatter block delimited by `---`.
  if (!/^---\r?\n/.test(text)) return { text, count: 0 };

  let parsed: matter.GrayMatterFile<string>;
  try {
    // Match parse.ts: clear the content cache so reorder is deterministic.
    (matter as unknown as { clearCache?: () => void }).clearCache?.();
    parsed = matter(text);
  } catch {
    // Malformed YAML: never touch it, just report-as-is upstream.
    return { text, count: 0 };
  }

  const block = parsed.matter; // raw text between the --- fences
  if (!block || block.trim().length === 0) return { text, count: 0 };

  const entries = splitTopLevelEntries(block);
  if (entries.length === 0) return { text, count: 0 };

  const priority = (key: string): number =>
    key === "name" ? 0 : key === "description" ? 1 : 2;

  // Stable sort by priority; equal-priority keys keep their original order.
  const ordered = entries
    .map((e, i) => ({ e, i }))
    .sort((a, b) => {
      const pa = priority(a.e.key);
      const pb = priority(b.e.key);
      return pa !== pb ? pa - pb : a.i - b.i;
    })
    .map((x) => x.e);

  // Count how many keys actually moved (for an honest report).
  let moved = 0;
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].key !== ordered[i].key) moved++;
  }
  if (moved === 0) return { text, count: 0 };

  const newBlock = ordered.map((e) => e.text).join("\n");

  // Rebuild the document: ---\n<block>\n---<rest>. We reconstruct the fences
  // from the original prefix so the surrounding newlines are preserved.
  const fenceMatch = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!fenceMatch) return { text, count: 0 };
  const after = text.slice(fenceMatch[0].length);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const rebuilt = `---${eol}${newBlock}${eol}---${after}`;

  return { text: rebuilt, count: moved };
}

/** A single top-level frontmatter key and its full (multi-line) source text. */
interface FrontmatterEntry {
  key: string;
  text: string;
}

/**
 * Split a frontmatter block into top-level key entries, keeping each key's
 * continuation lines (indented block/flow values, list items) attached to it.
 *
 * A "top-level key" line starts at column 0 and looks like `key:` (optionally
 * with a value after). Any following lines that are indented, blank, or list
 * items (`- …`) belong to the preceding key. Lines we can't classify abort the
 * split (return `[]`) so we conservatively leave unusual YAML alone.
 */
function splitTopLevelEntries(block: string): FrontmatterEntry[] {
  const lines = block.split("\n");
  const entries: FrontmatterEntry[] = [];
  let current: { key: string; lines: string[] } | null = null;

  const TOP_KEY = /^([A-Za-z0-9_$][A-Za-z0-9_$-]*)\s*:(?:\s|$)/;

  for (const line of lines) {
    const m = TOP_KEY.exec(line);
    if (m) {
      if (current) entries.push({ key: current.key, text: current.lines.join("\n") });
      current = { key: m[1], lines: [line] };
      continue;
    }

    // A blank line before the first key is just padding from the `---` fence;
    // skip it so the reorder isn't defeated by a leading newline in the block.
    if (current === null && line.trim().length === 0) continue;

    // Continuation: indented, blank, or a list item under the current key.
    const isContinuation = line.length === 0 || /^\s/.test(line) || /^-\s/.test(line);
    if (current && isContinuation) {
      current.lines.push(line);
      continue;
    }

    // Anything else (e.g. a bare scalar, document marker) → bail out safely.
    return [];
  }

  if (current) entries.push({ key: current.key, text: current.lines.join("\n") });
  return entries;
}

/** Strip trailing spaces/tabs from every line; report how many lines changed. */
function trimTrailingWhitespace(text: string): { text: string; count: number } {
  const lines = text.split("\n");
  let count = 0;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].replace(/[ \t]+$/, "");
    if (trimmed !== lines[i]) {
      lines[i] = trimmed;
      count++;
    }
  }
  return { text: lines.join("\n"), count };
}

/**
 * Collapse 3+ consecutive blank lines to a single blank line, and normalize the
 * file to exactly one trailing newline. Returns the number of blank lines
 * removed so the report can quantify the tidy-up.
 */
function collapseBlankLines(text: string): { text: string; count: number } {
  const before = countLines(text);

  // Squeeze runs of blank lines (3+) down to one blank line.
  let out = text.replace(/\n{3,}/g, "\n\n");

  // Normalize trailing newlines: strip them all, then add exactly one back —
  // but only if the file had any content (don't turn "" into "\n").
  out = out.replace(/\n+$/, "");
  if (out.length > 0) out += "\n";

  const removed = before - countLines(out);
  return { text: out, count: Math.max(0, removed) };
}

/** Count newline-delimited lines, treating the text as newline-separated. */
function countLines(text: string): number {
  if (text.length === 0) return 0;
  return text.split("\n").length;
}

/**
 * Build a minimal unified diff between two versions of a file for `--dry-run`.
 * This is a compact, dependency-free line diff (LCS) — enough to eyeball what
 * `--fix` would do without pulling in a diffing library. Invisible chars in
 * removed lines are made visible as `<U+XXXX>` so they don't vanish in the diff.
 */
export function unifiedDiff(path: string, before: string, after: string): string {
  const a = before.split("\n");
  const b = after.split("\n");
  const lcs = lcsMatrix(a, b);

  const out: string[] = [`--- ${path}`, `+++ ${path} (fixed)`];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push(` ${visible(a[i])}`);
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push(`-${visible(a[i])}`);
      i++;
    } else {
      out.push(`+${visible(b[j])}`);
      j++;
    }
  }
  while (i < a.length) out.push(`-${visible(a[i++])}`);
  while (j < b.length) out.push(`+${visible(b[j++])}`);

  return out.join("\n");
}

/** Longest-common-subsequence length matrix for two line arrays. */
function lcsMatrix(a: string[], b: string[]): number[][] {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  return dp;
}

/** Render invisible chars as `<U+XXXX>` so diffs of stripped junk are legible. */
function visible(line: string): string {
  let out = "";
  for (let i = 0; i < line.length; i++) {
    const code = line.charCodeAt(i);
    if (INVISIBLE_CHARS[code] !== undefined) {
      out += `<U+${code.toString(16).toUpperCase().padStart(4, "0")}>`;
    } else {
      out += line[i];
    }
  }
  return out;
}

/** `""` for 1, `"s"` otherwise — tiny pluralization helper for messages. */
function plural(n: number): string {
  return n === 1 ? "" : "s";
}
