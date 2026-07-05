import { describe, it, expect } from "vitest";
import { explain, renderRule, renderList } from "../src/explain.js";
import { rules, getRule } from "../src/rules/index.js";
import { buildProgram, EXIT } from "../src/cli.js";

/**
 * Strip ANSI color codes so assertions match on plain text regardless of the
 * terminal's color support (picocolors emits codes when stdout is a TTY).
 */
function plain(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;]*m/g, "");
}

describe("explain command (issue #22)", () => {
  describe("explain() core", () => {
    it("renders a known rule with id, severity, description, and rationale", () => {
      const result = explain("frontmatter");
      expect(result.exitCode).toBe(0);
      expect(result.stream).toBe("stdout");

      const text = plain(result.text);
      expect(text).toContain("frontmatter");
      expect(text).toContain("[error]"); // default severity badge
      expect(text).toContain("Require name + description frontmatter"); // description
      expect(text).toContain("Why this rule exists"); // rationale section
      expect(text).toContain("the only parts an agent sees"); // rationale body
    });

    it("renders the bad -> good example when a rule has one", () => {
      const text = plain(explain("secrets").text);
      expect(text).toContain("Example");
      expect(text).toContain("bad");
      expect(text).toContain("good");
      // The good snippet steers people to env vars.
      expect(text).toContain("$OPENAI_API_KEY");
    });

    it("exits non-zero and suggests valid ids for an unknown rule", () => {
      const result = explain("no-such-rule");
      expect(result.exitCode).toBe(2);
      expect(result.stream).toBe("stderr");

      const text = plain(result.text);
      expect(text).toContain("unknown rule id");
      expect(text).toContain("no-such-rule");
      // Every real rule id is offered as a suggestion.
      for (const r of rules) {
        expect(text).toContain(r.id);
      }
    });

    it("lists every registered rule id when called with no argument", () => {
      const result = explain();
      expect(result.exitCode).toBe(0);
      expect(result.stream).toBe("stdout");

      const text = plain(result.text);
      expect(text).toContain(`skill-sniffer rules (${rules.length})`);
      for (const r of rules) {
        expect(text).toContain(r.id);
        expect(text).toContain(r.description);
      }
    });

    it("falls back to the description when a rule has no rationale", () => {
      const bare = {
        id: "bare-rule",
        description: "a minimal rule with only id + description",
        defaultSeverity: "info" as const,
        run: () => [],
      };
      const text = plain(renderRule(bare));
      expect(text).toContain("bare-rule");
      expect(text).toContain("[info]");
      // Rationale section still renders, echoing the description.
      expect(text).toContain("Why this rule exists");
      expect(text).toContain("a minimal rule with only id + description");
      // No example section for a rule without one.
      expect(text).not.toContain("Example");
    });
  });

  describe("rule metadata", () => {
    it("gives every registered rule a non-empty rationale", () => {
      for (const r of rules) {
        expect(r.rationale, `rule ${r.id} should have a rationale`).toBeTruthy();
        expect((r.rationale as string).length).toBeGreaterThan(20);
      }
    });

    it("keeps getRule() consistent with the registry", () => {
      for (const r of rules) {
        expect(getRule(r.id)).toBe(r);
      }
      expect(getRule("definitely-not-a-rule")).toBeUndefined();
    });

    it("renderList mentions the total rule count and each id", () => {
      const text = plain(renderList());
      expect(text).toContain(`(${rules.length})`);
      for (const r of rules) expect(text).toContain(r.id);
    });
  });

  describe("CLI integration", () => {
    /** Run the program with args, capturing stdout+stderr and the exit code. */
    async function runCli(args: string[]): Promise<{ out: string; err: string; code: number }> {
      const program = buildProgram();
      program.exitOverride();
      program.configureOutput({ writeOut: () => {}, writeErr: () => {} });

      let out = "";
      let err = "";
      const origOut = process.stdout.write.bind(process.stdout);
      const origErr = process.stderr.write.bind(process.stderr);
      // @ts-expect-error narrow override for test capture
      process.stdout.write = (chunk: string) => ((out += chunk), true);
      // @ts-expect-error narrow override for test capture
      process.stderr.write = (chunk: string) => ((err += chunk), true);
      try {
        await program.parseAsync(["node", "skill-sniffer", ...args]);
      } finally {
        process.stdout.write = origOut;
        process.stderr.write = origErr;
      }
      const code = (program as unknown as { __exitCode?: number }).__exitCode ?? EXIT.OK;
      return { out: plain(out), err: plain(err), code };
    }

    it("`explain frontmatter` prints docs to stdout and exits 0", async () => {
      const { out, code } = await runCli(["explain", "frontmatter"]);
      expect(code).toBe(EXIT.OK);
      expect(out).toContain("frontmatter");
      expect(out).toContain("Why this rule exists");
    });

    it("`explain <unknown>` writes to stderr and exits non-zero", async () => {
      const { err, code } = await runCli(["explain", "bogus-id"]);
      expect(code).toBe(EXIT.USAGE);
      expect(err).toContain("unknown rule id");
      expect(err).toContain("bogus-id");
    });

    it("`explain` with no id lists all rules and exits 0", async () => {
      const { out, code } = await runCli(["explain"]);
      expect(code).toBe(EXIT.OK);
      expect(out).toContain(`skill-sniffer rules (${rules.length})`);
      for (const r of rules) expect(out).toContain(r.id);
    });
  });
});
