import { relative, sep } from "node:path";
import type { Finding, Severity } from "../types.js";
import { rules } from "../rules/index.js";

/**
 * skill-sniffer 🐕👃 — SARIF 2.1.0 report (`--sarif`).
 *
 * Static Analysis Results Interchange Format is the lingua franca GitHub
 * code-scanning speaks: upload a SARIF file with `github/codeql-action/upload-sarif`
 * and every finding shows up in the **Security tab** and as an **inline PR
 * annotation** on the exact line — the same integration ESLint/shellcheck get.
 * This turns skill-sniffer from "a linter that prints" into "a linter that
 * integrates", with zero server and no extra deps.
 *
 * Like the other reporters, this returns a JSON *string* (newline-terminated)
 * rather than writing it, so the CLI, the Action, and the tests all share one
 * code path. The output is intentionally minimal-but-valid: one `run`, the full
 * rule registry as `reportingDescriptor`s, and one `result` per finding.
 *
 * Reference: SARIF 2.1.0 (OASIS). We emit the subset consumers actually read:
 * `$schema`, `version`, `runs[].tool.driver.{name,version,informationUri,rules}`,
 * and `runs[].results[].{ruleId,level,message,locations}`.
 */

/** Canonical SARIF 2.1.0 JSON-schema URL (for editor/validator hints). */
export const SARIF_SCHEMA =
  "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json";

/** SARIF version string we conform to. */
export const SARIF_VERSION = "2.1.0";

/** Where humans can read about the tool (shown in the code-scanning UI). */
const INFORMATION_URI = "https://github.com/rwrife/skill-sniffer";

/**
 * SARIF `result.level` values. SARIF has no "info"; the softest actionable
 * level is `note`, which we map our `info` severity to.
 */
type SarifLevel = "error" | "warning" | "note";

/**
 * Map a skill-sniffer {@link Severity} to a SARIF `level`.
 *
 * - `error`   → `error`
 * - `warning` → `warning`
 * - `info`    → `note`   (SARIF's gentlest actionable level)
 *
 * Exported so the mapping is unit-testable in isolation (acceptance criterion).
 */
export function severityToSarifLevel(severity: Severity): SarifLevel {
  switch (severity) {
    case "error":
      return "error";
    case "warning":
      return "warning";
    case "info":
      return "note";
  }
}

/**
 * Convert an absolute (or already-relative) file path into a repo-relative,
 * POSIX-style URI suitable for a SARIF `artifactLocation.uri`.
 *
 * SARIF consumers (GitHub code-scanning) expect forward-slash, repo-relative
 * paths so annotations land on the right file regardless of the machine the
 * scan ran on. We compute the path relative to `baseDir` (the CWD by default)
 * and normalize separators. Paths already outside `baseDir` (rare) fall back to
 * their normalized original so we never emit an empty URI.
 */
export function toArtifactUri(filePath: string, baseDir: string): string {
  let rel = relative(baseDir, filePath);
  // relative() returns "" when filePath === baseDir; guard against oddities.
  if (!rel) rel = filePath;
  // Normalize Windows separators to POSIX for portable, deterministic URIs.
  if (sep !== "/") rel = rel.split(sep).join("/");
  // Strip a leading "./" if present; keep "../" (out-of-tree) intact.
  return rel.replace(/^\.\//, "");
}

/** Options controlling how findings are projected into SARIF. */
export interface SarifOptions {
  /**
   * Directory that artifact URIs are made relative to. Defaults to the current
   * working directory — matching how `upload-sarif` resolves paths against the
   * repo root the workflow checked out.
   */
  baseDir?: string;
}

/**
 * Build the SARIF `tool.driver.rules` array from the rule registry. Every
 * registered rule becomes a `reportingDescriptor` (id + short/full description),
 * so consumers can render rule metadata even for rules that produced no result
 * this run. This is the SARIF analogue of ESLint's rule docs links.
 */
function buildRuleDescriptors(): Array<Record<string, unknown>> {
  return rules.map((r) => ({
    id: r.id,
    name: r.id,
    shortDescription: { text: r.description },
    fullDescription: { text: r.description },
    defaultConfiguration: { level: severityToSarifLevel(r.defaultSeverity) },
    helpUri: `${INFORMATION_URI}#${r.id}`,
  }));
}

/**
 * Project a single {@link Finding} into a SARIF `result`.
 *
 * `ruleIndex` lets consumers cross-reference the `tool.driver.rules` array
 * without a string lookup; we pass the registry index (or omit it for findings
 * whose rule isn't registered, which shouldn't happen but stays defensive).
 *
 * Locations always carry the artifact URI. A `region` with `startLine` (and
 * `startColumn` when known) is added only when the finding has a line — SARIF
 * regions are 1-based, matching our {@link Finding.line}/`column`. Whole-file
 * findings (no line) omit the region entirely, which consumers treat as
 * file-level annotations. This is the documented degrade-gracefully behavior.
 */
function findingToResult(
  finding: Finding,
  baseDir: string,
  ruleIndex: number,
): Record<string, unknown> {
  const region: Record<string, number> = {};
  if (finding.line !== undefined) {
    region.startLine = finding.line;
    if (finding.column !== undefined) region.startColumn = finding.column;
  }

  const physicalLocation: Record<string, unknown> = {
    artifactLocation: {
      uri: toArtifactUri(finding.path, baseDir),
      uriBaseId: "SRCROOT",
    },
  };
  if (Object.keys(region).length > 0) physicalLocation.region = region;

  const result: Record<string, unknown> = {
    ruleId: finding.ruleId,
    level: severityToSarifLevel(finding.severity),
    message: { text: finding.message },
    locations: [{ physicalLocation }],
  };
  if (ruleIndex >= 0) result.ruleIndex = ruleIndex;
  return result;
}

/**
 * Render a set of findings as a SARIF 2.1.0 JSON string.
 *
 * @param findings the flat finding list to serialize (typically `report.findings`).
 * @param version  the skill-sniffer version to stamp into `tool.driver.version`.
 * @param options  see {@link SarifOptions} (notably `baseDir` for URIs).
 * @param pretty   when true (default), pretty-print with 2-space indent; pass
 *                 false for compact single-line output.
 */
export function renderSarif(
  findings: Finding[],
  version: string,
  options: SarifOptions = {},
  pretty = true,
): string {
  const baseDir = options.baseDir ?? process.cwd();
  const ruleIndexById = new Map(rules.map((r, i) => [r.id, i]));

  const sarif = {
    $schema: SARIF_SCHEMA,
    version: SARIF_VERSION,
    runs: [
      {
        tool: {
          driver: {
            name: "skill-sniffer",
            informationUri: INFORMATION_URI,
            version,
            rules: buildRuleDescriptors(),
          },
        },
        // Declare SRCROOT so consumers resolve URIs against the repo root.
        originalUriBaseIds: {
          SRCROOT: { uri: "file:///" },
        },
        results: findings.map((f) =>
          findingToResult(f, baseDir, ruleIndexById.get(f.ruleId) ?? -1),
        ),
      },
    ],
  };

  return JSON.stringify(sarif, null, pretty ? 2 : 0) + "\n";
}
