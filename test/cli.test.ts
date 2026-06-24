import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
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

  it("sniffs a clean skill file and wags (no findings)", async () => {
    const fixture = join(
      dirname(fileURLToPath(import.meta.url)),
      "fixtures",
      "valid",
      "SKILL.md",
    );

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
      await program.parseAsync(["node", "skill-sniffer", fixture]);
    } finally {
      process.stdout.write = original;
    }

    expect(out).toContain("good boy");
    expect(out).toContain("🐕");
  });
});
