/**
 * skill-sniffer 🐕👃 — GitHub Action runner (issue #9).
 *
 * The thin I/O layer behind `action.yml`. Responsibilities:
 *
 *  1. Figure out which **changed** skill files a PR touched (git diff of the
 *     base SHA against HEAD), filtered to the same naming convention discovery
 *     uses (`looksLikeSkillFile`).
 *  2. Lint exactly those files with the existing CLI in `--json` mode.
 *  3. Aggregate the JSON into one report and render a single **sticky** PR
 *     comment, creating it the first time and editing it in place thereafter.
 *  4. Exit non-zero when the run fails its gate (any error finding, or overall
 *     score below `min-score`) so the Action's check turns red.
 *
 * Everything GitHub-specific is read from the environment the Action wires up
 * (`GITHUB_*`, `INPUT_*`). The decision logic that doesn't need I/O lives in
 * sibling modules (`comment.ts`, `aggregate.ts`) and is unit-tested there; the
 * one pure helper here, {@link filterSkillFiles}, is tested too.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { looksLikeSkillFile } from "../discover.js";
import { getVersion } from "../version.js";
import { renderSarif } from "../report/sarif.js";
import {
  aggregateReports,
  parseRawReport,
  type AggregatedReport,
  type RawJsonReport,
} from "./aggregate.js";
import {
  COMMENT_MARKER,
  passesGate,
  renderComment,
  renderNoSkillsComment,
} from "./comment.js";

/** Minimal view of the GitHub event payload we read (PR number + base sha). */
interface PullRequestEvent {
  pull_request?: {
    number?: number;
    base?: { sha?: string };
    head?: { sha?: string };
  };
}

/** Resolved runtime inputs, gathered from the Action environment. */
interface ActionInputs {
  /** `min-score` input; `undefined` when unset/blank (no score gate). */
  minScore?: number;
  /** Absolute repo root (GITHUB_WORKSPACE), for relative path display. */
  repoRoot: string;
  /** `owner/repo` slug for the GitHub API. */
  repo: string;
  /** PR number to comment on, or `undefined` when not a PR event. */
  prNumber?: number;
  /** Base SHA to diff against (PR base), when available. */
  baseSha?: string;
  /** Head SHA the report describes, for the comment footer. */
  headSha?: string;
  /** Whether posting the PR comment is enabled (`comment` input). */
  comment: boolean;
  /**
   * Path to write a SARIF 2.1.0 report to (`sarif` input), or `undefined` when
   * unset/blank. When set, the runner emits SARIF for the changed files so a
   * downstream `github/codeql-action/upload-sarif` step can surface findings in
   * the code-scanning UI. Blank means "don't emit SARIF".
   */
  sarifPath?: string;
}

/**
 * Filter an arbitrary list of changed paths down to skill files. Pure: shared
 * by {@link collectChangedSkillFiles} and the unit tests. Order is preserved
 * and de-duplicated.
 */
export function filterSkillFiles(paths: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of paths) {
    const trimmed = p.trim();
    if (trimmed && looksLikeSkillFile(trimmed) && !seen.has(trimmed)) {
      seen.add(trimmed);
      out.push(trimmed);
    }
  }
  return out;
}

/** Read a required env var, throwing a clear error when missing. */
function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required environment variable: ${name}`);
  return v;
}

/**
 * Parse an `INPUT_MIN-SCORE`-style value into a finite integer, or `undefined`
 * when blank. GitHub passes all inputs as strings; a blank/missing one means
 * "no gate". A non-numeric value is a hard error so typos don't silently skip
 * the gate.
 */
function parseMinScore(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`min-score must be a number, got "${raw}"`);
  }
  return Math.trunc(n);
}

/** Gather inputs from the Action environment. */
function readInputs(): ActionInputs {
  const repoRoot = process.env.GITHUB_WORKSPACE ?? process.cwd();
  const repo = requireEnv("GITHUB_REPOSITORY");

  let prNumber: number | undefined;
  let baseSha: string | undefined;
  let headSha: string | undefined;
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (eventPath) {
    try {
      const event = JSON.parse(
        readFileSync(eventPath, "utf8"),
      ) as PullRequestEvent;
      prNumber = event.pull_request?.number;
      baseSha = event.pull_request?.base?.sha;
      headSha = event.pull_request?.head?.sha;
    } catch {
      // Not a PR event or unreadable payload — we'll degrade to scanning all.
    }
  }

  // `comment` input defaults to true; only an explicit "false" disables it.
  const comment = (process.env["INPUT_COMMENT"] ?? "true").toLowerCase() !==
    "false";

  // `sarif` input is a path; blank/missing means "don't emit SARIF".
  const sarifRaw = process.env["INPUT_SARIF"]?.trim();
  const sarifPath = sarifRaw ? sarifRaw : undefined;

  return {
    minScore: parseMinScore(process.env["INPUT_MIN-SCORE"]),
    repoRoot,
    repo,
    prNumber,
    baseSha,
    headSha: headSha ?? process.env.GITHUB_SHA,
    comment,
    sarifPath,
  };
}

/**
 * Compute the list of changed skill files for the PR. Uses a three-dot diff
 * (`base...head`) so it reflects exactly what the PR adds/modifies relative to
 * its merge base, ignoring unrelated churn on the base branch.
 *
 * Returns absolute paths. Falls back to an empty list (not all files) when the
 * base SHA is unknown — better to comment "nothing changed" than to noisily
 * lint the whole repo on a non-PR trigger.
 */
function collectChangedSkillFiles(inputs: ActionInputs): string[] {
  if (!inputs.baseSha) return [];

  let raw = "";
  try {
    // Diff filter ACMR = Added, Copied, Modified, Renamed — skip deletions.
    raw = execFileSync(
      "git",
      [
        "diff",
        "--name-only",
        "--diff-filter=ACMR",
        `${inputs.baseSha}...HEAD`,
      ],
      { cwd: inputs.repoRoot, encoding: "utf8" },
    );
  } catch {
    // Shallow clone may lack the base commit; try fetching it once.
    try {
      execFileSync("git", ["fetch", "--depth=1", "origin", inputs.baseSha], {
        cwd: inputs.repoRoot,
        stdio: "ignore",
      });
      raw = execFileSync(
        "git",
        ["diff", "--name-only", "--diff-filter=ACMR", `${inputs.baseSha}...HEAD`],
        { cwd: inputs.repoRoot, encoding: "utf8" },
      );
    } catch {
      return [];
    }
  }

  const changed = filterSkillFiles(raw.split("\n"));
  // Resolve to absolute paths under the workspace so they match CLI output.
  return changed.map((p) =>
    p.startsWith("/") ? p : `${inputs.repoRoot.replace(/\/$/, "")}/${p}`,
  );
}

/**
 * Absolute path to the built CLI bin, resolved from this module's location
 * (`<action>/dist/action/run.js` → `<action>/bin/skill-sniffer`). Resolving it
 * this way means it works no matter what cwd the runner executes under — the
 * consumer's workspace is the cwd, but the CLI lives in the action's checkout.
 */
function cliBinPath(): string {
  const here = dirname(fileURLToPath(import.meta.url)); // <action>/dist/action
  return resolve(here, "..", "..", "bin", "skill-sniffer");
}

/**
 * Lint the given files with the built CLI in `--json` mode and return the parsed
 * report. We invoke the action's local `bin/skill-sniffer` (resolved absolutely)
 * so the Action always uses the version it checked out/built, not a globally
 * installed one. The files are linted from the consumer workspace cwd so paths
 * resolve as authored.
 *
 * The CLI exits non-zero when it finds problems; that's expected here, so we
 * capture stdout regardless of exit code and parse it. A genuinely broken run
 * (no/garbage stdout) throws.
 */
function lintFiles(files: string[], repoRoot: string, sarifPath?: string): RawJsonReport {
  if (files.length === 0) {
    // Nothing to lint — synthesize an empty, clean report.
    return {
      schema: "skill-sniffer/report@1",
      version: "0.0.0",
      score: 100,
      skillsChecked: 0,
      counts: { error: 0, warning: 0, info: 0 },
      scores: [],
      findings: [],
    };
  }

  // `--sarif <path>` writes SARIF to a file while `--json` still streams the
  // report to stdout — the two coexist (only bare `--sarif` to stdout would
  // conflict with `--json`).
  const sarifArgs = sarifPath ? ["--sarif", sarifPath] : [];

  let stdout = "";
  try {
    stdout = execFileSync(
      process.execPath,
      [cliBinPath(), "--json", ...sarifArgs, ...files],
      { cwd: repoRoot, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
    );
  } catch (err) {
    // Non-zero exit (findings present) still produces stdout on the error.
    const e = err as { stdout?: string | Buffer };
    stdout = typeof e.stdout === "string"
      ? e.stdout
      : e.stdout?.toString("utf8") ?? "";
    if (!stdout.trim()) throw err;
  }

  return parseRawReport(JSON.parse(stdout));
}

/**
 * Find an existing sticky comment id on the PR (one whose body contains
 * {@link COMMENT_MARKER}), or `undefined` if none exists yet. Uses `gh api` with
 * pagination so it works on busy PRs.
 */
function findStickyComment(repo: string, prNumber: number): number | undefined {
  try {
    const raw = execFileSync(
      "gh",
      [
        "api",
        "--paginate",
        `repos/${repo}/issues/${prNumber}/comments`,
        "--jq",
        // Emit "id\tbodyHasMarker" so we don't ship the whole body around.
        `.[] | "\\(.id)\t\\(.body | contains("${COMMENT_MARKER}"))"`,
      ],
      { encoding: "utf8" },
    );
    for (const line of raw.split("\n")) {
      const [id, hasMarker] = line.split("\t");
      if (hasMarker === "true" && id) return Number(id);
    }
  } catch {
    // No token / not found — caller will just attempt a create.
  }
  return undefined;
}

/**
 * Create or update the sticky PR comment with `body`. Writes the body to a temp
 * file and passes it via `--field body=@file` so arbitrary Markdown (pipes,
 * backticks, newlines) survives without shell-quoting hazards.
 */
function upsertComment(
  repo: string,
  prNumber: number,
  body: string,
): void {
  const bodyFile = `${process.env.RUNNER_TEMP ?? "/tmp"}/skill-sniffer-comment.md`;
  writeFileSync(bodyFile, body, "utf8");

  const existing = findStickyComment(repo, prNumber);
  if (existing !== undefined) {
    execFileSync(
      "gh",
      [
        "api",
        "--method",
        "PATCH",
        `repos/${repo}/issues/comments/${existing}`,
        "--field",
        `body=@${bodyFile}`,
      ],
      { stdio: "ignore" },
    );
  } else {
    execFileSync(
      "gh",
      [
        "api",
        "--method",
        "POST",
        `repos/${repo}/issues/${prNumber}/comments`,
        "--field",
        `body=@${bodyFile}`,
      ],
      { stdio: "ignore" },
    );
  }
}

/** Write a one-line summary to the GitHub step summary, when available. */
function writeStepSummary(report: AggregatedReport, passed: boolean): void {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;
  const verdict = passed ? "✅ passed" : "❌ failed";
  const line =
    `### 🐕👃 skill-sniffer ${verdict}\n\n` +
    `Good Boy Score™ **${report.score}/100** · ` +
    `${report.skillsChecked} file(s) · ` +
    `${report.counts.error} error / ${report.counts.warning} warning / ${report.counts.info} info\n`;
  try {
    writeFileSync(summaryPath, line, { flag: "a" });
  } catch {
    /* best-effort */
  }
}

/** Expose outputs for downstream steps via $GITHUB_OUTPUT. */
function writeOutputs(report: AggregatedReport, passed: boolean): void {
  const outPath = process.env.GITHUB_OUTPUT;
  if (!outPath) return;
  try {
    writeFileSync(
      outPath,
      `score=${report.score}\npassed=${passed}\nfindings=${report.findings.length}\n`,
      { flag: "a" },
    );
  } catch {
    /* best-effort */
  }
}

/**
 * Entry point. Returns the intended process exit code: `0` on pass, `1` on a
 * tripped gate. Throws (→ caught by the bin wrapper as exit 2) only on genuine
 * operational failure.
 */
export function main(): number {
  const inputs = readInputs();
  const changed = collectChangedSkillFiles(inputs);

  // No changed skill files: post an all-clear sticky (so a prior red comment is
  // cleared) and pass.
  if (changed.length === 0) {
    // If SARIF was requested, still write an empty-but-valid report so a
    // downstream unconditional `upload-sarif` step doesn't fail on a missing
    // file (it simply uploads zero results).
    if (inputs.sarifPath) {
      try {
        writeFileSync(
          inputs.sarifPath,
          renderSarif([], getVersion(), { baseDir: inputs.repoRoot }),
          "utf8",
        );
      } catch (err) {
        process.stderr.write(
          `skill-sniffer: could not write SARIF: ${(err as Error).message}\n`,
        );
      }
    }
    if (inputs.comment && inputs.prNumber !== undefined) {
      try {
        upsertComment(
          inputs.repo,
          inputs.prNumber,
          renderNoSkillsComment(inputs.headSha),
        );
      } catch (err) {
        process.stderr.write(
          `skill-sniffer: could not post comment: ${(err as Error).message}\n`,
        );
      }
    }
    process.stdout.write("skill-sniffer: no changed skill files — nothing to sniff 😴\n");
    return 0;
  }

  const raw = lintFiles(changed, inputs.repoRoot, inputs.sarifPath);
  const report = aggregateReports([raw]);
  const passed = passesGate(report, inputs.minScore);

  if (inputs.comment && inputs.prNumber !== undefined) {
    try {
      upsertComment(
        inputs.repo,
        inputs.prNumber,
        renderComment(report, {
          minScore: inputs.minScore,
          repoRoot: inputs.repoRoot,
          sha: inputs.headSha?.slice(0, 7),
        }),
      );
    } catch (err) {
      process.stderr.write(
        `skill-sniffer: could not post comment: ${(err as Error).message}\n`,
      );
    }
  }

  writeStepSummary(report, passed);
  writeOutputs(report, passed);

  process.stdout.write(
    `skill-sniffer: score ${report.score}/100 over ${report.skillsChecked} file(s) — ${passed ? "passed" : "failed"}\n`,
  );
  return passed ? 0 : 1;
}
