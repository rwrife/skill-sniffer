import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import {
  classifyFormat,
  isKnownFormat,
  isSkillFormat,
  resolveFormats,
  canonicalFormat,
  ALL_FORMATS,
  FORMAT_GLOBS,
} from "../src/format.js";
import { discoverSkills } from "../src/discover.js";
import { parseSkill } from "../src/parse.js";
import { runEngine } from "../src/engine.js";
import { frontmatterRule } from "../src/rules/index.js";
import type { ParsedSkill, RuleContext, SkillFormat } from "../src/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const formatsDir = join(here, "fixtures", "formats");
const skillFile = join(formatsDir, "skill", "SKILL.md");
const agentsFile = join(formatsDir, "agents", "AGENTS.md");
const claudeFile = join(formatsDir, "claude", "CLAUDE.md");
const cursorFile = join(formatsDir, "cursor", ".cursorrules");
const mcpFile = join(formatsDir, "mcp", "example.mcp.json");

/** A throwaway context that just echoes the chosen/default severity. */
const ctx: RuleContext = {
  severityFor: (rule, fallback) => fallback ?? rule.defaultSeverity,
};

/** Build a minimal in-memory skill of a given format for unit tests. */
function makeSkill(
  format: SkillFormat | undefined,
  frontmatter: Record<string, unknown> = {},
  body = "# body",
): ParsedSkill {
  return { path: `/virtual/thing`, format, frontmatter, body, raw: body };
}

describe("classifyFormat", () => {
  it("recognizes the native skill format", () => {
    expect(classifyFormat("a/b/SKILL.md")).toBe("skill");
    expect(classifyFormat("SKILL.md")).toBe("skill");
    expect(classifyFormat("a/deep.skill.md")).toBe("skill");
    expect(classifyFormat("a/Deep.SKILL.md")).toBe("skill");
  });

  it("recognizes AGENTS.md and CLAUDE.md (case-insensitive, any depth)", () => {
    expect(classifyFormat("AGENTS.md")).toBe("agents");
    expect(classifyFormat("packages/x/agents.md")).toBe("agents");
    expect(classifyFormat("CLAUDE.md")).toBe("claude");
    expect(classifyFormat("nested/Claude.MD")).toBe("claude");
  });

  it("recognizes .cursorrules and .cursor/rules/*.mdc", () => {
    expect(classifyFormat(".cursorrules")).toBe("cursorrules");
    expect(classifyFormat("repo/.cursorrules")).toBe("cursorrules");
    expect(classifyFormat("repo/.cursor/rules/style.mdc")).toBe("cursorrules");
    // A .mdc outside .cursor/rules is NOT a cursor rule.
    expect(classifyFormat("docs/notes.mdc")).toBe("unknown");
  });

  it("recognizes MCP manifests", () => {
    expect(classifyFormat("mcp.json")).toBe("mcp");
    expect(classifyFormat("servers/example.mcp.json")).toBe("mcp");
  });

  it("normalizes backslash (Windows) paths", () => {
    expect(classifyFormat("a\\b\\SKILL.md")).toBe("skill");
    expect(classifyFormat("repo\\.cursor\\rules\\x.mdc")).toBe("cursorrules");
  });

  it("returns 'unknown' for anything else", () => {
    expect(classifyFormat("README.md")).toBe("unknown");
    expect(classifyFormat("a/skillful.md")).toBe("unknown");
    expect(classifyFormat("package.json")).toBe("unknown");
  });
});

describe("isKnownFormat / isSkillFormat", () => {
  it("isKnownFormat is true for every non-unknown format", () => {
    expect(isKnownFormat("SKILL.md")).toBe(true);
    expect(isKnownFormat("AGENTS.md")).toBe(true);
    expect(isKnownFormat("example.mcp.json")).toBe(true);
    expect(isKnownFormat("README.md")).toBe(false);
  });

  it("isSkillFormat only for the native skill (undefined ⇒ skill)", () => {
    expect(isSkillFormat("skill")).toBe(true);
    expect(isSkillFormat(undefined)).toBe(true);
    expect(isSkillFormat("agents")).toBe(false);
    expect(isSkillFormat("mcp")).toBe(false);
  });
});

describe("canonicalFormat (aliases)", () => {
  it("maps friendly aliases to canonical ids", () => {
    expect(canonicalFormat("skills")).toBe("skill");
    expect(canonicalFormat("agents.md")).toBe("agents");
    expect(canonicalFormat("cursor")).toBe("cursorrules");
    expect(canonicalFormat(".cursorrules")).toBe("cursorrules");
    expect(canonicalFormat("MCP")).toBe("mcp");
    expect(canonicalFormat("  Claude  ")).toBe("claude");
  });

  it("returns undefined for unknown selectors", () => {
    expect(canonicalFormat("nonsense")).toBeUndefined();
    expect(canonicalFormat("")).toBeUndefined();
  });
});

describe("resolveFormats (--include / --exclude)", () => {
  it("defaults to all formats when no selectors are given", () => {
    expect(resolveFormats({})).toEqual([...ALL_FORMATS]);
  });

  it("include narrows to the named formats (canonical order preserved)", () => {
    expect(resolveFormats({ include: ["agents", "skill"] })).toEqual([
      "skill",
      "agents",
    ]);
  });

  it("exclude removes formats from the default set", () => {
    const got = resolveFormats({ exclude: ["mcp", "cursor"] });
    expect(got).not.toContain("mcp");
    expect(got).not.toContain("cursorrules");
    expect(got).toContain("skill");
  });

  it("exclude wins over include for the same format", () => {
    expect(
      resolveFormats({ include: ["skill", "agents"], exclude: ["agents"] }),
    ).toEqual(["skill"]);
  });

  it("ignores unknown selector names", () => {
    expect(resolveFormats({ include: ["skill", "bogus"] })).toEqual(["skill"]);
  });
});

describe("FORMAT_GLOBS", () => {
  it("has a glob list for every discoverable format", () => {
    for (const fmt of ALL_FORMATS) {
      expect(FORMAT_GLOBS[fmt].length).toBeGreaterThan(0);
    }
  });
});

describe("discoverSkills — multi-format", () => {
  it("finds every known format by default", async () => {
    const found = await discoverSkills([formatsDir]);
    expect(found).toContain(resolve(skillFile));
    expect(found).toContain(resolve(agentsFile));
    expect(found).toContain(resolve(claudeFile));
    expect(found).toContain(resolve(cursorFile));
    expect(found).toContain(resolve(mcpFile));
  });

  it("--include restricts discovery to the named formats", async () => {
    const found = await discoverSkills([formatsDir], {
      include: ["agents", "claude"],
    });
    expect(found).toEqual(
      [resolve(agentsFile), resolve(claudeFile)].sort(),
    );
  });

  it("--exclude drops the named formats", async () => {
    const found = await discoverSkills([formatsDir], {
      include: ["skill", "mcp"],
      exclude: ["mcp"],
    });
    expect(found).toEqual([resolve(skillFile)]);
  });

  it("accepts a directly-passed non-skill format file", async () => {
    const found = await discoverSkills([agentsFile]);
    expect(found).toEqual([resolve(agentsFile)]);
  });

  it("filters a directly-passed file that isn't in the selected set", async () => {
    const found = await discoverSkills([mcpFile], { include: ["skill"] });
    expect(found).toEqual([]);
  });
});

describe("parseSkill — format tagging", () => {
  it("tags each parsed file with its detected format", async () => {
    expect((await parseSkill(skillFile)).format).toBe("skill");
    expect((await parseSkill(agentsFile)).format).toBe("agents");
    expect((await parseSkill(claudeFile)).format).toBe("claude");
    expect((await parseSkill(cursorFile)).format).toBe("cursorrules");
    expect((await parseSkill(mcpFile)).format).toBe("mcp");
  });
});

describe("frontmatter rule — graceful degradation by format", () => {
  it("still enforces the name/description contract for skills", () => {
    const findings = frontmatterRule.run(makeSkill("skill", {}), ctx);
    const messages = findings.map((f) => f.message);
    expect(messages).toContain("missing required frontmatter field `name`");
    expect(messages).toContain(
      "missing required frontmatter field `description`",
    );
  });

  it("does NOT demand name/description for non-skill formats", () => {
    for (const fmt of ["agents", "claude", "cursorrules", "mcp"] as const) {
      const findings = frontmatterRule.run(makeSkill(fmt, {}), ctx);
      expect(findings).toEqual([]);
    }
  });

  it("still flags an overlong description on any format that has one", () => {
    const long = "x".repeat(2000);
    const findings = frontmatterRule.run(
      makeSkill("agents", { description: long }),
      ctx,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("warning");
    expect(findings[0].message).toMatch(/description` is \d+ chars/);
  });

  it("still surfaces a parse error on non-skill formats", () => {
    const broken = makeSkill("claude", {});
    broken.error = "malformed frontmatter: boom";
    const findings = frontmatterRule.run(broken, ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toBe("malformed frontmatter: boom");
  });
});

describe("format-agnostic rules run on all formats (end-to-end)", () => {
  it("catches secrets/injection in AGENTS.md without frontmatter errors", async () => {
    const parsed = await parseSkill(agentsFile);
    const report = runEngine([parsed]);
    const ruleIds = new Set(report.findings.map((f) => f.ruleId));
    // The planted AWS key + injection bait should be caught…
    expect(ruleIds.has("secrets")).toBe(true);
    expect(ruleIds.has("injection")).toBe(true);
    // …but the missing-frontmatter contract must NOT fire on AGENTS.md.
    const frontmatterErrors = report.findings.filter(
      (f) =>
        f.ruleId === "frontmatter" &&
        /missing required frontmatter/.test(f.message),
    );
    expect(frontmatterErrors).toEqual([]);
  });

  it("catches the secret in an MCP manifest", async () => {
    const parsed = await parseSkill(mcpFile);
    const report = runEngine([parsed]);
    expect(report.findings.some((f) => f.ruleId === "secrets")).toBe(true);
  });

  it("keeps enforcing the full contract on the sibling SKILL.md", async () => {
    const parsed = await parseSkill(skillFile);
    const report = runEngine([parsed]);
    // The fixture skill is clean and complete → no frontmatter findings.
    expect(report.findings.filter((f) => f.ruleId === "frontmatter")).toEqual(
      [],
    );
  });
});
