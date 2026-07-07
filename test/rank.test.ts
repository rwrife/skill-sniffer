import { describe, it, expect } from "vitest";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeRanking,
  renderRankingText,
  renderRankingJson,
  RANK_SCHEMA,
  type Ranking,
} from "../src/rank.js";
import { estimateTokens } from "../src/rules/token-bloat.js";
import type { ParsedSkill } from "../src/types.js";
import { run } from "../src/cli.js";

/**
 * Issue #27 — `skill-sniffer rank`, the token-weight leaderboard.
 *
 * Two layers, matching the codebase convention (see explain/since tests):
 *  1. Pure unit tests over `computeRanking` + the render helpers (no I/O).
 *  2. End-to-end CLI tests driving `run()` against a throwaway directory,
 *     which exercises discovery, `--include`/`--exclude`, `--top`, `--budget`,
 *     `--json`, and the empty case exactly as a shell would.
 */

/** Strip ANSI so assertions match plain text regardless of TTY color support. */
function plain(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;]*m/g, "");
}

/** Build a minimal ParsedSkill whose `raw` body has a known token weight. */
function skillOf(path: string, raw: string): ParsedSkill {
  return { path, frontmatter: {}, body: raw, raw };
}

/** `raw` text of a target estimated-token weight (chars/4 heuristic). */
function textOfTokens(tokens: number): string {
  return "x".repeat(tokens * 4);
}

describe("rank command (issue #27)", () => {
  describe("computeRanking() core", () => {
    it("sorts entries heaviest-first by estimated tokens", () => {
      const skills = [
        skillOf("/a.md", textOfTokens(100)),
        skillOf("/b.md", textOfTokens(500)),
        skillOf("/c.md", textOfTokens(300)),
      ];
      const r = computeRanking(skills);
      expect(r.entries.map((e) => e.path)).toEqual(["/b.md", "/c.md", "/a.md"]);
      expect(r.entries.map((e) => e.tokens)).toEqual([500, 300, 100]);
    });

    it("uses the same estimate as the token-bloat rule", () => {
      const raw = "hello world, this is a skill body";
      const r = computeRanking([skillOf("/x.md", raw)]);
      expect(r.entries[0].tokens).toBe(estimateTokens(raw));
    });

    it("breaks token ties by path for a deterministic order", () => {
      const skills = [
        skillOf("/z.md", textOfTokens(200)),
        skillOf("/a.md", textOfTokens(200)),
        skillOf("/m.md", textOfTokens(200)),
      ];
      const r = computeRanking(skills);
      expect(r.entries.map((e) => e.path)).toEqual(["/a.md", "/m.md", "/z.md"]);
    });

    it("computes total and floored average across all files", () => {
      const skills = [
        skillOf("/a.md", textOfTokens(100)),
        skillOf("/b.md", textOfTokens(101)),
      ];
      const r = computeRanking(skills);
      expect(r.total).toBe(201);
      expect(r.average).toBe(100); // floor(201 / 2)
    });

    it("counts files strictly over the budget", () => {
      const skills = [
        skillOf("/a.md", textOfTokens(2000)), // exactly budget → not over
        skillOf("/b.md", textOfTokens(2001)), // over
        skillOf("/c.md", textOfTokens(5000)), // over
      ];
      const r = computeRanking(skills); // default budget 2000
      expect(r.budget).toBe(2000);
      expect(r.overBudgetCount).toBe(2);
    });

    it("honors a custom budget", () => {
      const skills = [skillOf("/a.md", textOfTokens(150))];
      expect(computeRanking(skills, { budget: 100 }).overBudgetCount).toBe(1);
      expect(computeRanking(skills, { budget: 200 }).overBudgetCount).toBe(0);
    });

    it("caps the list with --top but keeps totals over all files", () => {
      const skills = [
        skillOf("/a.md", textOfTokens(100)),
        skillOf("/b.md", textOfTokens(500)),
        skillOf("/c.md", textOfTokens(300)),
      ];
      const r = computeRanking(skills, { top: 2 });
      expect(r.entries.map((e) => e.path)).toEqual(["/b.md", "/c.md"]);
      expect(r.entries).toHaveLength(2);
      // Total/average still reflect all three files, not just the top two.
      expect(r.total).toBe(900);
      expect(r.average).toBe(300);
    });

    it("ignores a non-positive --top (shows everything)", () => {
      const skills = [
        skillOf("/a.md", textOfTokens(100)),
        skillOf("/b.md", textOfTokens(200)),
      ];
      expect(computeRanking(skills, { top: 0 }).entries).toHaveLength(2);
      expect(computeRanking(skills, { top: -5 }).entries).toHaveLength(2);
    });

    it("handles the empty set with zeroed roll-ups", () => {
      const r = computeRanking([]);
      expect(r.entries).toEqual([]);
      expect(r.total).toBe(0);
      expect(r.average).toBe(0);
      expect(r.overBudgetCount).toBe(0);
    });
  });

  describe("renderRankingText()", () => {
    const ranking: Ranking = {
      entries: [
        { path: "/repo/heavy/SKILL.md", tokens: 5000 },
        { path: "/repo/light/SKILL.md", tokens: 100 },
      ],
      total: 5100,
      average: 2550,
      budget: 2000,
      overBudgetCount: 1,
    };

    it("lists files with weights and an over-budget flag", () => {
      const text = plain(renderRankingText(ranking, { cwd: "/repo" }));
      expect(text).toContain("~5000");
      expect(text).toContain("heavy/SKILL.md");
      expect(text).toContain("over budget");
      // The light file is under budget → no flag on its line.
      const lightLine = text
        .split("\n")
        .find((l) => l.includes("light/SKILL.md"))!;
      expect(lightLine).not.toContain("over budget");
    });

    it("summarizes count, total, average, and heaviest", () => {
      const text = plain(renderRankingText(ranking, { cwd: "/repo" }));
      expect(text).toContain("2 file(s)");
      expect(text).toContain("~5100 tokens total");
      expect(text).toContain("~2550 avg");
      expect(text).toContain("Heaviest:");
      expect(text).toContain("heavy/SKILL.md");
    });

    it("notes hidden rows when the list was capped", () => {
      const capped: Ranking = {
        ...ranking,
        entries: ranking.entries.slice(0, 1),
      };
      const text = plain(
        renderRankingText(capped, { cwd: "/repo", totalFiles: 2 }),
      );
      expect(text).toContain("and 1 more");
      // Summary still reports the true file count.
      expect(text).toContain("2 file(s)");
    });

    it("prints a friendly note for an empty ranking", () => {
      const empty: Ranking = {
        entries: [],
        total: 0,
        average: 0,
        budget: 2000,
        overBudgetCount: 0,
      };
      const text = plain(renderRankingText(empty, { totalFiles: 0 }));
      expect(text.toLowerCase()).toContain("nothing to rank");
    });
  });

  describe("renderRankingJson()", () => {
    it("emits a stable, schema-versioned payload with absolute paths", () => {
      const ranking: Ranking = {
        entries: [{ path: "/abs/a.md", tokens: 42 }],
        total: 42,
        average: 42,
        budget: 2000,
        overBudgetCount: 0,
      };
      const json = JSON.parse(
        renderRankingJson(ranking, "9.9.9", { totalFiles: 1 }),
      );
      expect(json.schema).toBe(RANK_SCHEMA);
      expect(json.schema).toBe("skill-sniffer/rank@1");
      expect(json.version).toBe("9.9.9");
      expect(json.budget).toBe(2000);
      expect(json.total).toBe(42);
      expect(json.average).toBe(42);
      expect(json.overBudgetCount).toBe(0);
      expect(json.filesRanked).toBe(1);
      expect(json.entries).toEqual([{ path: "/abs/a.md", tokens: 42 }]);
    });

    it("reports filesRanked separately from shown entries (with --top)", () => {
      const capped: Ranking = {
        entries: [{ path: "/abs/heavy.md", tokens: 999 }],
        total: 1099,
        average: 549,
        budget: 2000,
        overBudgetCount: 0,
      };
      const json = JSON.parse(
        renderRankingJson(capped, "0.0.0", { totalFiles: 2 }),
      );
      expect(json.filesRanked).toBe(2);
      expect(json.entries).toHaveLength(1);
    });
  });

  describe("rank via the CLI", () => {
    it("ranks a directory heaviest-first and exits 0", async () => {
      const dir = mkdtempSync(join(tmpdir(), "sniff-rank-"));
      try {
        mkdirSync(join(dir, "big"), { recursive: true });
        mkdirSync(join(dir, "small"), { recursive: true });
        writeFileSync(join(dir, "big", "SKILL.md"), textOfTokens(3000));
        writeFileSync(join(dir, "small", "SKILL.md"), textOfTokens(50));

        const out = await runCli(["rank", dir]);
        expect(out.code).toBe(0);
        const text = plain(out.stdout);
        // Heaviest file appears before the lighter one.
        expect(text.indexOf("big/SKILL.md")).toBeLessThan(
          text.indexOf("small/SKILL.md"),
        );
        expect(text).toContain("2 file(s)");
        expect(text).toContain("over budget"); // big is over the 2000 default
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("emits JSON with --json even though the root command also has --json", async () => {
      // Regression: the root sniff command declares --json, which commander
      // promotes to a global; the rank action must still see its own flag.
      const dir = mkdtempSync(join(tmpdir(), "sniff-rank-json-"));
      try {
        writeFileSync(join(dir, "SKILL.md"), textOfTokens(200));
        const out = await runCli(["rank", dir, "--json"]);
        expect(out.code).toBe(0);
        const json = JSON.parse(out.stdout);
        expect(json.schema).toBe("skill-sniffer/rank@1");
        expect(json.filesRanked).toBe(1);
        expect(json.entries[0].tokens).toBe(200);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("caps output with --top but totals reflect all files", async () => {
      const dir = mkdtempSync(join(tmpdir(), "sniff-rank-top-"));
      try {
        for (const [name, tok] of [
          ["a", 100],
          ["b", 200],
          ["c", 300],
        ] as const) {
          mkdirSync(join(dir, name), { recursive: true });
          writeFileSync(join(dir, name, "SKILL.md"), textOfTokens(tok));
        }
        const out = await runCli(["rank", dir, "--top", "1", "--json"]);
        const json = JSON.parse(out.stdout);
        expect(json.entries).toHaveLength(1);
        expect(json.entries[0].tokens).toBe(300); // heaviest
        expect(json.filesRanked).toBe(3);
        expect(json.total).toBe(600); // all three
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("respects a custom --budget for the over-budget flag", async () => {
      const dir = mkdtempSync(join(tmpdir(), "sniff-rank-budget-"));
      try {
        writeFileSync(join(dir, "SKILL.md"), textOfTokens(150));
        const under = JSON.parse(
          (await runCli(["rank", dir, "--json", "--budget", "500"])).stdout,
        );
        expect(under.overBudgetCount).toBe(0);
        const over = JSON.parse(
          (await runCli(["rank", dir, "--json", "--budget", "100"])).stdout,
        );
        expect(over.overBudgetCount).toBe(1);
        expect(over.budget).toBe(100);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("honors --include / --exclude format selection", async () => {
      const dir = mkdtempSync(join(tmpdir(), "sniff-rank-fmt-"));
      try {
        writeFileSync(join(dir, "SKILL.md"), textOfTokens(80));
        writeFileSync(join(dir, "AGENTS.md"), textOfTokens(90));

        const skillOnly = JSON.parse(
          (await runCli(["rank", dir, "--json", "--include", "skill"])).stdout,
        );
        expect(skillOnly.filesRanked).toBe(1);
        expect(skillOnly.entries[0].path).toMatch(/SKILL\.md$/);

        const noAgents = JSON.parse(
          (await runCli(["rank", dir, "--json", "--exclude", "agents"])).stdout,
        );
        expect(noAgents.filesRanked).toBe(1);
        expect(noAgents.entries[0].path).toMatch(/SKILL\.md$/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("prints a friendly note (exit 0) when nothing is found", async () => {
      const dir = mkdtempSync(join(tmpdir(), "sniff-rank-empty-"));
      try {
        const out = await runCli(["rank", dir]);
        expect(out.code).toBe(0);
        expect(plain(out.stdout).toLowerCase()).toContain("nothing to rank");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("emits a valid empty JSON payload when nothing is found", async () => {
      const dir = mkdtempSync(join(tmpdir(), "sniff-rank-empty-json-"));
      try {
        const out = await runCli(["rank", dir, "--json"]);
        expect(out.code).toBe(0);
        const json = JSON.parse(out.stdout);
        expect(json.filesRanked).toBe(0);
        expect(json.entries).toEqual([]);
        expect(json.total).toBe(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("errors (exit 2) on a bad --since ref", async () => {
      const out = await runCli(["rank", ".", "--since", "no-such-ref-zzz"]);
      expect(out.code).toBe(2);
      expect(out.stderr.toLowerCase()).toContain("git ref");
    });
  });
});

/**
 * Drive the real CLI entry point ({@link run}), capturing stdout/stderr and the
 * returned exit code — the same harness the `--since` suite uses. Mirrors what a
 * shell observes, including the try/catch that maps thrown errors to EXIT.USAGE.
 */
async function runCli(
  argv: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  let stdout = "";
  let stderr = "";
  const outOrig = process.stdout.write.bind(process.stdout);
  const errOrig = process.stderr.write.bind(process.stderr);
  // @ts-expect-error test capture
  process.stdout.write = (c: string) => ((stdout += c), true);
  // @ts-expect-error test capture
  process.stderr.write = (c: string) => ((stderr += c), true);
  let code = 0;
  try {
    code = await run(["node", "skill-sniffer", ...argv]);
  } finally {
    process.stdout.write = outOrig;
    process.stderr.write = errOrig;
  }
  return { stdout, stderr, code };
}
