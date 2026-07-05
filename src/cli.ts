import { Command } from "commander";
import pc from "picocolors";
import { getVersion } from "./version.js";
import { discoverSkills } from "./discover.js";
import { canonicalFormat, ALL_FORMATS } from "./format.js";
import { parseSkills } from "./parse.js";
import { runEngine } from "./engine.js";
import { scoreReport } from "./score.js";
import { renderPretty } from "./report/pretty.js";
import { renderJson } from "./report/json.js";
import { renderSarif } from "./report/sarif.js";
import { writeFileSync } from "node:fs";
import { writeConfigStub } from "./init.js";
import { fixSkills, type FixFileResult } from "./fix.js";
import { loadConfig, type ResolvedConfig } from "./config.js";
import { explain } from "./explain.js";

/** Parsed CLI options for the sniff action. */
interface SniffOptions {
  json?: boolean;
  /**
   * SARIF 2.1.0 output. `true` (bare `--sarif`) writes SARIF to stdout; a
   * string (`--sarif <path>`) writes it to that file. `undefined` means the
   * flag was not passed. Emitting to stdout is mutually exclusive with `--json`
   * (two machine formats can't share stdout); writing to a file is not.
   */
  sarif?: string | boolean;
  minScore?: number;
  maxWarnings?: number;
  init?: boolean;
  fix?: boolean;
  dryRun?: boolean;
  /** Only scan these agent-context formats (repeatable / comma-separated). */
  include?: string[];
  /** Never scan these agent-context formats (repeatable / comma-separated). */
  exclude?: string[];
  /**
   * Config control. A string is an explicit path from `--config <path>`;
   * `false` comes from `--no-config` (skip discovery, use built-in defaults);
   * `undefined` means "discover normally".
   */
  config?: string | false;
}

/**
 * Exit codes the CLI can return. Kept explicit so the contract is documented in
 * one place and tests can assert against names rather than magic numbers.
 *
 * - `OK`           — clean (or only sub-threshold findings); nothing to fail on.
 * - `FINDINGS`     — a gate tripped: errors present, or `--min-score` /
 *                    `--max-warnings` exceeded.
 * - `USAGE`        — bad invocation / internal error (thrown out of the action).
 */
export const EXIT = {
  OK: 0,
  FINDINGS: 1,
  USAGE: 2,
} as const;

/** Coerce a CLI string into a finite integer, or throw a usage error. */
function parseIntOption(name: string): (value: string) => number {
  return (value: string): number => {
    const n = Number(value);
    if (!Number.isFinite(n) || !Number.isInteger(n)) {
      throw new Error(`--${name} expects an integer, got "${value}"`);
    }
    return n;
  };
}

/**
 * Collect a repeatable, comma-splittable list option (e.g.
 * `--include skill,agents --include claude`). Commander calls this per
 * occurrence; we split on commas and accumulate so both styles work.
 */
function collectList(value: string, previous: string[] = []): string[] {
  const parts = value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return [...previous, ...parts];
}

/**
 * Validate `--include` / `--exclude` selectors against the known formats,
 * returning a warning line per unrecognized name (empty when all are valid).
 * Unknown selectors are ignored by the resolver, so this is purely advisory —
 * but surfacing them stops a typo (`--include agent`) from silently scanning
 * nothing.
 */
function validateFormatSelectors(opts: SniffOptions): string[] {
  const warnings: string[] = [];
  const check = (flag: string, values?: string[]) => {
    for (const raw of values ?? []) {
      if (!canonicalFormat(raw)) {
        warnings.push(
          `${flag}: unknown format "${raw}" (known: ${ALL_FORMATS.join(", ")})`,
        );
      }
    }
  };
  check("--include", opts.include);
  check("--exclude", opts.exclude);
  return warnings;
}

/**
 * Build the commander program. Kept as a factory so tests can construct a
 * fresh instance and override exit/output behavior. The resolved exit code for
 * a run is stashed on the returned command as `__exitCode` for {@link run}.
 */
export function buildProgram(): Command {
  const program = new Command();

  program
    .name("skill-sniffer")
    .description(
      "🐕👃 A paranoid, offline linter for agent SKILL.md files. Sniffs out secrets, prompt-injection bait, token bloat, broken paths, and over-broad tool grants.",
    )
    .version(getVersion(), "-v, --version", "print the version and exit");

  // `explain [ruleId]` — offline docs for a rule id (issue #22). With no id it
  // lists every registered rule; with an unknown id it errors (non-zero exit)
  // and suggests valid ids. Registered as a proper subcommand so it doesn't
  // collide with the root `[paths...]` sniff action.
  program
    .command("explain")
    .argument(
      "[ruleId]",
      "the rule id to explain (omit to list every rule)",
    )
    .description(
      "explain why a rule exists, what triggers it, and how to fix it (offline)",
    )
    .action((ruleId: string | undefined) => {
      const result = explain(ruleId);
      if (result.stream === "stderr") {
        process.stderr.write(result.text);
      } else {
        process.stdout.write(result.text);
      }
      setExit(program, result.exitCode);
    });

  program
    .argument("[paths...]", "skill file(s) or director(ies) to sniff")
    .option("--json", "emit a machine-readable JSON report instead of pretty output")
    .option(
      "--sarif [path]",
      "emit a SARIF 2.1.0 report for GitHub code-scanning; writes to <path> if given, else stdout (stdout is mutually exclusive with --json)",
    )
    .option(
      "--min-score <n>",
      "exit non-zero if any skill scores below <n> (0\u2013100)",
      parseIntOption("min-score"),
    )
    .option(
      "--max-warnings <n>",
      "exit non-zero if total warnings exceed <n>",
      parseIntOption("max-warnings"),
    )
    .option(
      "--init",
      `write a ${".skillsnifferrc"} config stub to the current directory and exit`,
    )
    .option(
      "--fix",
      "auto-fix safe findings (strip invisible chars, tidy whitespace, reorder frontmatter)",
    )
    .option(
      "--dry-run",
      "with --fix, preview a diff of changes without writing any files",
    )
    .option(
      "--config <path>",
      `use a specific ${".skillsnifferrc"} file instead of discovering one`,
    )
    .option(
      "--no-config",
      "ignore any .skillsnifferrc and use built-in defaults",
    )
    .option(
      "--include <formats>",
      `only scan these agent-context formats (repeatable/comma-separated: ${ALL_FORMATS.join(", ")})`,
      collectList,
    )
    .option(
      "--exclude <formats>",
      "skip these agent-context formats (repeatable/comma-separated)",
      collectList,
    )
    .action(async (paths: string[], opts: SniffOptions) => {
      // --init is a standalone action: scaffold config, then exit.
      if (opts.init) {
        const result = writeConfigStub();
        if (result.created) {
          process.stdout.write(
            `${pc.green("created")} ${result.path} \ud83d\udc15 (edit to taste)\n`,
          );
        } else {
          process.stdout.write(
            `${pc.yellow("already exists")} ${result.path} \u2014 left untouched\n`,
          );
        }
        setExit(program, EXIT.OK);
        return;
      }

      if (!paths || paths.length === 0) {
        // No paths: show help and exit cleanly.
        program.help();
        return;
      }

      // --dry-run is only meaningful alongside --fix.
      if (opts.dryRun && !opts.fix) {
        throw new Error("--dry-run requires --fix");
      }

      // Two machine-readable formats can't share stdout. `--sarif` to a file is
      // fine alongside `--json`; only bare `--sarif` (stdout) conflicts.
      if (opts.json && opts.sarif === true) {
        throw new Error(
          "--json and --sarif (to stdout) are mutually exclusive; pass --sarif <path> to write SARIF to a file alongside --json",
        );
      }

      const selectorWarnings = validateFormatSelectors(opts);
      for (const w of selectorWarnings) {
        process.stderr.write(`${pc.yellow("warning:")} ${w}\n`);
      }

      const files = await discoverSkills(paths, {
        include: opts.include,
        exclude: opts.exclude,
      });
      if (files.length === 0) {
        process.stdout.write(
          `${pc.yellow("no skills found")} 🐕💨 (looked for SKILL.md / *.skill.md / AGENTS.md / CLAUDE.md / .cursorrules / MCP manifests)\n`,
        );
        setExit(program, EXIT.OK);
        return;
      }

      // --fix is its own action: mechanically clean safe findings, then exit.
      // It deliberately runs before (and instead of) the lint report so authors
      // get a focused "here's what I changed" view.
      if (opts.fix) {
        const results = await fixSkills(files, { dryRun: opts.dryRun });
        process.stdout.write(renderFixResults(results, opts.dryRun ?? false));
        setExit(program, fixExitCode(results));
        return;
      }

      const skills = await parseSkills(files);

      // Resolve project config (issue #8). Precedence, low → high:
      //   built-in defaults  <  .skillsnifferrc  <  CLI flags.
      // `--no-config` (opts.config === false) skips discovery entirely.
      const config = loadConfig(paths, {
        explicitPath: typeof opts.config === "string" ? opts.config : undefined,
        enabled: opts.config !== false,
      });

      const report = runEngine(skills, { config });
      const scored = scoreReport(
        report,
        skills.map((s) => s.path),
      );

      // SARIF output (issue #21). When a path is given, write there and still
      // print the human/JSON report to stdout; a bare `--sarif` streams SARIF
      // to stdout instead of the pretty/JSON report.
      const sarifToFile = typeof opts.sarif === "string";
      const sarifToStdout = opts.sarif === true;
      if (sarifToFile) {
        const sarif = renderSarif(scored.findings, getVersion());
        writeFileSync(opts.sarif as string, sarif, "utf8");
        process.stderr.write(
          `${pc.dim(`\u2192 wrote SARIF to ${opts.sarif as string}`)}\n`,
        );
      }

      if (sarifToStdout) {
        process.stdout.write(renderSarif(scored.findings, getVersion()));
      } else if (opts.json) {
        process.stdout.write(renderJson(scored, getVersion()));
      } else {
        process.stdout.write(renderConfigNotices(config));
        process.stdout.write(renderPretty(scored));
      }

      setExit(program, gateExitCode(scored.counts.error, scored, opts, config));
    });

  return program;
}

/**
 * Decide the exit code from findings + gates, with config + CLI precedence.
 *
 * Effective gate values are resolved CLI-first, then config, then "no gate":
 * `--min-score`/`--max-warnings` flags override any config-supplied defaults.
 *
 * Fails (returns {@link EXIT.FINDINGS}) when **any** of these hold:
 * - there is at least one `error` finding;
 * - an effective `min-score` is set and the overall score is below it;
 * - an effective `max-warnings` is set and the warning count exceeds it.
 *
 * Otherwise returns {@link EXIT.OK}. Warnings/info alone never fail the build
 * unless a gate explicitly asks them to.
 */
function gateExitCode(
  errorCount: number,
  scored: { score: number; counts: { warning: number } },
  opts: SniffOptions,
  config: ResolvedConfig,
): number {
  const minScore = opts.minScore ?? config.minScore;
  const maxWarnings = opts.maxWarnings ?? config.maxWarnings;

  if (errorCount > 0) return EXIT.FINDINGS;
  if (minScore !== undefined && scored.score < minScore) {
    return EXIT.FINDINGS;
  }
  if (maxWarnings !== undefined && scored.counts.warning > maxWarnings) {
    return EXIT.FINDINGS;
  }
  return EXIT.OK;
}

/**
 * Render a short, dim header noting the config in effect and any validation
 * warnings it produced (unknown rule ids, ignored keys). Empty string when no
 * config file was loaded and there's nothing to report — a no-config run stays
 * silent. JSON mode skips this entirely (machines get a clean payload).
 */
function renderConfigNotices(config: ResolvedConfig): string {
  const lines: string[] = [];
  if (config.sourcePath) {
    lines.push(pc.dim(`⚙ config: ${config.sourcePath}`));
  }
  for (const w of config.warnings) {
    lines.push(`${pc.yellow("config warning:")} ${w}`);
  }
  return lines.length ? lines.join("\n") + "\n" : "";
}

/** Stash the resolved exit code on the program for {@link run} to read. */
function setExit(program: Command, code: number): void {
  (program as Command & { __exitCode?: number }).__exitCode = code;
}

/**
 * Exit code for a `--fix` run. A read/write failure on any file is a real
 * problem ({@link EXIT.USAGE}); otherwise fixing always succeeds, whether or
 * not anything actually needed changing ({@link EXIT.OK}). `--fix` is a
 * maintenance action, not a gate, so a clean pass and an applied-fixes pass
 * both exit 0 — CI uses the lint run (without `--fix`) to gate.
 */
function fixExitCode(results: FixFileResult[]): number {
  return results.some((r) => r.error) ? EXIT.USAGE : EXIT.OK;
}

/**
 * Render the outcome of a `--fix` run for humans. Lists each changed file with
 * a one-line summary of the safe transforms applied; in `--dry-run` mode it
 * also prints the unified diff so authors can eyeball the rewrite. Files that
 * were already clean are summarized in a single trailing line to keep noise
 * down on large kennels.
 */
function renderFixResults(results: FixFileResult[], dryRun: boolean): string {
  const out: string[] = [];
  const verb = dryRun ? "would fix" : "fixed";

  let changedCount = 0;
  let cleanCount = 0;
  let errorCount = 0;

  for (const r of results) {
    if (r.error) {
      errorCount++;
      out.push(`${pc.red("error")} ${r.path} \u2014 ${r.error}`);
      continue;
    }
    if (!r.changed) {
      cleanCount++;
      continue;
    }

    changedCount++;
    out.push(`${pc.green(verb)} ${pc.bold(r.path)} \ud83d\udc15`);
    for (const c of r.changes) {
      out.push(`  ${pc.dim("\u2022")} ${c.message}`);
    }
    if (dryRun && r.diff) {
      out.push(colorizeDiff(r.diff));
    }
  }

  // Summary footer.
  const parts: string[] = [];
  if (changedCount > 0) {
    parts.push(pc.green(`${changedCount} ${verb}`));
  }
  if (cleanCount > 0) parts.push(pc.dim(`${cleanCount} already clean`));
  if (errorCount > 0) parts.push(pc.red(`${errorCount} errored`));
  if (parts.length === 0) parts.push(pc.dim("nothing to do"));

  const tail = dryRun && changedCount > 0
    ? ` ${pc.yellow("(dry run \u2014 no files written)")}`
    : "";
  out.push(`\n${parts.join(pc.dim(", "))}${tail}`);

  return out.join("\n") + "\n";
}

/** Apply red/green coloring to +/- lines of a unified diff for readability. */
function colorizeDiff(diff: string): string {
  return diff
    .split("\n")
    .map((line) => {
      if (line.startsWith("+")) return pc.green(line);
      if (line.startsWith("-")) return pc.red(line);
      if (line.startsWith("@@")) return pc.cyan(line);
      return pc.dim(line);
    })
    .join("\n");
}

/**
 * Run the CLI. Returns the intended process exit code so the thin bin wrapper
 * and tests can decide what to do with it. Async because the action performs
 * file discovery + parsing.
 */
export async function run(argv: string[] = process.argv): Promise<number> {
  const program = buildProgram();
  try {
    await program.parseAsync(argv);
    return (program as Command & { __exitCode?: number }).__exitCode ?? EXIT.OK;
  } catch (err) {
    process.stderr.write(`${pc.red("error:")} ${(err as Error).message}\n`);
    return EXIT.USAGE;
  }
}
