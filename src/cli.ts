import { Command } from "commander";
import pc from "picocolors";
import { getVersion } from "./version.js";
import { discoverSkills } from "./discover.js";
import { parseSkills } from "./parse.js";
import { runEngine } from "./engine.js";
import { renderPretty } from "./report/pretty.js";

/**
 * Build the commander program. Kept as a factory so tests can construct a
 * fresh instance and override exit/output behavior.
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
    .action(async (paths: string[]) => {
      if (!paths || paths.length === 0) {
        // No paths: show help and exit cleanly. (Real linting arrives in M3+.)
        program.help();
        return;
      }

      const files = await discoverSkills(paths);
      if (files.length === 0) {
        process.stdout.write(
          `${pc.yellow("no skills found")} 🐕💨 (looked for SKILL.md / *.skill.md)\n`,
        );
        return;
      }

      const skills = await parseSkills(files);
      const report = runEngine(skills);
      process.stdout.write(renderPretty(report));
    });

  return program;
}

/**
 * Run the CLI. Returns the intended process exit code (0 on success) so the
 * thin bin wrapper and tests can decide what to do with it. Async because the
 * action performs file discovery + parsing.
 */
export async function run(argv: string[] = process.argv): Promise<number> {
  const program = buildProgram();
  try {
    await program.parseAsync(argv);
    return 0;
  } catch (err) {
    process.stderr.write(`${pc.red("error:")} ${(err as Error).message}\n`);
    return 1;
  }
}
