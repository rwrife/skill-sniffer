import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import type { Finding, Report, Severity } from "../src/types.js";
import {
  scoreFindings,
  scoreReport,
  PENALTIES,
  MAX_SCORE,
} from "../src/score.js";
import { renderJson, REPORT_SCHEMA } from "../src/report/json.js";
import { writeConfigStub, RC_FILENAME, DEFAULT_CONFIG } from "../src/init.js";
import { buildProgram, run, EXIT } from "../src/cli.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

/** Build a finding with just the fields the scorer/reporter care about. */
function finding(
  severity: Severity,
  path = "/x/SKILL.md",
  extra: Partial<Finding> = {},
): Finding {
  return {
    ruleId: "test",
    severity,
    message: `${severity} finding`,
    path,
    ...extra,
  };
}

/** Wrap findings into a minimal Report (counts tallied for realism). */
function reportOf(findings: Finding[], skillsChecked = 1): Report {
  const counts: Record<Severity, number> = { error: 0, warning: 0, info: 0 };
  for (const f of findings) counts[f.severity]++;
  return { findings, skillsChecked, counts };
}

/** Capture everything written to stdout while running `fn`. */
async function captureStdout(fn: () => Promise<void>): Promise<string> {
  let out = "";
  const original = process.stdout.write.bind(process.stdout);
  // @ts-expect-error narrow override for test capture
  process.stdout.write = (chunk: string) => {
    out += chunk;
    return true;
  };
  try {
    await fn();
  } finally {
    process.stdout.write = original;
  }
  return out;
}

describe("M6 score — Good Boy Score™ math", () => {
  it("a clean file scores a perfect 100", () => {
    expect(scoreFindings([])).toBe(MAX_SCORE);
  });

  it("deducts the documented penalty per severity", () => {
    expect(scoreFindings([finding("error")])).toBe(100 - PENALTIES.error);
    expect(scoreFindings([finding("warning")])).toBe(100 - PENALTIES.warning);
    expect(scoreFindings([finding("info")])).toBe(100 - PENALTIES.info);
  });

  it("stacks penalties across multiple findings", () => {
    const score = scoreFindings([
      finding("error"),
      finding("warning"),
      finding("info"),
    ]);
    expect(score).toBe(100 - PENALTIES.error - PENALTIES.warning - PENALTIES.info);
  });

  it("clamps at 0 and never goes negative", () => {
    const manyErrors = Array.from({ length: 20 }, () => finding("error"));
    expect(scoreFindings(manyErrors)).toBe(0);
  });
});

describe("M6 score — scoreReport per-file + overall", () => {
  it("scores clean files as 100 even with no findings (via checkedPaths)", () => {
    const scored = scoreReport(reportOf([], 2), ["/a/SKILL.md", "/b/SKILL.md"]);
    expect(scored.score).toBe(100);
    expect(scored.scores).toHaveLength(2);
    expect(scored.scores.every((s) => s.score === 100)).toBe(true);
  });

  it("overall score is the MINIMUM across files (worst dog wins)", () => {
    const findings = [
      finding("warning", "/a/SKILL.md"), // a -> 92
      finding("error", "/b/SKILL.md"), // b -> 75
    ];
    const scored = scoreReport(reportOf(findings, 2), [
      "/a/SKILL.md",
      "/b/SKILL.md",
    ]);
    expect(scored.score).toBe(75);
    const byPath = Object.fromEntries(scored.scores.map((s) => [s.path, s.score]));
    expect(byPath["/a/SKILL.md"]).toBe(92);
    expect(byPath["/b/SKILL.md"]).toBe(75);
  });

  it("represents files with findings even when checkedPaths is omitted", () => {
    const scored = scoreReport(reportOf([finding("error", "/a/SKILL.md")], 1));
    expect(scored.scores).toHaveLength(1);
    expect(scored.scores[0].path).toBe("/a/SKILL.md");
    expect(scored.scores[0].score).toBe(75);
  });

  it("an empty run is vacuously a good boy (100)", () => {
    expect(scoreReport(reportOf([], 0)).score).toBe(100);
  });

  it("preserves the underlying Report fields", () => {
    const base = reportOf([finding("info")], 1);
    const scored = scoreReport(base, ["/x/SKILL.md"]);
    expect(scored.skillsChecked).toBe(1);
    expect(scored.findings).toEqual(base.findings);
    expect(scored.counts).toEqual(base.counts);
  });
});

describe("M6 json — machine-readable report", () => {
  it("emits valid, schema-stamped JSON", () => {
    const scored = scoreReport(
      reportOf([finding("error", "/x/SKILL.md", { line: 3, column: 5 })], 1),
      ["/x/SKILL.md"],
    );
    const text = renderJson(scored, "9.9.9");
    const parsed = JSON.parse(text);

    expect(parsed.schema).toBe(REPORT_SCHEMA);
    expect(parsed.version).toBe("9.9.9");
    expect(parsed.score).toBe(75);
    expect(parsed.skillsChecked).toBe(1);
    expect(parsed.counts).toEqual({ error: 1, warning: 0, info: 0 });
    expect(parsed.scores).toHaveLength(1);
    expect(parsed.findings[0]).toMatchObject({
      ruleId: "test",
      severity: "error",
      line: 3,
      column: 5,
    });
  });

  it("omits line/column for whole-file findings", () => {
    const scored = scoreReport(reportOf([finding("warning", "/x/SKILL.md")], 1), [
      "/x/SKILL.md",
    ]);
    const parsed = JSON.parse(renderJson(scored, "1.0.0"));
    expect(parsed.findings[0]).not.toHaveProperty("line");
    expect(parsed.findings[0]).not.toHaveProperty("column");
  });

  it("compact mode produces single-line JSON", () => {
    const scored = scoreReport(reportOf([], 0));
    const text = renderJson(scored, "1.0.0", false).trimEnd();
    expect(text).not.toContain("\n");
    expect(() => JSON.parse(text)).not.toThrow();
  });
});

describe("M6 init — .skillsnifferrc stub", () => {
  it("writes a valid JSON stub seeded with defaults, then refuses to clobber", () => {
    const dir = mkdtempSync(join(tmpdir(), "sniffer-init-"));
    try {
      const first = writeConfigStub(dir);
      expect(first.created).toBe(true);
      expect(first.path.endsWith(RC_FILENAME)).toBe(true);

      const cfg = JSON.parse(readFileSync(first.path, "utf8"));
      expect(cfg.tokenBudget).toBe(DEFAULT_CONFIG.tokenBudget);
      expect(cfg.minScore).toBe(DEFAULT_CONFIG.minScore);
      expect(cfg.maxWarnings).toBe(DEFAULT_CONFIG.maxWarnings);

      // Tamper, then ensure a second init leaves it untouched.
      writeFileSync(first.path, "{}\n", "utf8");
      const second = writeConfigStub(dir);
      expect(second.created).toBe(false);
      expect(readFileSync(first.path, "utf8")).toBe("{}\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("M6 cli — exit-code gates", () => {
  it("exits 0 on a clean directory", async () => {
    const code = await captureStdoutCode(["node", "skill-sniffer", join(FIXTURES, "valid")]);
    expect(code).toBe(EXIT.OK);
  });

  it("exits non-zero when any error finding is present", async () => {
    const code = await captureStdoutCode([
      "node",
      "skill-sniffer",
      join(FIXTURES, "broken-paths"),
    ]);
    expect(code).toBe(EXIT.FINDINGS);
  });

  it("warnings alone do NOT fail the build without a gate", async () => {
    const code = await captureStdoutCode([
      "node",
      "skill-sniffer",
      join(FIXTURES, "findings", "bloated-description.skill.md"),
    ]);
    expect(code).toBe(EXIT.OK);
  });

  it("--min-score fails when the overall score is below the threshold", async () => {
    // broken-paths scores 50; gate at 80 must fail.
    const code = await captureStdoutCode([
      "node",
      "skill-sniffer",
      join(FIXTURES, "broken-paths"),
      "--min-score",
      "80",
    ]);
    expect(code).toBe(EXIT.FINDINGS);
  });

  it("--min-score passes when the overall score meets the threshold", async () => {
    const code = await captureStdoutCode([
      "node",
      "skill-sniffer",
      join(FIXTURES, "valid"),
      "--min-score",
      "80",
    ]);
    expect(code).toBe(EXIT.OK);
  });

  it("--max-warnings fails when warnings exceed the cap", async () => {
    // bloated-description emits exactly 1 warning, 0 errors.
    const code = await captureStdoutCode([
      "node",
      "skill-sniffer",
      join(FIXTURES, "findings", "bloated-description.skill.md"),
      "--max-warnings",
      "0",
    ]);
    expect(code).toBe(EXIT.FINDINGS);
  });

  it("--max-warnings passes when warnings are within the cap", async () => {
    const code = await captureStdoutCode([
      "node",
      "skill-sniffer",
      join(FIXTURES, "findings", "bloated-description.skill.md"),
      "--max-warnings",
      "1",
    ]);
    expect(code).toBe(EXIT.OK);
  });

  it("--json emits parseable JSON and still gates the exit code", async () => {
    let out = "";
    const code = await captureStdoutInto(
      ["node", "skill-sniffer", join(FIXTURES, "broken-paths"), "--json"],
      (chunk) => {
        out += chunk;
      },
    );
    expect(code).toBe(EXIT.FINDINGS);
    const parsed = JSON.parse(out);
    expect(parsed.schema).toBe(REPORT_SCHEMA);
    expect(parsed.score).toBeLessThan(100);
  });

  it("--init via the CLI writes a stub and exits 0", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sniffer-cli-init-"));
    const cwd = process.cwd();
    try {
      process.chdir(dir);
      const out = await captureStdout(async () => {
        const code = await run(["node", "skill-sniffer", "--init"]);
        expect(code).toBe(EXIT.OK);
      });
      expect(out).toContain("created");
      expect(() => readFileSync(join(dir, RC_FILENAME), "utf8")).not.toThrow();
    } finally {
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** Run the CLI swallowing stdout, returning the exit code. */
async function captureStdoutCode(argv: string[]): Promise<number> {
  let code = -1;
  await captureStdout(async () => {
    code = await run(argv);
  });
  return code;
}

/** Run the CLI, forwarding stdout chunks to `sink`, returning the exit code. */
async function captureStdoutInto(
  argv: string[],
  sink: (chunk: string) => void,
): Promise<number> {
  let code = -1;
  const original = process.stdout.write.bind(process.stdout);
  // @ts-expect-error narrow override for test capture
  process.stdout.write = (chunk: string) => {
    sink(chunk);
    return true;
  };
  try {
    code = await run(argv);
  } finally {
    process.stdout.write = original;
  }
  return code;
}

describe("M6 cli — program wiring", () => {
  it("registers the M6 flags on the program", () => {
    const program = buildProgram();
    const opts = program.options.map((o) => o.long);
    expect(opts).toContain("--json");
    expect(opts).toContain("--min-score");
    expect(opts).toContain("--max-warnings");
    expect(opts).toContain("--init");
  });
});
