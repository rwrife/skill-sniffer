import pc from "picocolors";
import type { Rule, Severity } from "./types.js";
import { rules, getRule } from "./rules/index.js";

/**
 * `explain` \u2014 turn a cryptic rule id into terminal docs.
 *
 * When skill-sniffer growls it prints a terse finding plus a rule id (e.g.
 * `token-bloat`). This module powers `skill-sniffer explain <rule-id>`: the
 * "ESLint docs, but offline in your terminal" experience. It renders a single
 * rule's id, default severity, one-line description, longer rationale, and an
 * optional colorized bad \u2192 good example \u2014 or, with no id, lists every
 * registered rule for discoverability.
 *
 * Everything here is pure: it returns a `{ text, exitCode }` result rather than
 * writing to stdout, so the CLI action and unit tests share one code path (the
 * same convention `run.ts` / `fix.ts` follow).
 */

/** Outcome of an `explain` invocation: what to print and how to exit. */
export interface ExplainResult {
  /** Fully-rendered, colorized text ready to write to stdout/stderr. */
  text: string;
  /**
   * Intended process exit code. `0` for a successful explain/list; non-zero
   * (`2`, a usage error) when an unknown rule id was requested.
   */
  exitCode: number;
  /** Where the text should go \u2014 `stderr` for the unknown-id error. */
  stream: "stdout" | "stderr";
}

/** Color a severity token to match its loudness (mirrors the pretty reporter). */
function colorSeverity(severity: Severity): string {
  switch (severity) {
    case "error":
      return pc.red(severity);
    case "warning":
      return pc.yellow(severity);
    default:
      return pc.blue(severity);
  }
}

/**
 * Render the full explanation for a single rule: a titled block with severity,
 * description, rationale (falling back to the description when none is set), and
 * a colorized bad/good example when present. Degrades cleanly \u2014 a rule with
 * only `id + description` still produces a useful block.
 */
export function renderRule(rule: Rule): string {
  const lines: string[] = [];

  lines.push(`${pc.bold(rule.id)}  ${pc.dim("[")}${colorSeverity(rule.defaultSeverity)}${pc.dim("]")}`);
  lines.push(rule.description);

  // Rationale is the teaching payload; fall back to the one-liner so the block
  // is never empty for a rule that hasn't been given richer docs yet.
  const rationale = rule.rationale ?? rule.description;
  lines.push("");
  lines.push(pc.bold("Why this rule exists"));
  lines.push(wrap(rationale));

  if (rule.example) {
    lines.push("");
    lines.push(pc.bold("Example"));
    const langHint = rule.example.lang ? pc.dim(` (${rule.example.lang})`) : "";
    lines.push(`${pc.red("\u2717 bad")}${langHint}`);
    lines.push(indent(rule.example.bad, pc.red));
    lines.push(`${pc.green("\u2713 good")}${langHint}`);
    lines.push(indent(rule.example.good, pc.green));
  }

  return lines.join("\n");
}

/**
 * Render the discovery listing: every registered rule id with its one-line
 * description and default severity, aligned into a column. Shown by
 * `explain` with no argument (or `--list`).
 */
export function renderList(): string {
  const idWidth = Math.max(...rules.map((r) => r.id.length));
  const sevWidth = Math.max(...rules.map((r) => r.defaultSeverity.length));
  const lines: string[] = [];
  lines.push(pc.bold(`skill-sniffer rules (${rules.length})`));
  lines.push(pc.dim("run `skill-sniffer explain <rule-id>` for the full write-up"));
  lines.push("");
  for (const r of rules) {
    const id = pc.bold(r.id.padEnd(idWidth));
    // Pad the *plain* severity first, then color it — padding a string that
    // already contains ANSI escapes would misalign the column.
    const sev = colorSeverity(r.defaultSeverity as Severity);
    const sevCol = sev + " ".repeat(sevWidth - r.defaultSeverity.length);
    lines.push(`  ${id}  ${sevCol}  ${r.description}`);
  }
  return lines.join("\n");
}

/**
 * Render the "unknown rule id" error: a red headline plus the list of valid
 * ids so the user can self-correct. Goes to stderr with a non-zero exit.
 */
export function renderUnknown(id: string): string {
  const valid = rules.map((r) => r.id).join(", ");
  return (
    `${pc.red("error:")} unknown rule id ${pc.bold(id)}\n` +
    `${pc.dim("valid rule ids:")} ${valid}\n` +
    `${pc.dim("tip:")} run \`skill-sniffer explain\` to see them all with descriptions`
  );
}

/**
 * The `explain` entry point. With no `id` (or a falsy one) it lists all rules;
 * with a known id it renders that rule; with an unknown id it returns the error
 * block and a non-zero exit code. Kept side-effect-free for testability.
 */
export function explain(id?: string): ExplainResult {
  if (!id) {
    return { text: renderList() + "\n", exitCode: 0, stream: "stdout" };
  }

  const rule = getRule(id);
  if (!rule) {
    return { text: renderUnknown(id) + "\n", exitCode: 2, stream: "stderr" };
  }

  return { text: renderRule(rule) + "\n", exitCode: 0, stream: "stdout" };
}

/** Indent every line of a snippet by two spaces and apply a color function. */
function indent(text: string, color: (s: string) => string): string {
  return text
    .split("\n")
    .map((line) => `  ${color(line)}`)
    .join("\n");
}

/**
 * Soft-wrap prose to a comfortable terminal width (~80 cols) on word
 * boundaries. Keeps rationale readable without depending on a wrapping lib;
 * respects existing newlines in the source text.
 */
function wrap(text: string, width = 80): string {
  return text
    .split("\n")
    .map((paragraph) => wrapLine(paragraph, width))
    .join("\n");
}

/** Greedy word-wrap for a single logical line. */
function wrapLine(line: string, width: number): string {
  const words = line.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let current = "";
  for (const word of words) {
    if (current.length === 0) {
      current = word;
    } else if (current.length + 1 + word.length <= width) {
      current += ` ${word}`;
    } else {
      out.push(current);
      current = word;
    }
  }
  if (current.length > 0) out.push(current);
  return out.join("\n");
}
