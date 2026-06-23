import { Command } from "commander";
import pc from "picocolors";
import { getVersion } from "./version.js";
import { discoverSkills } from "./discover.js";
import { parseSkills } from "./parse.js";
import type { ParsedSkill } from "./types.js";

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
      reportDiscovered(skills);
    });

  return program;
}

/**
 * M2 report: list each discovered skill, confirm it parsed, and show a tiny
 * frontmatter peek. Malformed/unreadable files are flagged but never crash
 * the run. (M3 replaces this with the real rule-engine report.)
 */
function reportDiscovered(skills: ParsedSkill[]): void {
  const ok = skills.filter((s) => !s.error).length;
  const bad = skills.length - ok;

  for (const skill of skills) {
    if (skill.error) {
      process.stdout.write(
        `${pc.red("✗")} ${skill.path} — ${pc.red(skill.error)} 🐕👅\n`,
      );
      continue;
    }

    const keys = Object.keys(skill.frontmatter);
    const meta =
      keys.length > 0
        ? pc.dim(`[${keys.join(", ")}]`)
        : pc.dim("(no frontmatter)");
    process.stdout.write(`${pc.green("sniffed:")} ${skill.path} ${meta} 🐕\n`);
  }

  const summary = `${ok} parsed` + (bad > 0 ? `, ${bad} with problems` : "");
  process.stdout.write(pc.cyan(`\n${skills.length} skill(s) — ${summary}.\n`));
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
