import { Command } from "commander";
import pc from "picocolors";
import { getVersion } from "./version.js";

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
    .action((paths: string[]) => {
      if (!paths || paths.length === 0) {
        // No paths: show help and exit cleanly. (Real sniffing arrives in M2+.)
        program.help();
        return;
      }

      for (const p of paths) {
        // M1 hello-world behavior. M2 replaces this with real discovery+parse.
        process.stdout.write(`${pc.cyan("sniffed:")} ${p} 🐕\n`);
      }
    });

  return program;
}

/**
 * Run the CLI. Returns the intended process exit code (0 on success) so the
 * thin bin wrapper and tests can decide what to do with it.
 */
export function run(argv: string[] = process.argv): number {
  const program = buildProgram();
  try {
    program.parse(argv);
    return 0;
  } catch (err) {
    process.stderr.write(`${pc.red("error:")} ${(err as Error).message}\n`);
    return 1;
  }
}
