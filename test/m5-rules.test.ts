import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  tokenBloatRule,
  makeTokenBloatRule,
  estimateTokens,
  DEFAULT_TOKEN_BUDGET,
} from "../src/rules/token-bloat.js";
import { brokenPathsRule } from "../src/rules/broken-paths.js";
import { toolScopeRule } from "../src/rules/tool-scope.js";
import { runEngine } from "../src/engine.js";
import { parseSkill } from "../src/parse.js";
import type { ParsedSkill, RuleContext } from "../src/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "fixtures");

/** A context that just echoes the chosen/default severity (no config overrides). */
const ctx: RuleContext = {
  severityFor: (rule, fallback) => fallback ?? rule.defaultSeverity,
};

/** Build an in-memory skill whose `raw` is the text under test. */
function rawSkill(raw: string, path = "/virtual/SKILL.md"): ParsedSkill {
  return { path, frontmatter: {}, body: raw, raw };
}

/** Build an in-memory skill with explicit frontmatter (for tool-scope). */
function fmSkill(frontmatter: Record<string, unknown>, body = ""): ParsedSkill {
  return { path: "/virtual/SKILL.md", frontmatter, body, raw: body };
}

// ---------------------------------------------------------------------------
// token-bloat
// ---------------------------------------------------------------------------

describe("token-bloat rule", () => {
  it("estimateTokens uses the chars/4 heuristic (rounded up)", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2); // 5/4 -> ceil 2
  });

  it("stays quiet when under the budget", () => {
    const findings = tokenBloatRule.run(rawSkill("tiny skill body"), ctx);
    expect(findings).toHaveLength(0);
  });

  it("warns once when over a (small) custom budget", () => {
    const rule = makeTokenBloatRule(5); // 5-token ceiling
    const findings = rule.run(rawSkill("this body is definitely longer than five tokens"), ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("warning");
    expect(findings[0].ruleId).toBe("token-bloat");
    expect(findings[0].line).toBeUndefined(); // whole-file finding
    expect(findings[0].message).toMatch(/tokens/);
  });

  it("default budget constant is exported and sane", () => {
    expect(DEFAULT_TOKEN_BUDGET).toBeGreaterThan(0);
  });

  it("acceptance: fires on the bloat fixture, quiet on the safe fixture", async () => {
    const bloated = await parseSkill(join(fixtures, "bloat", "SKILL.md"));
    const safe = await parseSkill(join(fixtures, "safe", "SKILL.md"));
    expect(tokenBloatRule.run(bloated, ctx).length).toBe(1);
    expect(tokenBloatRule.run(safe, ctx).length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// broken-paths
// ---------------------------------------------------------------------------

describe("broken-paths rule", () => {
  it("flags a missing markdown-link target with line/column", async () => {
    const skill = await parseSkill(join(fixtures, "broken-paths", "SKILL.md"));
    const findings = brokenPathsRule.run(skill, ctx);
    const messages = findings.map((f) => f.message);
    // The two missing references should be reported...
    expect(messages.some((m) => m.includes("docs/setup.md"))).toBe(true);
    expect(messages.some((m) => m.includes("scripts/missing-tool.sh"))).toBe(true);
    // ...as errors, with positions.
    for (const f of findings) {
      expect(f.severity).toBe("error");
      expect(f.line).toBeGreaterThan(0);
      expect(f.column).toBeGreaterThan(0);
    }
  });

  it("does not flag the real sibling file, URLs, anchors, or prose commands", async () => {
    const skill = await parseSkill(join(fixtures, "broken-paths", "SKILL.md"));
    const messages = brokenPathsRule.run(skill, ctx).map((f) => f.message);
    expect(messages.some((m) => m.includes("helper.sh"))).toBe(false); // exists
    expect(messages.some((m) => m.includes("example.com"))).toBe(false); // URL
    expect(messages.some((m) => m.includes("#broken-paths"))).toBe(false); // anchor
    expect(messages.some((m) => m.includes("npm test"))).toBe(false); // prose
  });

  it("skips absolute paths, home paths, and bare code words", () => {
    const skill = rawSkill(
      "see `/etc/passwd` and `~/secrets` and `just-a-word` and [x](mailto:a@b.com)",
      join(fixtures, "broken-paths", "SKILL.md"),
    );
    expect(brokenPathsRule.run(skill, ctx)).toHaveLength(0);
  });

  it("skips skills with no on-disk path to resolve against", () => {
    // Empty path => nothing to resolve relative paths against => no findings.
    const noPath: ParsedSkill = {
      path: "",
      frontmatter: {},
      body: "[x](./nope.md)",
      raw: "[x](./nope.md)",
    };
    expect(brokenPathsRule.run(noPath, ctx)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// tool-scope
// ---------------------------------------------------------------------------

describe("tool-scope rule", () => {
  it("flags a wildcard scope in an allowed-tools map", () => {
    const skill = fmSkill({ "allowed-tools": { exec: "*", read: "ok" } });
    const findings = toolScopeRule.run(skill, ctx);
    expect(findings.some((f) => /broad tool grant/.test(f.message))).toBe(true);
    expect(findings.some((f) => f.severity === "error")).toBe(true);
  });

  it("flags a bare wildcard in an array grant", () => {
    const skill = fmSkill({ tools: ["read", "*"] });
    const findings = toolScopeRule.run(skill, ctx);
    expect(findings.some((f) => /bare wildcard/.test(f.message))).toBe(true);
  });

  it("flags 'any shell command' prose with a position", () => {
    const skill = rawSkill("This skill may run any shell command it likes.");
    const findings = toolScopeRule.run(skill, ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("error");
    expect(findings[0].line).toBeGreaterThan(0);
  });

  it("warns (not errors) on softer 'full access' phrasing", () => {
    const skill = rawSkill("Assumes full access to the host environment.");
    const findings = toolScopeRule.run(skill, ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("warning");
  });

  it("stays quiet on narrowly-scoped grants", () => {
    const skill = fmSkill(
      { "allowed-tools": ["read", "write", "exec: ls"] },
      "Runs `ls` and reads files. Nothing broad here.",
    );
    expect(toolScopeRule.run(skill, ctx)).toHaveLength(0);
  });

  it("acceptance: fires on the tool-scope fixture", async () => {
    const skill = await parseSkill(join(fixtures, "tool-scope", "SKILL.md"));
    const findings = toolScopeRule.run(skill, ctx);
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings.some((f) => f.severity === "error")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// engine integration — all three rules are registered and run together
// ---------------------------------------------------------------------------

describe("M5 rules are wired into the engine", () => {
  it("the default engine surfaces broken-path and tool-scope findings", async () => {
    const skills = await Promise.all([
      parseSkill(join(fixtures, "broken-paths", "SKILL.md")),
      parseSkill(join(fixtures, "tool-scope", "SKILL.md")),
    ]);
    const report = runEngine(skills);
    const ruleIds = new Set(report.findings.map((f) => f.ruleId));
    expect(ruleIds.has("broken-paths")).toBe(true);
    expect(ruleIds.has("tool-scope")).toBe(true);
  });
});
