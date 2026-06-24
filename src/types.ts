/**
 * skill-sniffer 🐕👃 — shared types.
 *
 * M2 introduced the `ParsedSkill` shape (the output of discover + parse).
 * M3 adds the rule-engine vocabulary: `Severity`, `Finding`, `Rule`,
 * `RuleContext`, and `Report`. Later milestones (score, JSON) build on these.
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

/**
 * How loud a finding is. The engine never decides exit codes itself — it just
 * tags severity; later milestones (M6 score/gates) interpret these.
 *
 * - `error`   — a real footgun (leaked secret, missing required frontmatter).
 * - `warning` — smells off but may be intentional (overlong description).
 * - `info`    — a gentle nudge / observation.
 */
export type Severity = "error" | "warning" | "info";

/**
 * A single thing a rule smelled in a skill file — one "scent". Findings are the
 * atomic unit the report renders and the score consumes.
 */
export interface Finding {
  /** Id of the rule that produced this finding (e.g. `"frontmatter"`). */
  ruleId: string;
  /** How loud this particular finding is. May differ from the rule default. */
  severity: Severity;
  /** Human-readable, one-line description of the problem. */
  message: string;
  /** Absolute path to the skill file this finding belongs to. */
  path: string;
  /**
   * 1-based line number within the file, when known. Omitted for whole-file
   * findings (e.g. "frontmatter is missing entirely").
   */
  line?: number;
}

/**
 * Context handed to a rule's `run()`. Kept deliberately small for M3; future
 * milestones can extend it (config, severity overrides, token budget) without
 * touching every rule signature.
 */
export interface RuleContext {
  /**
   * Resolve a rule's effective severity for a finding, honoring future config
   * overrides. In M3 this simply returns the rule's default, but routing every
   * finding through it means severity tuning later needs zero rule changes.
   */
  severityFor(rule: Rule, fallback?: Severity): Severity;
}

/**
 * A lint rule. Adding one is the whole extensibility story: implement this,
 * register it in `rules/index.ts`, done.
 *
 * `run()` must be pure and total — it never throws and never touches the
 * network or disk beyond what's already on the `ParsedSkill`.
 */
export interface Rule {
  /** Stable, kebab-or-word id used in reports and (later) config. */
  id: string;
  /** One-line description of what the rule checks, for `explain`/docs. */
  description: string;
  /** Severity used when the rule doesn't pick a more specific one per finding. */
  defaultSeverity: Severity;
  /** Inspect a parsed skill and return zero or more findings. */
  run(skill: ParsedSkill, ctx: RuleContext): Finding[];
}

/**
 * Aggregated result of running the engine over a set of skills: the flat list
 * of findings plus cheap roll-up counts. The pretty/JSON reporters render this.
 */
export interface Report {
  /** Every finding across every skill, in a stable order. */
  findings: Finding[];
  /** How many skill files were inspected (including ones with no findings). */
  skillsChecked: number;
  /** Severity tallies across all findings. */
  counts: Record<Severity, number>;
}
