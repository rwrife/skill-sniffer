import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { checkCompatibility, loadHostProfiles } from "../src/compat.js";
import { renderCompatibilityJson, renderCompatibilityText } from "../src/report/compat.js";
import { parseSkill } from "../src/parse.js";
import { run } from "../src/cli.js";
import type { ParsedSkill } from "../src/types.js";

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(raw: string, filename = "SKILL.md"): string {
  const dir = mkdtempSync(join(tmpdir(), "sniff-compat-"));
  dirs.push(dir);
  const path = join(dir, filename);
  writeFileSync(path, raw);
  return path;
}

function skill(frontmatter: Record<string, unknown>, raw = "Small body"): ParsedSkill {
  return { path: join(process.cwd(), "example", "SKILL.md"), frontmatter, raw, body: raw };
}

async function cli(args: string[]) {
  let stdout = "";
  let stderr = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr += String(chunk);
    return true;
  });
  const code = await run(["node", "skill-sniffer", "compat", ...args]);
  vi.restoreAllMocks();
  return { code, stdout, stderr };
}

describe("compatibility profiles and engine", () => {
  it("passes Claude's optional-name contract but fails Codex and Copilot", () => {
    const report = checkCompatibility([skill({ description: "Summarize changes." })]);
    expect(report.skills[0].hosts.map((h) => [h.host, h.status])).toEqual([
      ["claude-code", "pass"], ["codex", "fail"], ["copilot", "fail"], ["openclaw", "pass"],
    ]);
    expect(report.skills[0].hosts[1].report.findings[0]).toMatchObject({
      ruleId: "frontmatter", severity: "error", message: expect.stringContaining("`name`"),
    });
  });

  it("distinguishes known extensions, undocumented keys, and advisory description limits", () => {
    const profiles = loadHostProfiles("claude-code");
    const check = (frontmatter: Record<string, unknown>) =>
      checkCompatibility([skill(frontmatter)], profiles).skills[0].hosts[0];
    expect(check({ description: "x".repeat(1536) }).status).toBe("pass");
    expect(check({ description: "x".repeat(1537) }).status).toBe("warn");
    expect(check({ description: "x".repeat(1500), when_to_use: "x".repeat(40) }).status).toBe("warn");
    expect(check({ description: "Short", "disable-model-invocation": true }).status).toBe("pass");
    expect(check({ description: "Short", unsupported: true }).status).toBe("warn");
    expect(check({ description: "😀".repeat(1536) }).status).toBe("pass");
  });

  it("warns rather than inventing host rejections at spec limits", () => {
    const profiles = loadHostProfiles("copilot");
    for (const [length, expected] of [[1024, "pass"], [1025, "warn"]] as const) {
      expect(checkCompatibility([skill({ name: "example", description: "x".repeat(length) })],
        profiles).skills[0].hosts[0].status).toBe(expected);
    }
    const host = checkCompatibility([
      skill({ name: "example", description: "Short" }, "x".repeat(20001)),
    ], profiles).skills[0].hosts[0];
    expect(host.status).toBe("warn");
    expect(host.report.findings).toContainEqual(expect.objectContaining({ ruleId: "token-bloat" }));
  });

  it("supports declarative forbidden keys and UTF-8 byte rejection limits", () => {
    const profile = { ...loadHostProfiles("codex")[0], maxBytes: 4, forbiddenFrontmatterKeys: ["secret"] };
    const report = checkCompatibility([skill({ name: "example", description: "Short", secret: true }, "ééé")],
      [profile]);
    expect(report.skills[0].hosts[0].report.counts.error).toBe(2);
    expect(report.skills[0].hosts[0].status).toBe("fail");
  });

  it("reports malformed YAML without making Claude's fallback a rejection", async () => {
    const parsed = await parseSkill(fixture("---\nname: [broken\n---\nBody"));
    const hosts = checkCompatibility([parsed]).skills[0].hosts;
    expect(hosts[0].status).toBe("warn");
    expect(hosts[1].status).toBe("fail");
    expect(hosts[1].report.findings).toHaveLength(1);
  });

  it("fails unreadable skills even on hosts with YAML fallbacks", async () => {
    const path = fixture("Body");
    const parsed = await parseSkill(join(path, "missing"));
    expect(checkCompatibility([parsed]).skills[0].hosts.every((h) => h.status === "fail")).toBe(true);
  });

  it("rejects filenames that the linter accepts but hosts do not discover", async () => {
    const parsed = await parseSkill(fixture("---\nname: example\ndescription: Short\n---\nBody", "demo.skill.md"));
    expect(checkCompatibility([parsed]).skills[0].hosts.every((h) => h.status === "fail")).toBe(true);
  });
});

describe("compat CLI and reporting", () => {
  it("filters hosts, emits versioned JSON with sources and unknowns, and gates selected failures", async () => {
    const path = fixture("---\ndescription: Summarize changes.\n---\nBody");
    const claude = await cli([path, "--host", "claude-code", "--json"]);
    expect(claude.code).toBe(0);
    const json = JSON.parse(claude.stdout);
    expect(json.schema).toBe("skill-sniffer/compat@1");
    expect(json.profiles).toHaveLength(1);
    expect(json.profiles[0]).toMatchObject({ maxBytes: null, sources: expect.any(Array) });
    expect(json.skills[0].hosts).toHaveLength(1);
    expect((await cli([path, "--json"])).code).toBe(1);
    expect((await cli([path, "--host", "codex"])).code).toBe(1);
  });

  it("prints a per-skill matrix from a directory, including hidden roots but not other formats", async () => {
    const path = fixture("---\nname: example\ndescription: Short\n---\nBody");
    const dir = dirs[dirs.length - 1];
    const hidden = join(dir, ".github", "skills", "nested");
    mkdirSync(hidden, { recursive: true });
    writeFileSync(join(hidden, "SKILL.md"), "---\ndescription: Short\n---\nBody");
    writeFileSync(join(dir, "AGENTS.md"), "Not a skill");
    const result = await cli([dir]);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("claude-code | codex | copilot | openclaw");
    expect(result.stdout).toContain("pass | fail | fail | pass");
    expect(result.stdout).toContain(relative(process.cwd(), path));
    expect(result.stdout).not.toContain("AGENTS.md");
  });

  it("exits zero for advisory-only results and ignores lint rule disabling", async () => {
    const path = fixture(`---\nname: example\ndescription: ${"x".repeat(1025)}\n---\nBody`);
    writeFileSync(join(dirs[dirs.length - 1], ".skillsnifferrc"),
      JSON.stringify({ rules: { frontmatter: "off", "host-profile": "off" } }));
    const warning = await cli([path, "--host", "copilot", "--json"]);
    expect(warning.code).toBe(0);
    expect(JSON.parse(warning.stdout).skills[0].hosts[0].status).toBe("warn");
    writeFileSync(path, "---\ndescription: Short\n---\nBody");
    expect((await cli([path, "--host", "copilot"])).code).toBe(1);
  });

  it("returns usage errors for unknown hosts and missing or skill-free paths", async () => {
    const path = fixture("Body");
    const unknown = await cli([path, "--host", "typo"]);
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain("unknown host");
    const missing = await cli([join(dirs[dirs.length - 1], "missing")]);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain("no skill files found");
  });

  it("includes reasons and caveats in both renderers", () => {
    const report = checkCompatibility([skill({ description: "Short" })]);
    expect(renderCompatibilityText(report)).toContain("missing required frontmatter field `name`");
    expect(renderCompatibilityText(report)).toContain("not a host load guarantee");
    expect(JSON.parse(renderCompatibilityJson(report)).profiles[0].notes).toContain("No verified");
  });
});
