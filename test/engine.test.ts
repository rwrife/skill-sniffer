import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { runEngine } from "../src/engine.js";
import { frontmatterRule, rules, getRule } from "../src/rules/index.js";
import { renderPretty } from "../src/report/pretty.js";
import { discoverSkills } from "../src/discover.js";
import { parseSkill, parseSkills } from "../src/parse.js";
import type { ParsedSkill, Rule, RuleContext } from "../src/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "fixtures");
const validSkill = join(fixtures, "valid", "SKILL.md");
const badSkill = join(fixtures, "bad", "SKILL.md");
const findingsDir = join(fixtures, "findings");
const noDescription = join(findingsDir, "no-description.skill.md");
const noName = join(findingsDir, "no-name.skill.md");
const bloated = join(findingsDir, "bloated-description.skill.md");

/** Helper: build a minimal in-memory skill for unit tests. */
function skill(frontmatter: Record<string, unknown>, error?: string): ParsedSkill {
  return {
    path: "/virtual/SKILL.md",
    frontmatter,
    body: "# body",
    raw: "",
    ...(error ? { error } : {}),
  };
}

/** A throwaway context that just echoes the chosen/default severity. */
const ctx: RuleContext = {
  severityFor: (rule, fallback) => fallback ?? rule.defaultSeverity,
};

describe("frontmatter rule", () => {
  it("passes a fully-valid frontmatter with zero findings", () => {
    const findings = frontmatterRule.run(
      skill({ name: "ok", description: "a fine description" }),
      ctx,
    );
    expect(findings).toEqual([]);
  });

  it("errors on missing name", () => {
    const findings = frontmatterRule.run(skill({ description: "desc" }), ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("error");
    expect(findings[0].ruleId).toBe("frontmatter");
    expect(findings[0].message).toMatch(/missing required frontmatter field `name`/);
  });

  it("errors on missing description", () => {
    const findings = frontmatterRule.run(skill({ name: "ok" }), ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toMatch(/missing required frontmatter field `description`/);
  });

  it("errors on present-but-empty / wrong-type fields", () => {
    const findings = frontmatterRule.run(skill({ name: "   ", description: 42 }), ctx);
    const messages = findings.map((f) => f.message).join("\n");
    expect(findings).toHaveLength(2);
    expect(messages).toMatch(/`name` must be a non-empty string/);
    expect(messages).toMatch(/`description` must be a non-empty string/);
  });

  it("warns (not errors) on an overlong description", () => {
    const long = "x".repeat(250);
    const findings = frontmatterRule.run(skill({ name: "ok", description: long }), ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("warning");
    expect(findings[0].message).toMatch(/over 200/);
  });

  it("surfaces a parse error as a single finding and skips field checks", () => {
    const findings = frontmatterRule.run(skill({}, "malformed frontmatter: boom"), ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("error");
    expect(findings[0].message).toMatch(/malformed frontmatter/);
  });
});

describe("rule registry", () => {
  it("includes the frontmatter rule and resolves it by id", () => {
    expect(rules).toContain(frontmatterRule);
    expect(getRule("frontmatter")).toBe(frontmatterRule);
    expect(getRule("nope")).toBeUndefined();
  });
});

describe("runEngine", () => {
  it("aggregates findings across skills with correct counts", () => {
    const skills = [
      skill({ name: "ok", description: "good" }), // clean
      skill({ description: "no name here" }), // 1 error
      skill({ name: "ok", description: "y".repeat(300) }), // 1 warning
    ];
    const report = runEngine(skills);

    expect(report.skillsChecked).toBe(3);
    expect(report.counts.error).toBe(1);
    expect(report.counts.warning).toBe(1);
    expect(report.counts.info).toBe(0);
    expect(report.findings).toHaveLength(2);
  });

  it("sorts findings by path, then severity (loudest first)", () => {
    const a = skill({ name: "ok", description: "z".repeat(300) }); // warning
    a.path = "/a/SKILL.md";
    const b = skill({}); // 2 errors (missing name + description)
    b.path = "/b/SKILL.md";

    const report = runEngine([b, a]);
    // /a sorts before /b regardless of input order
    expect(report.findings[0].path).toBe("/a/SKILL.md");
    // within /b, both are errors
    const bFindings = report.findings.filter((f) => f.path === "/b/SKILL.md");
    expect(bFindings).toHaveLength(2);
    expect(bFindings.every((f) => f.severity === "error")).toBe(true);
  });

  it("isolates a throwing rule into an error finding instead of crashing", () => {
    const boom: Rule = {
      id: "boom",
      description: "always throws",
      defaultSeverity: "error",
      run() {
        throw new Error("kaboom");
      },
    };
    const report = runEngine([skill({ name: "ok", description: "good" })], [boom]);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].ruleId).toBe("boom");
    expect(report.findings[0].message).toMatch(/crashed: kaboom/);
  });

  it("returns an empty, well-formed report for zero skills", () => {
    const report = runEngine([]);
    expect(report.skillsChecked).toBe(0);
    expect(report.findings).toEqual([]);
    expect(report.counts).toEqual({ error: 0, warning: 0, info: 0 });
  });
});

describe("renderPretty", () => {
  it("wags for a clean run", () => {
    const out = renderPretty(runEngine([skill({ name: "ok", description: "good" })]));
    expect(out).toContain("good boy");
    expect(out).toContain("🐕");
  });

  it("groups findings under their file path with a summary", () => {
    const s = skill({}); // missing name + description
    s.path = "/grp/SKILL.md";
    const out = renderPretty(runEngine([s]));
    expect(out).toContain("/grp/SKILL.md");
    expect(out).toContain("error");
    expect(out).toMatch(/2 errors/);
  });
});

describe("end-to-end on fixtures (acceptance)", () => {
  it("discover → parse → engine produces grouped frontmatter findings", async () => {
    const files = await discoverSkills([findingsDir]);
    const skills = await parseSkills(files);
    const report = runEngine(skills);

    // Each findings fixture should contribute at least one finding.
    const paths = new Set(report.findings.map((f) => f.path));
    expect(paths.has(resolve(noDescription))).toBe(true);
    expect(paths.has(resolve(noName))).toBe(true);
    expect(paths.has(resolve(bloated))).toBe(true);

    // The bloated one is a warning; the missing-field ones are errors.
    const bloatedFindings = report.findings.filter((f) => f.path === resolve(bloated));
    expect(bloatedFindings).toHaveLength(1);
    expect(bloatedFindings[0].severity).toBe("warning");

    expect(report.counts.error).toBeGreaterThanOrEqual(2);
    expect(report.counts.warning).toBeGreaterThanOrEqual(1);
  });

  it("reports malformed frontmatter from the bad fixture as an error", async () => {
    const parsed = await parseSkill(badSkill);
    const report = runEngine([parsed]);
    expect(report.counts.error).toBeGreaterThanOrEqual(1);
    expect(report.findings[0].message).toMatch(/malformed frontmatter/);
  });

  it("keeps the valid fixture clean", async () => {
    const parsed = await parseSkill(validSkill);
    const report = runEngine([parsed]);
    expect(report.findings).toEqual([]);
  });
});
