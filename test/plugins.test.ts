import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  normalizeConfig,
  defaultConfig,
  resolvePluginSpecifier,
  isLocalSpecifier,
  type RawConfig,
} from "../src/config.js";
import { loadPlugins } from "../src/plugins.js";
import { buildRuleSet, runEngine } from "../src/engine.js";
import { run, EXIT } from "../src/cli.js";
import { rules as builtinRules } from "../src/rules/index.js";
import type { ParsedSkill } from "../src/types.js";

const scratch: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "sniff-plugin-"));
  scratch.push(dir);
  return dir;
}
afterEach(() => {
  while (scratch.length) {
    const dir = scratch.pop()!;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

/** A skill fixture built in-memory (no disk needed for engine runs). */
function skill(overrides: Partial<ParsedSkill> = {}): ParsedSkill {
  return {
    path: "/virtual/SKILL.md",
    format: "skill",
    frontmatter: { name: "x", description: "y" },
    body: "hello world",
    raw: "hello world",
    ...overrides,
  };
}

/** Write a plugin .js file into `dir` and return its absolute path. */
function writePlugin(dir: string, name: string, source: string): string {
  const p = join(dir, name);
  writeFileSync(p, source, "utf8");
  return p;
}

/** A minimal well-formed plugin exporting a default Rule[]. */
const GOOD_PLUGIN = `
export default [
  {
    id: "no-hello",
    description: "flags the word hello",
    defaultSeverity: "warning",
    run(sk, ctx) {
      if (!sk.body.includes("hello")) return [];
      return [{
        ruleId: "no-hello",
        severity: ctx.severityFor(this, "warning"),
        message: "found hello",
        path: sk.path,
      }];
    },
  },
];
`;

describe("plugin specifier resolution", () => {
  it("classifies local vs bare specifiers", () => {
    expect(isLocalSpecifier("./local.js")).toBe(true);
    expect(isLocalSpecifier("../up.js")).toBe(true);
    expect(isLocalSpecifier("/abs/path.js")).toBe(true);
    expect(isLocalSpecifier("skill-sniffer-plugin-foo")).toBe(false);
    expect(isLocalSpecifier("@scope/pkg")).toBe(false);
  });

  it("resolves local specifiers against the base dir, leaves bare untouched", () => {
    expect(resolvePluginSpecifier("./r.js", "/base")).toBe("/base/r.js");
    expect(resolvePluginSpecifier("pkg-name", "/base")).toBe("pkg-name");
    expect(resolvePluginSpecifier("/already/abs.js", "/base")).toBe(
      "/already/abs.js",
    );
  });

  it("normalizeConfig resolves plugin paths relative to the config file", () => {
    const raw: RawConfig = { plugins: ["./rules.js", "pkg"] };
    const cfg = normalizeConfig(raw, "/proj/.skillsnifferrc");
    expect(cfg.plugins).toEqual(["/proj/rules.js", "pkg"]);
  });

  it("warns on non-array plugins and non-string entries", () => {
    const cfg = normalizeConfig({ plugins: 42 } as unknown as RawConfig);
    expect(cfg.plugins).toEqual([]);
    expect(cfg.warnings.some((w) => w.includes("plugins"))).toBe(true);

    const cfg2 = normalizeConfig({ plugins: ["ok", 5] } as unknown as RawConfig);
    expect(cfg2.plugins).toEqual(["ok"]);
    expect(cfg2.warnings.some((w) => w.includes("plugin entry"))).toBe(true);
  });
});

describe("loadPlugins", () => {
  it("loads a local plugin exporting a default Rule[]", async () => {
    const dir = tmp();
    const p = writePlugin(dir, "good.mjs", GOOD_PLUGIN);
    const cfg = { ...defaultConfig(), plugins: [p] };
    const { rules, errors } = await loadPlugins(cfg, ["frontmatter"]);
    expect(errors).toEqual([]);
    expect(rules).toHaveLength(1);
    expect(rules[0].id).toBe("no-hello");
  });

  it("accepts the { rules: [...] } export shape", async () => {
    const dir = tmp();
    const p = writePlugin(
      dir,
      "wrapped.mjs",
      GOOD_PLUGIN.replace("export default [", "export default { rules: [").replace(
        /\];\s*$/,
        "] };",
      ),
    );
    const cfg = { ...defaultConfig(), plugins: [p] };
    const { rules, errors } = await loadPlugins(cfg, []);
    expect(errors).toEqual([]);
    expect(rules.map((r) => r.id)).toEqual(["no-hello"]);
  });

  it("accepts a named `rules` export", async () => {
    const dir = tmp();
    const p = writePlugin(
      dir,
      "named.mjs",
      GOOD_PLUGIN.replace("export default [", "export const rules = ["),
    );
    const cfg = { ...defaultConfig(), plugins: [p] };
    const { rules, errors } = await loadPlugins(cfg, []);
    expect(errors).toEqual([]);
    expect(rules.map((r) => r.id)).toEqual(["no-hello"]);
  });

  it("errors clearly on a missing plugin, non-zero via caller", async () => {
    const cfg = { ...defaultConfig(), plugins: ["/does/not/exist.mjs"] };
    const { rules, errors } = await loadPlugins(cfg, []);
    expect(rules).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/failed to load plugin/);
  });

  it("errors on a wrong export shape", async () => {
    const dir = tmp();
    const p = writePlugin(dir, "wrong.mjs", `export default { nope: 1 };`);
    const cfg = { ...defaultConfig(), plugins: [p] };
    const { errors } = await loadPlugins(cfg, []);
    expect(errors[0]).toMatch(/expected a default export of Rule\[\]/);
  });

  it("errors on a rule missing id or run", async () => {
    const dir = tmp();
    const p = writePlugin(
      dir,
      "badrule.mjs",
      `export default [{ description: "x" }];`,
    );
    const cfg = { ...defaultConfig(), plugins: [p] };
    const { errors } = await loadPlugins(cfg, []);
    expect(errors[0]).toMatch(/missing a string "id"/);
  });

  it("reports a duplicate rule id against a built-in", async () => {
    const dir = tmp();
    const p = writePlugin(
      dir,
      "dup.mjs",
      GOOD_PLUGIN.replace(/id: "no-hello"/, 'id: "frontmatter"'),
    );
    const cfg = { ...defaultConfig(), plugins: [p] };
    const { rules, errors } = await loadPlugins(cfg, ["frontmatter"]);
    expect(rules).toEqual([]);
    expect(errors[0]).toMatch(/duplicate rule id "frontmatter".*built-in/);
  });

  it("reports a duplicate rule id across two plugins", async () => {
    const dir = tmp();
    const a = writePlugin(dir, "a.mjs", GOOD_PLUGIN);
    const b = writePlugin(dir, "b.mjs", GOOD_PLUGIN);
    const cfg = { ...defaultConfig(), plugins: [a, b] };
    const { rules, errors } = await loadPlugins(cfg, []);
    expect(rules).toHaveLength(1);
    expect(errors[0]).toMatch(/duplicate rule id "no-hello"/);
  });
});

describe("buildRuleSet + engine integration", () => {
  it("returns just built-ins when no plugins configured", async () => {
    const { rules, errors } = await buildRuleSet(defaultConfig());
    expect(errors).toEqual([]);
    expect(rules).toHaveLength(builtinRules.length);
  });

  it("merges plugin rules and they run through the normal engine", async () => {
    const dir = tmp();
    const p = writePlugin(dir, "good.mjs", GOOD_PLUGIN);
    const cfg = { ...defaultConfig(), plugins: [p] };
    const { rules, errors } = await buildRuleSet(cfg);
    expect(errors).toEqual([]);

    const report = runEngine([skill()], { config: cfg, rules });
    const mine = report.findings.filter((f) => f.ruleId === "no-hello");
    expect(mine).toHaveLength(1);
    expect(mine[0].message).toBe("found hello");
  });

  it("plugin rules respect config severity + enable overrides", async () => {
    const dir = tmp();
    const p = writePlugin(dir, "good.mjs", GOOD_PLUGIN);

    // Severity override.
    const cfg = {
      ...defaultConfig(),
      plugins: [p],
      rules: { "no-hello": { enabled: true, severity: "error" as const } },
    };
    const { rules } = await buildRuleSet(cfg);
    const report = runEngine([skill()], { config: cfg, rules });
    expect(
      report.findings.find((f) => f.ruleId === "no-hello")?.severity,
    ).toBe("error");

    // Disable override drops it entirely.
    const cfgOff = {
      ...defaultConfig(),
      plugins: [p],
      rules: { "no-hello": { enabled: false } },
    };
    const { rules: rulesOff } = await buildRuleSet(cfgOff);
    const reportOff = runEngine([skill()], { config: cfgOff, rules: rulesOff });
    expect(reportOff.findings.some((f) => f.ruleId === "no-hello")).toBe(false);
  });
});

describe("plugins end-to-end via the CLI", () => {
  function captureErr(): { restore: () => string } {
    let out = "";
    const original = process.stderr.write.bind(process.stderr);
    // @ts-expect-error test capture override
    process.stderr.write = (chunk: string) => {
      out += chunk;
      return true;
    };
    return { restore: () => ((process.stderr.write = original), out) };
  }

  it("a plugin rule fires on a sniffed file and gates the exit code", async () => {
    const dir = tmp();
    writePlugin(dir, "plugin.mjs", GOOD_PLUGIN);
    writeFileSync(
      join(dir, ".skillsnifferrc.json"),
      JSON.stringify({
        plugins: ["./plugin.mjs"],
        rules: { "no-hello": "error" },
      }),
      "utf8",
    );
    writeFileSync(
      join(dir, "SKILL.md"),
      "---\nname: x\ndescription: a fine skill\n---\nhello there\n",
      "utf8",
    );
    const code = await run(["node", "skill-sniffer", dir]);
    // The plugin's error-severity finding should fail the build.
    expect(code).toBe(EXIT.FINDINGS);
  });

  it("a duplicate rule id makes the CLI exit non-zero with a clear message", async () => {
    const dir = tmp();
    writePlugin(
      dir,
      "dup.mjs",
      GOOD_PLUGIN.replace(/id: "no-hello"/, 'id: "frontmatter"'),
    );
    writeFileSync(
      join(dir, ".skillsnifferrc.json"),
      JSON.stringify({ plugins: ["./dup.mjs"] }),
      "utf8",
    );
    writeFileSync(join(dir, "SKILL.md"), "---\nname: x\ndescription: y\n---\nhi\n", "utf8");
    const cap = captureErr();
    const code = await run(["node", "skill-sniffer", dir]);
    const err = cap.restore();
    expect(code).toBe(EXIT.USAGE);
    expect(err).toMatch(/duplicate rule id "frontmatter"/);
  });
});
