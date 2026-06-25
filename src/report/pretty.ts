import pc from "picocolors";
import type { Finding, Report, Severity } from "../types.js";

/**
 * Render a {@link Report} as a human-friendly terminal string, grouped by file
 * with severity-colored lines and the sniffer-dog personality. Returns the
 * string (rather than writing it) so the CLI and tests share one code path.
 *
 * Clean files get a wag \ud83d\udc15; files with scents get their findings listed under
 * the path. A final summary line tallies the run.
 */
export function renderPretty(report: Report): string {
  const lines: string[] = [];
  const byFile = groupByPath(report.findings);

  if (byFile.size === 0) {
    lines.push(
      pc.green(
        `\ud83d\udc15 good boy \u2014 ${report.skillsChecked} skill(s) sniffed, no scents found.`,
      ),
    );
    return lines.join("\n") + "\n";
  }

  for (const [path, findings] of byFile) {
    lines.push(pc.underline(path));
    for (const f of findings) {
      lines.push(`  ${formatFinding(f)}`);
    }
    lines.push("");
  }

  lines.push(summaryLine(report));
  return lines.join("\n") + "\n";
}

/** Format one finding: colored severity badge, message, and rule id. */
function formatFinding(f: Finding): string {
  const loc = f.line
    ? pc.dim(`:${f.line}${f.column ? `:${f.column}` : ""}`)
    : "";
  return `${badge(f.severity)}${loc} ${f.message} ${pc.dim(`(${f.ruleId})`)}`;
}

/** Colored, fixed-width severity badge with a matching emoji scent. */
function badge(severity: Severity): string {
  switch (severity) {
    case "error":
      return pc.red("\u2717 error  \ud83d\udc15\ud83d\udc45"); // growl
    case "warning":
      return pc.yellow("\u26a0 warning"); // sniff
    case "info":
      return pc.blue("\u2139 info   ");
  }
}

/** Final tally line summarizing the whole run. */
function summaryLine(report: Report): string {
  const { error, warning, info } = report.counts;
  const parts: string[] = [];
  if (error) parts.push(pc.red(`${error} error${plural(error)}`));
  if (warning) parts.push(pc.yellow(`${warning} warning${plural(warning)}`));
  if (info) parts.push(pc.blue(`${info} info`));

  const detail = parts.length > 0 ? parts.join(", ") : "no findings";
  const mood = error
    ? pc.red("\ud83d\udc15\ud83d\udc45 growl")
    : warning
      ? pc.yellow("\ud83d\udc15 hmm")
      : pc.green("\ud83d\udc15 wag");

  return pc.cyan(
    `${report.skillsChecked} skill(s) sniffed \u2014 ${detail}. ${mood}`,
  );
}

/**
 * Group findings by their file path, preserving the engine's already-sorted
 * order. Returns a Map so insertion order (path order) is stable.
 */
function groupByPath(findings: Finding[]): Map<string, Finding[]> {
  const map = new Map<string, Finding[]>();
  for (const f of findings) {
    const bucket = map.get(f.path);
    if (bucket) bucket.push(f);
    else map.set(f.path, [f]);
  }
  return map;
}

function plural(n: number): string {
  return n === 1 ? "" : "s";
}
