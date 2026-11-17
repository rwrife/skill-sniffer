import { relative } from "node:path";
import type { CompatibilityReport } from "../compat.js";

export function renderCompatibilityJson(report: CompatibilityReport): string {
  return JSON.stringify({ schema: "skill-sniffer/compat@1", ...report }, null, 2) + "\n";
}

export function renderCompatibilityText(report: CompatibilityReport, cwd = process.cwd()): string {
  const lines = [
    "Skill compatibility (static checks, not a host load guarantee)",
    ["Skill", ...report.profiles.map((p) => p.id)].join(" | "),
  ];
  for (const skill of report.skills) {
    const path = relative(cwd, skill.path) || skill.path;
    lines.push([path, ...skill.hosts.map((h) => h.status)].join(" | "));
    for (const host of skill.hosts) {
      for (const finding of host.report.findings) {
        lines.push(`  ${host.host} [${finding.severity}] ${finding.message}`);
      }
    }
  }
  if (report.skills.length === 0) lines.push("No skill files found.");
  lines.push("", "Profile scope and unknowns:");
  for (const p of report.profiles) lines.push(`  ${p.id}: ${p.notes}`);
  return lines.join("\n") + "\n";
}
