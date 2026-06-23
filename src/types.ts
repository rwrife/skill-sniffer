/**
 * skill-sniffer 🐕👃 — shared types.
 *
 * M2 introduces the `ParsedSkill` shape (the output of discover + parse).
 * Later milestones extend this file with `Finding`, `Rule`, `Severity`,
 * and `Report` as the rule engine comes online.
 */

/**
 * A skill file that has been located on disk and parsed into frontmatter +
 * body. This is the unit every rule will eventually run over.
 */
export interface ParsedSkill {
  /** Absolute path to the skill file on disk. */
  path: string;
  /** Parsed YAML frontmatter. `{}` when there is none. */
  frontmatter: Record<string, unknown>;
  /** Markdown body with the frontmatter block stripped. */
  body: string;
  /** The original, untouched file contents (frontmatter + body). */
  raw: string;
  /**
   * Non-fatal problem encountered while parsing (e.g. malformed YAML or an
   * unreadable file). When set, `frontmatter` falls back to `{}` and `body`
   * to the raw contents so downstream code never has to special-case nulls.
   */
  error?: string;
}
