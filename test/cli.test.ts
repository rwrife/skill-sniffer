import { describe, it, expect } from "vitest";
import { getVersion } from "../src/version.js";
import { buildProgram } from "../src/cli.js";

describe("skill-sniffer M1 scaffold", () => {
  it("reports a non-empty semver-ish version", () => {
    const v = getVersion();
    expect(typeof v).toBe("string");
    expect(v).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("builds a commander program named skill-sniffer", () => {
    const program = buildProgram();
    expect(program.name()).toBe("skill-sniffer");
  });

  it("prints `sniffed: <file> 🐕` for a given path and exits 0", () => {
    const program = buildProgram();
    program.exitOverride();
    program.configureOutput({ writeOut: () => {}, writeErr: () => {} });

    let out = "";
    const original = process.stdout.write.bind(process.stdout);
    // @ts-expect-error narrow override for test capture
    process.stdout.write = (chunk: string) => {
      out += chunk;
      return true;
    };
    try {
      program.parse(["node", "skill-sniffer", "foo/SKILL.md"]);
    } finally {
      process.stdout.write = original;
    }

    expect(out).toContain("sniffed:");
    expect(out).toContain("foo/SKILL.md");
    expect(out).toContain("🐕");
  });
});
