import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join, isAbsolute } from "node:path";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import type { Finding, Severity } from "../src/types.js";
import { rules } from "../src/rules/index.js";
import {
  renderSarif,
  severityToSarifLevel,
  toArtifactUri,
  SARIF_SCHEMA,
  SARIF_VERSION,
} from "../src/report/sarif.js";
import { run, buildProgram, EXIT } from "../src/cli.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

/** Build a finding with just the fields the SARIF reporter cares about. */
function finding(
  severity: Severity,
  extra: Partial<Finding> = {},
): Finding {
  return {
    ruleId: "frontmatter",
    severity,
    message: `${severity} finding`,
    path: "/repo/skills/SKILL.md",
    ...extra,
  };
}

/** Run the CLI, forwarding stdout chunks to `sink`, returning the exit code. */
async function runCapturingStdout(
  argv: string[],
  sink: (chunk: string) => void,
): Promise<number> {
  const original = process.stdout.write.bind(process.stdout);
  // @ts-expect-error narrow override for test capture
  process.stdout.write = (chunk: string) => {
    sink(chunk);
    return true;
  };
  try {
    return await run(argv);
  } finally {
    process.stdout.write = original;
  }
}

describe("SARIF — severity → level mapping", () => {
  it("maps error → error", () => {
    expect(severityToSarifLevel("error")).toBe("error");
  });
  it("maps warning → warning", () => {
    expect(severityToSarifLevel("warning")).toBe("warning");
  });
  it("maps info → note (SARIF's gentlest actionable level)", () => {
    expect(severityToSarifLevel("info")).toBe("note");
  });

  it("covers the mapping through renderSarif results too", () => {
    const sarif = JSON.parse(
      renderSarif(
        [finding("error"), finding("warning"), finding("info")],
        "1.2.3",
      ),
    );
    const levels = sarif.runs[0].results.map(
      (r: { level: string }) => r.level,
    );
    expect(levels).toEqual(["error", "warning", "note"]);
  });
});

describe("SARIF — document shape", () => {
  it("stamps $schema and version 2.1.0", () => {
    const sarif = JSON.parse(renderSarif([], "0.1.0"));
    expect(sarif.$schema).toBe(SARIF_SCHEMA);
    expect(sarif.version).toBe(SARIF_VERSION);
    expect(sarif.version).toBe("2.1.0");
  });

  it("names the driver skill-sniffer and stamps the passed version", () => {
    const sarif = JSON.parse(renderSarif([], "9.9.9"));
    expect(sarif.runs).toHaveLength(1);
    expect(sarif.runs[0].tool.driver.name).toBe("skill-sniffer");
    expect(sarif.runs[0].tool.driver.version).toBe("9.9.9");
    expect(sarif.runs[0].tool.driver.informationUri).toContain("skill-sniffer");
  });

  it("round-trips through JSON.parse (valid JSON)", () => {
    const text = renderSarif([finding("error", { line: 3 })], "1.0.0");
    expect(() => JSON.parse(text)).not.toThrow();
  });

  it("populates rules[] from the full rule registry", () => {
    const sarif = JSON.parse(renderSarif([], "1.0.0"));
    const descriptors = sarif.runs[0].tool.driver.rules;
    expect(descriptors).toHaveLength(rules.length);
    const ids = descriptors.map((d: { id: string }) => d.id);
    for (const r of rules) {
      expect(ids).toContain(r.id);
    }
    // Each descriptor carries a short + full description and a default level.
    for (const d of descriptors) {
      expect(typeof d.shortDescription.text).toBe("string");
      expect(d.shortDescription.text.length).toBeGreaterThan(0);
      expect(["error", "warning", "note"]).toContain(
        d.defaultConfiguration.level,
      );
    }
  });

  it("compact mode produces single-line JSON", () => {
    const text = renderSarif([finding("warning")], "1.0.0", {}, false).trimEnd();
    expect(text).not.toContain("\n");
    expect(() => JSON.parse(text)).not.toThrow();
  });
});

describe("SARIF — results & locations", () => {
  it("maps a finding with a line to a region with startLine (+startColumn)", () => {
    const sarif = JSON.parse(
      renderSarif([finding("error", { line: 12, column: 4 })], "1.0.0", {
        baseDir: "/repo",
      }),
    );
    const region =
      sarif.runs[0].results[0].locations[0].physicalLocation.region;
    expect(region.startLine).toBe(12);
    expect(region.startColumn).toBe(4);
  });

  it("emits startLine without startColumn when only a line is known", () => {
    const sarif = JSON.parse(
      renderSarif([finding("warning", { line: 7 })], "1.0.0", {
        baseDir: "/repo",
      }),
    );
    const region =
      sarif.runs[0].results[0].locations[0].physicalLocation.region;
    expect(region.startLine).toBe(7);
    expect(region).not.toHaveProperty("startColumn");
  });

  it("degrades gracefully: whole-file finding (no line) omits region", () => {
    const sarif = JSON.parse(
      renderSarif([finding("error")], "1.0.0", { baseDir: "/repo" }),
    );
    const physical =
      sarif.runs[0].results[0].locations[0].physicalLocation;
    expect(physical).not.toHaveProperty("region");
    // The artifact location is still present so the annotation lands on the file.
    expect(physical.artifactLocation.uri).toBeTruthy();
  });

  it("cross-references results to registry rules via ruleIndex", () => {
    const sarif = JSON.parse(
      renderSarif([finding("error")], "1.0.0", { baseDir: "/repo" }),
    );
    const result = sarif.runs[0].results[0];
    const idx = result.ruleIndex;
    expect(rules[idx].id).toBe(result.ruleId);
  });
});

describe("SARIF — artifact URIs are repo-relative", () => {
  it("makes URIs relative to baseDir, not absolute machine paths", () => {
    const sarif = JSON.parse(
      renderSarif(
        [finding("error", { path: "/repo/skills/deep/SKILL.md" })],
        "1.0.0",
        { baseDir: "/repo" },
      ),
    );
    const uri =
      sarif.runs[0].results[0].locations[0].physicalLocation.artifactLocation
        .uri;
    expect(uri).toBe("skills/deep/SKILL.md");
    expect(isAbsolute(uri)).toBe(false);
    expect(uri.startsWith("/repo")).toBe(false);
  });

  it("toArtifactUri strips a leading ./ and normalizes", () => {
    expect(toArtifactUri("/repo/a/b.md", "/repo")).toBe("a/b.md");
    expect(toArtifactUri("/repo/a/b.md", "/repo/a")).toBe("b.md");
  });

  it("toArtifactUri never returns an empty string for the base dir itself", () => {
    // relative("/repo", "/repo") === "" — must not leak an empty URI.
    expect(toArtifactUri("/repo", "/repo")).toBe("/repo");
  });
});

describe("SARIF — CLI wiring (--sarif)", () => {
  it("registers the --sarif flag on the program", () => {
    const program = buildProgram();
    const opts = program.options.map((o) => o.long);
    expect(opts).toContain("--sarif");
  });

  it("--sarif <path> writes a valid SARIF file and still gates the exit code", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sniffer-sarif-"));
    const out = join(dir, "out.sarif");
    try {
      // broken-paths has error findings → gate trips (EXIT.FINDINGS).
      const code = await runCapturingStdout(
        [
          "node",
          "skill-sniffer",
          join(FIXTURES, "broken-paths"),
          "--sarif",
          out,
        ],
        () => {},
      );
      expect(code).toBe(EXIT.FINDINGS);

      const sarif = JSON.parse(readFileSync(out, "utf8"));
      expect(sarif.$schema).toBe(SARIF_SCHEMA);
      expect(sarif.version).toBe("2.1.0");
      expect(sarif.runs[0].tool.driver.name).toBe("skill-sniffer");
      expect(sarif.runs[0].results.length).toBeGreaterThan(0);
      // URIs must be repo-relative, not absolute machine paths.
      for (const r of sarif.runs[0].results) {
        const uri =
          r.locations[0].physicalLocation.artifactLocation.uri;
        expect(isAbsolute(uri)).toBe(false);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("bare --sarif streams SARIF to stdout", async () => {
    let out = "";
    const code = await runCapturingStdout(
      ["node", "skill-sniffer", join(FIXTURES, "broken-paths"), "--sarif"],
      (c) => {
        out += c;
      },
    );
    expect(code).toBe(EXIT.FINDINGS);
    const sarif = JSON.parse(out);
    expect(sarif.version).toBe("2.1.0");
    expect(sarif.runs[0].tool.driver.name).toBe("skill-sniffer");
  });

  it("--json and bare --sarif (both stdout) are mutually exclusive", async () => {
    let err = "";
    const original = process.stderr.write.bind(process.stderr);
    // @ts-expect-error narrow override for test capture
    process.stderr.write = (chunk: string) => {
      err += chunk;
      return true;
    };
    let code = -1;
    try {
      code = await runCapturingStdout(
        [
          "node",
          "skill-sniffer",
          join(FIXTURES, "broken-paths"),
          "--json",
          "--sarif",
        ],
        () => {},
      );
    } finally {
      process.stderr.write = original;
    }
    expect(code).toBe(EXIT.USAGE);
    expect(err).toContain("mutually exclusive");
  });

  it("--sarif <path> alongside --json is allowed (json→stdout, sarif→file)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sniffer-sarif-combo-"));
    const out = join(dir, "combo.sarif");
    try {
      let stdout = "";
      const code = await runCapturingStdout(
        [
          "node",
          "skill-sniffer",
          join(FIXTURES, "broken-paths"),
          "--json",
          "--sarif",
          out,
        ],
        (c) => {
          stdout += c;
        },
      );
      expect(code).toBe(EXIT.FINDINGS);
      // stdout is the JSON report…
      const json = JSON.parse(stdout);
      expect(json.schema).toContain("skill-sniffer/report@");
      // …and the SARIF landed in the file.
      const sarif = JSON.parse(readFileSync(out, "utf8"));
      expect(sarif.version).toBe("2.1.0");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
