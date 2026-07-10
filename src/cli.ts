import { Command } from "commander";
import pc from "picocolors";
import { getVersion } from "./version.js";
import { discoverSkills, intersectChanged } from "./discover.js";
import { changedFilesSince, GitError, isGitRepo } from "./git.js";
import { execFileSync } from "node:child_process";
import { resolve as resolvePath } from "node:path";
import { canonicalFormat, ALL_FORMATS } from "./format.js";
import { parseSkills } from "./parse.js";
import { runEngine } from "./engine.js";
import { scoreReport } from "./score.js";
import { renderPretty } from "./report/pretty.js";
import { renderJson } from "./report/json.js";
import {
  buildBaseline,
  writeBaseline,
  loadBaseline,
  diffBaseline,
  applyBaselineToFindings,
  baselineJsonSection,
  DEFAULT_BASELINE_FILE,
  type BaselineDiff,
} from "./baseline.js";
import { renderSarif } from "./report/sarif.js";
import { writeFileSync } from "node:fs";
import { writeConfigStub } from "./init.js";
import { fixSkills, type FixFileResult } from "./fix.js";
import { loadConfig, type ResolvedConfig } from "./config.js";
import { explain } from "./explain.js";
import { startWatch } from "./watch.js";
import {
  computeRanking,
  renderRankingText,
  renderRankingJson,
} from "./rank.js";
import { DEFAULT_TOKEN_BUDGET } from "./rules/token-bloat.js";

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
  /**
   * Diff mode (issue #23). When present, only files changed vs this ref (a
   * three-dot diff against HEAD) are linted. Commander yields `true` for a bare
   * `--since` (no value), which we resolve to `origin/main`; a string is an
   * explicit ref. `undefined` means the flag wasn't passed.
   */
  since?: string | boolean;
  init?: boolean;
  fix?: boolean;
  dryRun?: boolean;
  /**
   * Baseline diff mode (issue #32). `true` for bare `--baseline` (default file
   * `.skillsniffer-baseline.json`), a string for an explicit path, `undefined`
   * when not passed. Lint findings already in the baseline are downgraded to
   * `info`; only new findings gate CI.
   */
  baseline?: string | boolean;
  /** Gate: fail if new (non-baselined) findings exceed <n> (default 0). */
  maxNewFindings?: number;
  /** Gate: fail if any file's score drops more than <n> below baseline. */
  maxScoreDrop?: number;
  /**
   * Watch mode (issue #28). Keeps the process alive and re-sniffs the given
   * path(s) on file changes, reprinting the pretty report each cycle. A stream
   * of machine output on a clearing screen is nonsense, so `--watch` is
   * mutually exclusive with `--json`/`--sarif`; diff mode is a one-shot CI
   * concept, so `--since` is rejected too. Never gates: runs until Ctrl-C.
   */
  watch?: boolean;
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
 * Parsed CLI options for the `rank` subcommand (issue #27). A deliberately
 * small surface: it shares format selection (`include`/`exclude`) and diff
 * scoping (`since`) with the sniff action, plus its own presentation flags.
 */
interface RankOptions {
  /** Emit a machine-readable JSON ranking instead of the pretty leaderboard. */
  json?: boolean;
  /** Only show the heaviest `top` files (summary still covers all files). */
  top?: number;
  /** Token budget for the over-budget flag; defaults to the token-bloat budget. */
  budget?: number;
  /**
   * Diff scoping, identical to the sniff action's `--since`: `true` for a bare
   * flag (resolved to `origin/main`), a string for an explicit ref, `undefined`
   * when not passed.
   */
  since?: string | boolean;
  /** Only rank these agent-context formats (repeatable / comma-separated). */
  include?: string[];
  /** Never rank these agent-context formats (repeatable / comma-separated). */
  exclude?: string[];
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
function validateFormatSelectors(opts: {
  include?: string[];
  exclude?: string[];
}): string[] {
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

  // `rank [paths...]` — a headroom-style token-weight leaderboard (issue #27).
  // Sorts discovered agent-context files heaviest-first by estimated token
  // weight so authors can see what's eating context. It's a report, not a
  // linter: it never gates and exits 0 on success (2 on usage error). Shares
  // discovery, `--include`/`--exclude`, and `--since` narrowing with the root
  // sniff action so `rank` reflects the same file set you lint.
  program
    .command("rank")
    .argument("[paths...]", "file(s) or director(ies) to rank by token weight")
    .description(
      "list agent-context files heaviest-first by estimated token weight (offline)",
    )
    .option("--json", "emit a machine-readable JSON ranking instead of pretty output")
    .option(
      "--top <n>",
      "only show the <n> heaviest files (the total/average still reflect all files)",
      parseIntOption("top"),
    )
    .option(
      "--budget <n>",
      `flag files over <n> estimated tokens (default ${DEFAULT_TOKEN_BUDGET})`,
      parseIntOption("budget"),
    )
    .option(
      "--since [ref]",
      "only rank files changed vs <ref> (three-dot diff against HEAD); defaults to origin/main",
    )
    .option(
      "--include <formats>",
      `only rank these agent-context formats (repeatable/comma-separated: ${ALL_FORMATS.join(", ")})`,
      collectList,
    )
    .option(
      "--exclude <formats>",
      "skip these agent-context formats (repeatable/comma-separated)",
      collectList,
    )
    .action(async (paths: string[], _opts: RankOptions, command: Command) => {
      // The root (sniff) command also declares `--json`, which commander then
      // treats as a program-level global; that shadows the `rank` subcommand's
      // own `--json` in the plain action options. Reading options *with globals*
      // makes the subcommand see its flag regardless of the parent's. The other
      // flags (`--top`/`--budget`/`--since`/`--include`/`--exclude`) are unique
      // to `rank`, so they land here normally.
      const opts = command.optsWithGlobals() as RankOptions;

      if (!paths || paths.length === 0) {
        // `rank --since` with no path scans cwd, mirroring the sniff action.
        paths = ["."];
      }

      const selectorWarnings = validateFormatSelectors(opts);
      for (const w of selectorWarnings) {
        process.stderr.write(`${pc.yellow("warning:")} ${w}\n`);
      }

      const files = await discoverSkills(paths, {
        include: opts.include,
        exclude: opts.exclude,
      });

      const sinceActive = opts.since !== undefined;
      const scoped = sinceActive
        ? narrowToChanged(files, opts.since as string | boolean)
        : files;

      const skills = await parseSkills(scoped);
      const ranking = computeRanking(skills, {
        top: opts.top,
        budget: opts.budget,
      });

      if (opts.json) {
        process.stdout.write(
          renderRankingJson(ranking, getVersion(), {
            totalFiles: skills.length,
          }),
        );
      } else {
        process.stdout.write(
          renderRankingText(ranking, { totalFiles: skills.length }),
        );
      }

      // `rank` is a report: it never gates. Success is always EXIT.OK; a bad
      // `--since` ref throws out of narrowToChanged → EXIT.USAGE via run().
      setExit(program, EXIT.OK);
    });

  // `baseline [paths...]` — freeze a known-good state (issue #32). Lints the
  // discovered files, then writes a deterministic snapshot (per file: score,
  // content hash, finding fingerprints) so future `--baseline` runs gate only
  // on *regressions*, not pre-existing accepted debt. Reuses discovery,
  // `--include`/`--exclude`, and config exactly like the sniff action.
  program
    .command("baseline")
    .argument("[paths...]", "skill file(s) or director(ies) to snapshot")
    .description(
      "freeze a known-good baseline of current findings/scores (offline)",
    )
    .option(
      "--out <file>",
      `write the baseline to <file> (default ${DEFAULT_BASELINE_FILE})`,
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
    .option(
      "--config <path>",
      `use a specific ${".skillsnifferrc"} file instead of discovering one`,
    )
    .option("--no-config", "ignore any .skillsnifferrc and use built-in defaults")
    .action(
      async (
        paths: string[],
        _opts: unknown,
        command: Command,
      ) => {
        const opts = command.optsWithGlobals() as {
          out?: string;
          include?: string[];
          exclude?: string[];
          config?: string | false;
        };
        if (!paths || paths.length === 0) paths = ["."];

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
            `${pc.yellow("no skills found")} 🐕💨 (nothing to baseline)\n`,
          );
          setExit(program, EXIT.OK);
          return;
        }

        const skills = await parseSkills(files);
        const config = loadConfig(paths, {
          explicitPath:
            typeof opts.config === "string" ? opts.config : undefined,
          enabled: opts.config !== false,
        });
        const report = runEngine(skills, { config });
        const scored = scoreReport(
          report,
          skills.map((s) => s.path),
        );
        const raws: Record<string, string> = {};
        for (const s of skills) raws[s.path] = s.raw;

        const baseline = buildBaseline(scored, raws, getVersion());
        const outPath = opts.out ?? DEFAULT_BASELINE_FILE;
        writeBaseline(outPath, baseline);

        const fileCount = Object.keys(baseline.files).length;
        process.stdout.write(
          `${pc.green("baselined")} ${fileCount} file(s) → ${outPath} 🦴 (accepted debt frozen)\n`,
        );
        setExit(program, EXIT.OK);
      },
    );

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
      "--since [ref]",
      "only lint skill files changed vs <ref> (three-dot diff against HEAD); defaults to origin/main when no ref is given",
    )
    .option(
      "--baseline [file]",
      `diff findings against a baseline (default ${DEFAULT_BASELINE_FILE}); baselined findings drop to info, only new ones gate`,
    )
    .option(
      "--max-new-findings <n>",
      "with --baseline, exit non-zero if new (non-baselined) findings exceed <n> (default 0)",
      parseIntOption("max-new-findings"),
    )
    .option(
      "--max-score-drop <n>",
      "with --baseline, exit non-zero if any file's score drops more than <n> below baseline (default 0)",
      parseIntOption("max-score-drop"),
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
      "--watch",
      "re-sniff on save: stay up and re-run on file changes (Ctrl-C to stop); incompatible with --json/--sarif/--since",
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
        // Diff mode with no explicit path is a common, sensible invocation
        // (`skill-sniffer --since`): default to scanning the current directory
        // rather than showing help, so it lints whatever changed under cwd.
        // Watch mode (`skill-sniffer --watch`) defaults the same way.
        if (opts.since !== undefined || opts.watch) {
          paths = ["."];
        } else {
          // No paths and not diff mode: show help and exit cleanly.
          program.help();
          return;
        }
      }

      // --dry-run is only meaningful alongside --fix.
      if (opts.dryRun && !opts.fix) {
        throw new Error("--dry-run requires --fix");
      }

      // Watch mode (issue #28) is mutually exclusive with machine-output and
      // diff modes: a stream of JSON/SARIF on a clearing screen is nonsense,
      // and `--since` is a one-shot CI concept. Reject early with a clear
      // usage error (→ EXIT.USAGE) rather than silently ignoring a flag.
      if (opts.watch) {
        const conflicts: string[] = [];
        if (opts.json) conflicts.push("--json");
        if (opts.sarif !== undefined) conflicts.push("--sarif");
        if (opts.since !== undefined) conflicts.push("--since");
        if (opts.fix) conflicts.push("--fix");
        if (conflicts.length > 0) {
          throw new Error(
            `--watch cannot be combined with ${conflicts.join(", ")} ` +
              `(watch is an interactive, human-only mode)`,
          );
        }
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

      // Watch mode (issue #28): hand off to the interactive loop, which does
      // its own re-discovery each cycle and stays up until Ctrl-C. It never
      // gates, so this always resolves to EXIT.OK once the user stops it.
      if (opts.watch) {
        await runWatch(paths, opts);
        setExit(program, EXIT.OK);
        return;
      }

      const files = await discoverSkills(paths, {
        include: opts.include,
        exclude: opts.exclude,
      });

      // Diff mode (issue #23): narrow the discovered set to only files changed
      // vs the given ref. Runs after discovery so the glob + format filters are
      // already applied; the intersection can only ever remove files. A bad ref
      // or non-git dir throws → EXIT.USAGE, distinct from an empty changed set.
      const sinceActive = opts.since !== undefined;
      const scoped = sinceActive
        ? narrowToChanged(files, opts.since as string | boolean)
        : files;

      if (scoped.length === 0) {
        if (sinceActive && files.length > 0) {
          // Discovery found skills, but none of them changed vs the ref — a
          // clean, expected outcome for fast/pre-commit runs.
          const ref =
            typeof opts.since === "string" ? opts.since : "origin/main";
          process.stdout.write(
            `${pc.green("nothing changed to sniff")} 😴 (no skill files changed since ${ref})\n`,
          );
        } else {
          process.stdout.write(
            `${pc.yellow("no skills found")} 🐕💨 (looked for SKILL.md / *.skill.md / AGENTS.md / CLAUDE.md / .cursorrules / MCP manifests)\n`,
          );
        }
        setExit(program, EXIT.OK);
        return;
      }

      // --fix is its own action: mechanically clean safe findings, then exit.
      // It deliberately runs before (and instead of) the lint report so authors
      // get a focused "here's what I changed" view.
      if (opts.fix) {
        const results = await fixSkills(scoped, { dryRun: opts.dryRun });
        process.stdout.write(renderFixResults(results, opts.dryRun ?? false));
        setExit(program, fixExitCode(results));
        return;
      }

      const skills = await parseSkills(scoped);

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

      // Baseline diff (issue #32). When active, downgrade already-accepted
      // findings to info before reporting/gating, and surface new/fixed/drift.
      let baselineDiff: BaselineDiff | undefined;
      let effectiveScored = scored;
      if (opts.baseline !== undefined) {
        const baselinePath =
          typeof opts.baseline === "string"
            ? opts.baseline
            : DEFAULT_BASELINE_FILE;
        const baseline = loadBaseline(baselinePath); // throws → EXIT.USAGE
        const raws: Record<string, string> = {};
        for (const s of skills) raws[s.path] = s.raw;
        baselineDiff = diffBaseline(scored, raws, baseline);
        const applied = applyBaselineToFindings(scored.findings, baselineDiff);
        effectiveScored = scoreReport(
          { ...report, findings: applied.findings, counts: applied.counts },
          skills.map((s) => s.path),
        );
      }

      // SARIF output (issue #21). When a path is given, write there and still
      // print the human/JSON report to stdout; a bare `--sarif` streams SARIF
      // to stdout instead of the pretty/JSON report.
      const sarifToFile = typeof opts.sarif === "string";
      const sarifToStdout = opts.sarif === true;
      if (sarifToFile) {
        const sarif = renderSarif(effectiveScored.findings, getVersion());
        writeFileSync(opts.sarif as string, sarif, "utf8");
        process.stderr.write(
          `${pc.dim(`\u2192 wrote SARIF to ${opts.sarif as string}`)}\n`,
        );
      }

      if (sarifToStdout) {
        process.stdout.write(renderSarif(effectiveScored.findings, getVersion()));
      } else if (opts.json) {
        process.stdout.write(
          renderJson(
            effectiveScored,
            getVersion(),
            true,
            baselineDiff ? baselineJsonSection(baselineDiff) : undefined,
          ),
        );
      } else {
        process.stdout.write(renderConfigNotices(config));
        process.stdout.write(renderPretty(effectiveScored));
        if (baselineDiff) {
          process.stdout.write(renderBaselineNotices(baselineDiff));
        }
      }

      setExit(
        program,
        gateExitCode(
          effectiveScored.counts.error,
          effectiveScored,
          opts,
          config,
          baselineDiff,
        ),
      );
    });

  return program;
}

/**
 * Drive watch mode (issue #28) to completion. Starts the interactive watch
 * session over `paths`, then blocks until the user interrupts (SIGINT/Ctrl-C or
 * SIGTERM), at which point it closes every watcher and resolves cleanly. The
 * loop itself never gates on findings — the caller sets EXIT.OK unconditionally
 * once this returns.
 *
 * Kept thin: all the real logic (debounce, re-discovery, rendering) lives in
 * `watch.ts`; this only bridges the CLI process signals to the session handle.
 */
async function runWatch(paths: string[], opts: SniffOptions): Promise<void> {
  const handle = await startWatch(paths, {
    include: opts.include,
    exclude: opts.exclude,
  });

  await new Promise<void>((resolve) => {
    let done = false;
    const stop = () => {
      if (done) return;
      done = true;
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      // A trailing newline so the shell prompt starts on its own line after
      // the ^C, then tear down the watchers and resolve on clean shutdown.
      process.stdout.write("\n");
      handle.close();
      handle.closed.then(resolve);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
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
  baselineDiff?: BaselineDiff,
): number {
  const minScore = opts.minScore ?? config.minScore;
  const maxWarnings = opts.maxWarnings ?? config.maxWarnings;

  // Baseline gates (issue #32) fully own pass/fail when a baseline is active:
  // accepted debt is downgraded to info, so the only things that should gate
  // are *regressions* — new findings and score drops. The generic
  // error/min-score/max-warnings gates are bypassed so `--max-new-findings`
  // can deliberately tolerate a bounded number of new (error-severity) scents.
  if (baselineDiff) {
    const maxNew = opts.maxNewFindings ?? config.baselineMaxNewFindings ?? 0;
    const maxDrop = opts.maxScoreDrop ?? config.baselineMaxScoreDrop ?? 0;
    if (baselineDiff.totalNew > maxNew) return EXIT.FINDINGS;
    // worstScoreDrop is <= 0; a drop of D means the score fell |D|.
    if (-baselineDiff.worstScoreDrop > maxDrop) return EXIT.FINDINGS;
    return EXIT.OK;
  }

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
 * Render a short, human-facing summary of a baseline diff (issue #32): the
 * new/baselined/fixed tallies, any content drift, and the worst score drop.
 * Kept terse so it rides below the pretty report without drowning it.
 */
function renderBaselineNotices(diff: BaselineDiff): string {
  const lines: string[] = [];
  const parts: string[] = [];
  parts.push(
    diff.totalNew > 0
      ? pc.red(`${diff.totalNew} new`)
      : pc.green("0 new"),
  );
  parts.push(pc.dim(`${diff.totalBaselined} baselined`));
  if (diff.totalFixed > 0) parts.push(pc.green(`${diff.totalFixed} fixed`));
  if (diff.totalDrifted > 0) {
    parts.push(pc.yellow(`${diff.totalDrifted} drifted`));
  }
  lines.push(`${pc.bold("baseline:")} ${parts.join(pc.dim(", "))}`);

  // Call out drifted files explicitly — the "it mutated" signal.
  for (const f of diff.perFile) {
    if (f.drift === "drifted") {
      const added = f.newFindings.length;
      const tag =
        added > 0
          ? pc.yellow(`drifted (+${added} new finding${added === 1 ? "" : "s"})`)
          : pc.dim("drifted since baseline");
      lines.push(`  ${pc.dim("\u2022")} ${f.path} — ${tag}`);
    }
    if (f.scoreDelta < 0) {
      lines.push(
        `  ${pc.dim("\u2022")} ${f.path} — ${pc.red(`score ${f.scoreDelta} (${f.baselineScore} → ${f.currentScore})`)}`,
      );
    }
  }

  return lines.join("\n") + "\n";
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

/**
 * Resolve the changed-file subset for `--since` (issue #23).
 *
 * Given the already-discovered skill files (which have had the normal glob +
 * `--include`/`--exclude` filters applied) and the raw `--since` option value,
 * this figures out the ref, computes the git changed set relative to the repo
 * root, resolves those to absolute paths, and intersects. The intersection
 * guarantees only *changed, discovery-eligible* files survive.
 *
 * Errors are surfaced by throwing with a clear message so the CLI wrapper exits
 * {@link EXIT.USAGE} — deliberately distinct from the "nothing changed" case,
 * which returns an empty array (a normal exit 0 the caller reports on).
 */
function narrowToChanged(
  discovered: string[],
  sinceOpt: string | boolean,
): string[] {
  const ref = typeof sinceOpt === "string" ? sinceOpt : "origin/main";

  // Anchor the diff at the repo root so git's repo-relative paths resolve to
  // the same absolute paths discovery produced, regardless of cwd depth.
  const repoRoot = gitTopLevel();
  if (repoRoot === undefined) {
    throw new Error(
      `--since ${ref}: not a git repository (or any parent) — diff mode needs a git repo`,
    );
  }

  let changed: string[];
  try {
    changed = changedFilesSince(ref, { cwd: repoRoot });
  } catch (err) {
    if (err instanceof GitError) {
      if (err.kind === "bad-ref") {
        throw new Error(
          `--since ${ref}: ${err.message} — pass an existing ref (e.g. HEAD~1, a tag, or origin/main)`,
        );
      }
      throw new Error(`--since ${ref}: ${err.message}`);
    }
    throw err;
  }

  const changedAbsolute = changed.map((p) =>
    p.startsWith("/") ? p : resolvePath(repoRoot, p),
  );
  return intersectChanged(discovered, changedAbsolute);
}

/**
 * Absolute path to the git working-tree root for the current directory, or
 * `undefined` when not inside a repo. Used to anchor `--since` diffs so
 * repo-relative git paths line up with discovery's absolute paths.
 */
function gitTopLevel(): string | undefined {
  if (!isGitRepo()) return undefined;
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf8",
    }).trim();
  } catch {
    return undefined;
  }
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
