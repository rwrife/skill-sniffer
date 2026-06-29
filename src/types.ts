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
  /**
   * 1-based column number within {@link line}, when known. Only meaningful
   * alongside `line`; omitted for whole-file or line-only findings.
   */
  column?: number;
}

/**
 * Context handed to a rule's `run()`. Kept deliberately small; the engine builds
 * one per run and threads it through every rule. Config-driven severity
 * overrides (issue #8) are resolved here so no rule needs to know about config.
 */
export interface RuleContext {
  /**
   * Resolve a rule's effective severity for a finding.
   *
   * Precedence: a project config override for the rule's id (if any) wins;
   * otherwise the rule's own per-finding `fallback`; otherwise the rule's
   * `defaultSeverity`. Routing every finding through this means severity tuning
   * needs zero rule changes.
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

/**
 * The Good Boy Score™ for a single skill file: a 0–100 number derived from its
 * findings, plus the per-severity counts that produced it. 100 is a clean file
 * (a very good boy); 0 is the worst possible scent.
 */
export interface SkillScore {
  /** Absolute path to the skill file this score belongs to. */
  path: string;
  /** Good Boy Score™ for this file, integer 0–100 (100 = clean). */
  score: number;
  /** Severity tallies for just this file. */
  counts: Record<Severity, number>;
}

/**
 * A scored {@link Report}: the overall Good Boy Score™ plus a per-file
 * breakdown. The overall score is the *minimum* per-file score (a kennel is
 * only as good as its worst-behaved dog), so CI gates catch the weakest skill.
 * The JSON reporter serializes this; the pretty reporter shows the headline.
 */
export interface ScoredReport extends Report {
  /** Overall Good Boy Score™ (the minimum per-file score), integer 0–100. */
  score: number;
  /** Per-file scores, in the same stable path order as the findings. */
  scores: SkillScore[];
}
