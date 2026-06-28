import { Command } from "commander";
import pc from "picocolors";
import { getVersion } from "./version.js";
import { discoverSkills } from "./discover.js";
import { parseSkills } from "./parse.js";
import { runEngine } from "./engine.js";
import { scoreReport } from "./score.js";
import { renderPretty } from "./report/pretty.js";
import { renderJson } from "./report/json.js";
import { writeConfigStub } from "./init.js";
import { fixSkills, type FixFileResult } from "./fix.js";

/** Parsed CLI options for the sniff action. */
interface SniffOptions {
  json?: boolean;
  minScore?: number;
  maxWarnings?: number;
  init?: boolean;
  fix?: boolean;
  dryRun?: boolean;
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

  program
    .argument("[paths...]", "skill file(s) or director(ies) to sniff")
    .option("--json", "emit a machine-readable JSON report instead of pretty output")
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

      const files = await discoverSkills(paths);
      if (files.length === 0) {
        process.stdout.write(
          `${pc.yellow("no skills found")} 🐕💨 (looked for SKILL.md / *.skill.md)\n`,
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
      const report = runEngine(skills);
      const scored = scoreReport(
        report,
        skills.map((s) => s.path),
      );

      if (opts.json) {
        process.stdout.write(renderJson(scored, getVersion()));
      } else {
        process.stdout.write(renderPretty(scored));
      }

      setExit(program, gateExitCode(scored.counts.error, scored, opts));
    });

  return program;
}

/**
 * Decide the exit code from findings + gates.
 *
 * Fails (returns {@link EXIT.FINDINGS}) when **any** of these hold:
 * - there is at least one `error` finding;
 * - `--min-score` is set and the overall score is below it;
 * - `--max-warnings` is set and the warning count exceeds it.
 *
 * Otherwise returns {@link EXIT.OK}. Warnings/info alone never fail the build
 * unless a gate explicitly asks them to.
 */
function gateExitCode(
  errorCount: number,
  scored: { score: number; counts: { warning: number } },
  opts: SniffOptions,
): number {
  if (errorCount > 0) return EXIT.FINDINGS;
  if (opts.minScore !== undefined && scored.score < opts.minScore) {
    return EXIT.FINDINGS;
  }
  if (
    opts.maxWarnings !== undefined &&
    scored.counts.warning > opts.maxWarnings
  ) {
    return EXIT.FINDINGS;
  }
  return EXIT.OK;
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
