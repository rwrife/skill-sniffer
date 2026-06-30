import { describe, it, expect } from "vitest";
import type { Finding, Severity, SkillScore } from "../src/types.js";
import {
  aggregateReports,
  parseRawReport,
  type RawJsonReport,
} from "../src/action/aggregate.js";
import {
  COMMENT_MARKER,
  MAX_FINDINGS_SHOWN,
  passesGate,
  relativePath,
  renderComment,
  renderNoSkillsComment,
} from "../src/action/comment.js";
import { filterSkillFiles } from "../src/action/run.js";

/** Build a finding with only the fields the comment/aggregate care about. */
function finding(
  severity: Severity,
  path = "/repo/skills/a/SKILL.md",
  extra: Partial<Finding> = {},
): Finding {
  return { ruleId: "test", severity, message: `${severity} thing`, path, ...extra };
}

/** Build a per-file score row. */
function score(path: string, value: number, extra: Partial<SkillScore> = {}): SkillScore {
  return {
    path,
    score: value,
    counts: { error: 0, warning: 0, info: 0 },
    ...extra,
  };
}

/** Build a raw CLI JSON report from findings + scores, with summed counts. */
function rawReport(
  findings: Finding[],
  scores: SkillScore[],
  version = "0.1.0",
): RawJsonReport {
  const counts: Record<Severity, number> = { error: 0, warning: 0, info: 0 };
  for (const f of findings) counts[f.severity]++;
  const overall = scores.length
    ? scores.reduce((m, s) => Math.min(m, s.score), 100)
    : 100;
  return {
    schema: "skill-sniffer/report@1",
    version,
    score: overall,
    skillsChecked: scores.length,
    counts,
    scores,
    findings,
  };
}

describe("action/aggregate — parseRawReport validation", () => {
  it("accepts a well-formed report", () => {
    const r = rawReport([], [score("/x/SKILL.md", 100)]);
    expect(parseRawReport(r)).toBe(r);
  });

  it("rejects non-objects", () => {
    expect(() => parseRawReport(null)).toThrow(/not a JSON object/);
    expect(() => parseRawReport(42)).toThrow(/not a JSON object/);
  });

  it("rejects an unexpected schema", () => {
    expect(() => parseRawReport({ schema: "nope@9", findings: [], scores: [] })).toThrow(
      /unexpected report schema/,
    );
  });

  it("rejects a report missing findings/scores arrays", () => {
    expect(() => parseRawReport({ schema: "skill-sniffer/report@1" })).toThrow(
      /missing findings\/scores/,
    );
  });

  it("tolerates a newer minor schema (same prefix)", () => {
    const r = { schema: "skill-sniffer/report@1.5", findings: [], scores: [] };
    expect(parseRawReport(r)).toBe(r);
  });
});

describe("action/aggregate — aggregateReports", () => {
  it("an empty set scores a clean 100 with no files", () => {
    const agg = aggregateReports([]);
    expect(agg.score).toBe(100);
    expect(agg.skillsChecked).toBe(0);
    expect(agg.findings).toEqual([]);
  });

  it("overall score is the minimum across files", () => {
    const a = rawReport([finding("error", "/a/SKILL.md")], [score("/a/SKILL.md", 50)]);
    const b = rawReport([], [score("/b/SKILL.md", 92)]);
    const agg = aggregateReports([a, b]);
    expect(agg.score).toBe(50);
    expect(agg.skillsChecked).toBe(2);
  });

  it("sums counts and concatenates findings across reports", () => {
    const a = rawReport(
      [finding("error", "/a/SKILL.md"), finding("warning", "/a/SKILL.md")],
      [score("/a/SKILL.md", 67, { counts: { error: 1, warning: 1, info: 0 } })],
    );
    const b = rawReport(
      [finding("info", "/b/SKILL.md")],
      [score("/b/SKILL.md", 98, { counts: { error: 0, warning: 0, info: 1 } })],
    );
    const agg = aggregateReports([a, b]);
    expect(agg.counts).toEqual({ error: 1, warning: 1, info: 1 });
    expect(agg.findings).toHaveLength(3);
  });

  it("de-dupes a repeated path keeping the lower score", () => {
    const a = rawReport([], [score("/dup/SKILL.md", 80)]);
    const b = rawReport([], [score("/dup/SKILL.md", 40)]);
    const agg = aggregateReports([a, b]);
    expect(agg.skillsChecked).toBe(1);
    expect(agg.score).toBe(40);
  });

  it("carries the version through", () => {
    const agg = aggregateReports([rawReport([], [score("/a/SKILL.md", 100)], "9.9.9")]);
    expect(agg.version).toBe("9.9.9");
  });
});

describe("action/comment — passesGate", () => {
  it("passes a clean report with no gate", () => {
    expect(passesGate(aggregateReports([rawReport([], [score("/a/SKILL.md", 70)])]))).toBe(true);
  });

  it("fails when any error finding exists, even without a min-score", () => {
    const r = aggregateReports([
      rawReport([finding("error", "/a/SKILL.md")], [score("/a/SKILL.md", 50, { counts: { error: 1, warning: 0, info: 0 } })]),
    ]);
    expect(passesGate(r)).toBe(false);
  });

  it("respects an explicit min-score", () => {
    const r = aggregateReports([rawReport([], [score("/a/SKILL.md", 75)])]);
    expect(passesGate(r, 80)).toBe(false);
    expect(passesGate(r, 70)).toBe(true);
  });
});

describe("action/comment — relativePath", () => {
  it("strips a repo root prefix", () => {
    expect(relativePath("/home/runner/repo/skills/a/SKILL.md", "/home/runner/repo")).toBe(
      "skills/a/SKILL.md",
    );
  });

  it("tolerates a trailing slash on the root", () => {
    expect(relativePath("/r/x/SKILL.md", "/r/")).toBe("x/SKILL.md");
  });

  it("returns the input unchanged when no root or no match", () => {
    expect(relativePath("/a/SKILL.md")).toBe("/a/SKILL.md");
    expect(relativePath("/other/SKILL.md", "/r")).toBe("/other/SKILL.md");
  });
});

describe("action/comment — renderComment", () => {
  const root = "/repo";

  it("always embeds the sticky marker", () => {
    const r = aggregateReports([rawReport([], [score("/repo/a/SKILL.md", 100)])]);
    expect(renderComment(r)).toContain(COMMENT_MARKER);
  });

  it("shows a passed headline + score for a clean report", () => {
    const r = aggregateReports([rawReport([], [score("/repo/a/SKILL.md", 100)])]);
    const body = renderComment(r, { repoRoot: root, minScore: 80 });
    expect(body).toMatch(/passed/);
    expect(body).toContain("100/100");
    expect(body).toContain("min-score `80`");
    expect(body).toContain("`a/SKILL.md`");
  });

  it("shows a failed headline when below min-score", () => {
    const r = aggregateReports([rawReport([], [score("/repo/a/SKILL.md", 60)])]);
    const body = renderComment(r, { repoRoot: root, minScore: 80 });
    expect(body).toMatch(/failed/);
    expect(body).toContain("❌");
  });

  it("fails the headline on an error finding even without a gate", () => {
    const r = aggregateReports([
      rawReport(
        [finding("error", "/repo/a/SKILL.md", { line: 3 })],
        [score("/repo/a/SKILL.md", 75, { counts: { error: 1, warning: 0, info: 0 } })],
      ),
    ]);
    const body = renderComment(r, { repoRoot: root });
    expect(body).toMatch(/failed/);
  });

  it("renders findings with rule id, location and message", () => {
    const r = aggregateReports([
      rawReport(
        [finding("warning", "/repo/a/SKILL.md", { line: 11, ruleId: "token-bloat", message: "too chonky" })],
        [score("/repo/a/SKILL.md", 92, { counts: { error: 0, warning: 1, info: 0 } })],
      ),
    ]);
    const body = renderComment(r, { repoRoot: root });
    expect(body).toContain("`token-bloat`");
    expect(body).toContain("a/SKILL.md:11");
    expect(body).toContain("too chonky");
  });

  it("truncates the findings table and notes the remainder", () => {
    const many: Finding[] = [];
    for (let i = 0; i < MAX_FINDINGS_SHOWN + 5; i++) {
      many.push(finding("warning", "/repo/a/SKILL.md", { line: i + 1 }));
    }
    const r = aggregateReports([
      rawReport(many, [score("/repo/a/SKILL.md", 20, { counts: { error: 0, warning: many.length, info: 0 } })]),
    ]);
    const body = renderComment(r, { repoRoot: root });
    expect(body).toContain("and 5 more findings");
  });

  it("escapes pipe characters in finding messages", () => {
    const r = aggregateReports([
      rawReport(
        [finding("warning", "/repo/a/SKILL.md", { message: "has a | pipe", line: 1 })],
        [score("/repo/a/SKILL.md", 92, { counts: { error: 0, warning: 1, info: 0 } })],
      ),
    ]);
    const body = renderComment(r, { repoRoot: root });
    expect(body).toContain("has a \\| pipe");
  });

  it("shows an all-clean note when there are no findings", () => {
    const r = aggregateReports([rawReport([], [score("/repo/a/SKILL.md", 100)])]);
    expect(renderComment(r, { repoRoot: root })).toMatch(/came back clean/);
  });

  it("includes the short sha in the footer when provided", () => {
    const r = aggregateReports([rawReport([], [score("/repo/a/SKILL.md", 100)])]);
    expect(renderComment(r, { sha: "abc1234" })).toContain("abc1234");
  });
});

describe("action/comment — renderNoSkillsComment", () => {
  it("carries the marker and a nothing-to-do note", () => {
    const body = renderNoSkillsComment("deadbee");
    expect(body).toContain(COMMENT_MARKER);
    expect(body).toMatch(/nothing to sniff/i);
    expect(body).toContain("deadbee");
  });
});

describe("action/run — filterSkillFiles", () => {
  it("keeps SKILL.md and *.skill.md at any depth, drops the rest", () => {
    const out = filterSkillFiles([
      "skills/a/SKILL.md",
      "deep/nested/thing.skill.md",
      "README.md",
      "src/index.ts",
      "SKILL.md",
    ]);
    expect(out).toEqual(["skills/a/SKILL.md", "deep/nested/thing.skill.md", "SKILL.md"]);
  });

  it("trims whitespace and drops blanks (trailing newline from git)", () => {
    expect(filterSkillFiles([" skills/a/SKILL.md ", "", "   "])).toEqual(["skills/a/SKILL.md"]);
  });

  it("de-duplicates repeated paths", () => {
    expect(filterSkillFiles(["a/SKILL.md", "a/SKILL.md"])).toEqual(["a/SKILL.md"]);
  });

  it("is case-insensitive on the filename", () => {
    expect(filterSkillFiles(["a/skill.md", "b/Thing.Skill.MD"])).toEqual([
      "a/skill.md",
      "b/Thing.Skill.MD",
    ]);
  });
});
