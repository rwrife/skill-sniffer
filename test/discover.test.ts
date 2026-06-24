import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import {
  discoverSkills,
  looksLikeSkillFile,
} from "../src/discover.js";
import { parseSkill, parseSkills } from "../src/parse.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "fixtures");
const validDir = join(fixtures, "valid");
const validSkill = join(validDir, "SKILL.md");
const nestedSkill = join(validDir, "nested", "deep.skill.md");
const emptySkill = join(fixtures, "empty", "SKILL.md");
const badSkill = join(fixtures, "bad", "SKILL.md");

describe("looksLikeSkillFile", () => {
  it("matches SKILL.md and *.skill.md (case-insensitive), rejects others", () => {
    expect(looksLikeSkillFile("a/b/SKILL.md")).toBe(true);
    expect(looksLikeSkillFile("SKILL.md")).toBe(true);
    expect(looksLikeSkillFile("a/b/skill.md")).toBe(true);
    expect(looksLikeSkillFile("a/b/deep.skill.md")).toBe(true);
    expect(looksLikeSkillFile("a/b/Deep.SKILL.md")).toBe(true);
    expect(looksLikeSkillFile("README.md")).toBe(false);
    expect(looksLikeSkillFile("a/skillful.md")).toBe(false);
    expect(looksLikeSkillFile("a/SKILL.txt")).toBe(false);
  });
});

describe("discoverSkills", () => {
  it("recursively finds SKILL.md and *.skill.md under a directory", async () => {
    const found = await discoverSkills([validDir]);
    expect(found).toContain(resolve(validSkill));
    expect(found).toContain(resolve(nestedSkill));
  });

  it("accepts a direct skill file path", async () => {
    const found = await discoverSkills([validSkill]);
    expect(found).toEqual([resolve(validSkill)]);
  });

  it("ignores non-skill files passed directly", async () => {
    const readme = join(here, "..", "README.md");
    const found = await discoverSkills([readme]);
    expect(found).toEqual([]);
  });

  it("returns [] for a missing path instead of throwing", async () => {
    const found = await discoverSkills([join(fixtures, "does-not-exist")]);
    expect(found).toEqual([]);
  });

  it("de-duplicates and sorts across multiple inputs", async () => {
    const found = await discoverSkills([validDir, validSkill]);
    const occurrences = found.filter((p) => p === resolve(validSkill)).length;
    expect(occurrences).toBe(1);
    const sorted = [...found].sort();
    expect(found).toEqual(sorted);
  });
});

describe("parseSkill", () => {
  it("parses valid frontmatter + body", async () => {
    const skill = await parseSkill(validSkill);
    expect(skill.error).toBeUndefined();
    expect(skill.path).toBe(resolve(validSkill));
    expect(skill.frontmatter.name).toBe("valid-skill");
    expect(typeof skill.frontmatter.description).toBe("string");
    expect(skill.body).toContain("# Valid Skill");
    expect(skill.raw).toContain("name: valid-skill");
  });

  it("handles an empty file with no error and empty frontmatter", async () => {
    const skill = await parseSkill(emptySkill);
    expect(skill.error).toBeUndefined();
    expect(skill.frontmatter).toEqual({});
    expect(skill.body).toBe("");
    expect(skill.raw).toBe("");
  });

  it("captures malformed YAML without throwing, body still recoverable", async () => {
    const skill = await parseSkill(badSkill);
    expect(skill.error).toBeDefined();
    expect(skill.error).toMatch(/malformed frontmatter/);
    expect(skill.frontmatter).toEqual({});
    // raw is preserved so later rules can still scan the text
    expect(skill.raw).toContain("# Bad Frontmatter");
    expect(skill.body).toContain("# Bad Frontmatter");
  });

  it("reports a read error for a missing file instead of throwing", async () => {
    const skill = await parseSkill(join(fixtures, "nope", "SKILL.md"));
    expect(skill.error).toMatch(/could not read file/);
    expect(skill.frontmatter).toEqual({});
    expect(skill.raw).toBe("");
  });
});

describe("parseSkills", () => {
  it("parses a batch in input order and isolates per-file failures", async () => {
    const skills = await parseSkills([validSkill, badSkill, emptySkill]);
    expect(skills).toHaveLength(3);
    expect(skills[0].frontmatter.name).toBe("valid-skill");
    expect(skills[1].error).toBeDefined();
    expect(skills[2].error).toBeUndefined();
  });

  it("end-to-end: discover then parse a directory without throwing", async () => {
    const files = await discoverSkills([validDir]);
    const skills = await parseSkills(files);
    expect(skills.length).toBeGreaterThanOrEqual(2);
    expect(skills.every((s) => typeof s.path === "string")).toBe(true);
    expect(skills.some((s) => s.frontmatter.name === "valid-skill")).toBe(true);
  });
});
