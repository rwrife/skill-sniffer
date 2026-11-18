import type { Finding, ParsedSkill, SuppressedFinding } from "./types.js";

export interface InlineDisableOptions {
  /** Set false to ignore inline directives, including their diagnostics. */
  inlineDisable?: boolean;
  /** Include suppressed findings separately from scored/gated findings. */
  reportSuppressed?: boolean;
}

interface Directive {
  line: number;
  action: "disable" | "disable-next-line" | "enable";
  rules?: string[];
  reason?: string;
  used: Set<string>;
}

/** Apply source-line suppressions after rules run; diagnostics cannot suppress themselves. */
export function applyInlineDisables(
  skill: ParsedSkill,
  findings: Finding[],
  ruleIds: readonly string[],
): { findings: Finding[]; suppressed: SuppressedFinding[] } {
  const kept = findings.filter((f) => f.line === undefined);
  const suppressed: SuppressedFinding[] = [];
  const byLine = new Map<number, Finding[]>();
  for (const finding of findings) {
    if (finding.line === undefined) continue;
    const bucket = byLine.get(finding.line) ?? [];
    bucket.push(finding);
    byLine.set(finding.line, bucket);
  }
  const active = new Map<string, Directive>();
  const nextLine = new Map<number, Directive[]>();
  const disables: Directive[] = [];
  const allIds = new Set([...ruleIds, ...findings.map((f) => f.ruleId)]);
  const lines = skill.raw.split(/\r?\n/);

  for (let index = 0; index < lines.length; index++) {
    const line = index + 1;
    const directives: Directive[] = [];
    for (const match of lines[index].matchAll(
      /<!--\s*skill-sniffer-(disable-next-line|disable|enable)(?:[ \t]+(.*?))?[ \t]*-->/g,
    )) {
      const payload = (match[2] ?? "").trim();
      const [, ids, reason] = /^(\S+)(?:\s+([\s\S]*))?$/.exec(payload) ?? [];
      directives.push({
        line,
        action: match[1] as Directive["action"],
        ...(ids ? { rules: [...new Set(ids.split(","))] } : {}),
        ...(reason ? { reason } : {}),
        used: new Set(),
      });
    }

    const inScope = new Map(active);
    for (const directive of directives) {
      if (directive.action === "enable") {
        if (!directive.rules) {
          active.clear();
          inScope.clear();
        } else {
          for (const id of directive.rules) {
            active.delete(id);
            inScope.delete(id);
          }
        }
      } else {
        disables.push(directive);
        if (directive.action === "disable-next-line") {
          const bucket = nextLine.get(line + 1) ?? [];
          bucket.push(directive);
          nextLine.set(line + 1, bucket);
        } else {
          for (const id of directive.rules ?? allIds) active.set(id, directive);
        }
      }
    }

    for (const finding of byLine.get(line) ?? []) {
      const directive = nextLine.get(line)?.find((d) =>
        !d.rules || d.rules.includes(finding.ruleId),
      ) ?? inScope.get(finding.ruleId);
      if (!directive) {
        kept.push(finding);
        continue;
      }
      directive.used.add(finding.ruleId);
      suppressed.push({
        ...finding,
        suppression: {
          line: directive.line,
          ...(directive.reason ? { reason: directive.reason } : {}),
        },
      });
    }
    byLine.delete(line);
  }

  // Preserve findings whose reported locations lie outside the available text.
  for (const bucket of byLine.values()) kept.push(...bucket);

  for (const directive of disables) {
    const unused = directive.rules
      ? directive.rules.filter((id) => !directive.used.has(id))
      : directive.used.size === 0 ? ["all rules"] : [];
    const dangling = directive.action === "disable" &&
      [...active.values()].includes(directive);
    const problems: string[] = [];
    if (unused.length) problems.push(`unused for ${unused.join(", ")}`);
    if (dangling) problems.push("dangling range (missing skill-sniffer-enable)");
    if (problems.length) {
      kept.push({
        ruleId: "inline-disable",
        severity: "warning",
        path: skill.path,
        line: directive.line,
        message: `skill-sniffer-${directive.action}: ${problems.join("; ")}`,
      });
    }
  }

  return { findings: kept, suppressed };
}
