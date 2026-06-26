/**
 * Shared text-scanning helpers for content rules (secrets, injection, …).
 *
 * Frontmatter-aware rules read `skill.frontmatter`; content rules instead scan
 * the *raw* file text so reported line/column numbers line up with what the
 * author sees in their editor. (The parsed `body` has the frontmatter block
 * stripped, which would shift every line number — so we deliberately scan
 * `raw`, not `body`.)
 *
 * Nothing here touches disk or the network; it's pure string work.
 */

/** A 1-based position within a file, derived from a character offset. */
export interface Position {
  /** 1-based line number. */
  line: number;
  /** 1-based column number. */
  column: number;
}

/** One regex hit, with the matched text and its resolved position. */
export interface Match extends Position {
  /** The exact substring that matched. */
  text: string;
  /** Absolute character offset of the match start within the scanned text. */
  index: number;
}

/**
 * Convert a character offset into a 1-based {@link Position}.
 *
 * Counts newlines before `offset` for the line, and the distance back to the
 * previous newline for the column. `\r\n` is handled naturally: the `\n` is the
 * line terminator and a trailing `\r` just nudges the column, which is fine for
 * human-facing locations.
 */
export function offsetToPosition(text: string, offset: number): Position {
  const clamped = Math.max(0, Math.min(offset, text.length));
  let line = 1;
  let lastNewline = -1;
  for (let i = 0; i < clamped; i++) {
    if (text.charCodeAt(i) === 10 /* \n */) {
      line++;
      lastNewline = i;
    }
  }
  return { line, column: clamped - lastNewline };
}

/**
 * Find every match of `pattern` in `text`, resolving each to a line/column.
 *
 * The pattern is used with a fresh global+ multiline copy so callers don't have
 * to manage `lastIndex` or worry about a missing `g` flag. Zero-width matches
 * (e.g. lookarounds) are guarded against infinite loops. When `group` is given,
 * the reported position points at that capture group rather than match start —
 * handy for "flag the value, not the surrounding `KEY=`" cases.
 */
export function findMatches(
  text: string,
  pattern: RegExp,
  group?: number,
): Match[] {
  const re = ensureGlobal(pattern);
  const matches: Match[] = [];

  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const whole = m[0];
    // Decide what substring (and offset) to report.
    let reported = whole;
    let start = m.index;
    if (group !== undefined && m[group] !== undefined) {
      reported = m[group];
      const rel = whole.indexOf(reported);
      if (rel >= 0) start = m.index + rel;
    }

    const pos = offsetToPosition(text, start);
    matches.push({ text: reported, index: start, line: pos.line, column: pos.column });

    // Never let a zero-width match spin forever.
    if (m.index === re.lastIndex) re.lastIndex++;
  }

  return matches;
}

/** Return a global+multiline clone of a regex, preserving other flags. */
function ensureGlobal(pattern: RegExp): RegExp {
  let flags = pattern.flags;
  if (!flags.includes("g")) flags += "g";
  if (!flags.includes("m")) flags += "m";
  return new RegExp(pattern.source, flags);
}

/**
 * Redact a secret-ish string for display so the report never echoes the full
 * credential back into logs/CI output. Keeps a short recognizable prefix and a
 * couple trailing chars; masks the middle.
 */
export function redact(secret: string): string {
  const s = secret.trim();
  if (s.length <= 8) return "•".repeat(s.length);
  const head = s.slice(0, 4);
  const tail = s.slice(-2);
  return `${head}…${"•".repeat(Math.min(6, s.length - 6))}${tail}`;
}
