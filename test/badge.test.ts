import { describe, it, expect } from "vitest";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildBadge,
  colorForScore,
  renderBadgeJson,
  DEFAULT_BADGE_LABEL,
  SHIELDS_SCHEMA_VERSION,
} from "../src/badge.js";
import { buildProgram } from "../src/cli.js";

/**
 * Issue #38 — `skill-sniffer badge`, the Good Boy Score™ shields badge.
 *
 * Two layers, matching the codebase convention:
 *  1. Pure unit tests over buildBadge / colorForScore / renderBadgeJson.
 *  2. End-to-end CLI tests driving the program against a throwaway dir,
 *     asserting the emitted shields endpoint shape and `--out`.
 */

describe("badge — color thresholds", () => {
  it("maps scores to shields colors at each boundary", () => {
    expect(colorForScore(100)).toBe("brightgreen");
    expect(colorForScore(90)).toBe("brightgreen");
    expect(colorForScore(89)).toBe("green");
    expect(colorForScore(75)).toBe("green");
    expect(colorForScore(74)).toBe("yellow");
    expect(colorForScore(50)).toBe("yellow");
    expect(colorForScore(49)).toBe("orange");
    expect(colorForScore(25)).toBe("orange");
    expect(colorForScore(24)).toBe("red");
    expect(colorForScore(0)).toBe("red");
  });

  it("clamps out-of-range scores before coloring", () => {
    expect(colorForScore(150)).toBe("brightgreen");
    expect(colorForScore(-10)).toBe("red");
  });
});

describe("badge — payload shape", () => {
  it("produces a valid shields endpoint object", () => {
    const badge = buildBadge(92);
    expect(badge).toEqual({
      schemaVersion: SHIELDS_SCHEMA_VERSION,
      label: DEFAULT_BADGE_LABEL,
      message: "92/100",
      color: "brightgreen",
    });
  });

  it("honors a custom label", () => {
    expect(buildBadge(40, "skills").label).toBe("skills");
  });

  it("rounds and clamps the message", () => {
    expect(buildBadge(100.4).message).toBe("100/100");
    expect(buildBadge(120).message).toBe("100/100");
    expect(buildBadge(-5).message).toBe("0/100");
  });

  it("renders pretty JSON with a trailing newline", () => {
    const json = renderBadgeJson(buildBadge(75));
    expect(json.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(json);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.message).toBe("75/100");
    expect(parsed.color).toBe("green");
  });
});

describe("badge — CLI", () => {
  async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = mkdtempSync(join(tmpdir(), "ss-badge-"));
    try {
      return await fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  async function runBadge(args: string[]): Promise<string> {
    const program = buildProgram();
    let out = "";
    const original = process.stdout.write.bind(process.stdout);
    // @ts-expect-error narrow override for test capture
    process.stdout.write = (chunk: string) => {
      out += chunk;
      return true;
    };
    try {
      await program.parseAsync(["node", "skill-sniffer", "badge", ...args]);
    } finally {
      process.stdout.write = original;
    }
    return out;
  }

  it("emits a shields endpoint JSON for a clean skill (100/100)", async () => {
    await withDir(async (dir) => {
      const skillDir = join(dir, "clean");
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(
        join(skillDir, "SKILL.md"),
        `---\nname: clean\ndescription: A tidy, well-behaved skill file for testing.\n---\n\n# Clean\n\nNothing to sniff here.\n`,
        "utf8",
      );

      const out = await runBadge([skillDir]);
      const parsed = JSON.parse(out);
      expect(parsed.schemaVersion).toBe(1);
      expect(parsed.label).toBe(DEFAULT_BADGE_LABEL);
      expect(parsed.message).toBe("100/100");
      expect(parsed.color).toBe("brightgreen");
    });
  });

  it("writes the badge JSON to --out and prints nothing to stdout", async () => {
    await withDir(async (dir) => {
      const skillDir = join(dir, "clean");
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(
        join(skillDir, "SKILL.md"),
        `---\nname: clean\ndescription: A tidy, well-behaved skill file for testing.\n---\n\n# Clean\n`,
        "utf8",
      );
      const outFile = join(dir, "badge.json");

      const stdout = await runBadge([skillDir, "--out", outFile, "--label", "hygiene"]);
      expect(stdout).toBe("");
      expect(existsSync(outFile)).toBe(true);
      const parsed = JSON.parse(readFileSync(outFile, "utf8"));
      expect(parsed.label).toBe("hygiene");
      expect(parsed.message).toBe("100/100");
    });
  });
});
