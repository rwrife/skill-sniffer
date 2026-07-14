import { pathToFileURL } from "node:url";
import type { Rule, Severity } from "./types.js";
import { isLocalSpecifier, type ResolvedConfig } from "./config.js";

/**
 * skill-sniffer 🐕👃 — custom rule plugins (issue #39, PLAN §8.3).
 *
 * Lets a project extend the linter with its own rules via `plugins` in
 * `.skillsnifferrc`. Each entry is either a bare node-module specifier
 * (`"skill-sniffer-plugin-foo"`) or a local path (`"./local-rules.js"`, already
 * resolved to an absolute path by `normalizeConfig`). A plugin module exports a
 * `Rule[]` — either as its default export, a named `rules` export, or an object
 * `{ rules: Rule[] }` — and those rules merge into the registry alongside the
 * built-ins.
 *
 * Offline by design: plugins are loaded with a plain dynamic `import`, which
 * only touches the local module graph / filesystem. Nothing here ever installs
 * or fetches over the network — the same "no telemetry, no surprises" contract
 * as the rest of the tool.
 *
 * Loading is *strict about correctness but never silently wrong*: a plugin that
 * can't be imported, exports the wrong shape, or introduces a duplicate rule id
 * produces a clear error the CLI turns into a non-zero exit. That's deliberate —
 * a broken custom rule set should fail loudly, not quietly skip checks you think
 * are running.
 */

/** Result of loading all configured plugins for a run. */
export interface PluginLoadResult {
  /** Plugin-contributed rules, in config declaration order. */
  rules: Rule[];
  /** Fatal problems encountered (bad import, wrong shape, duplicate id). */
  errors: string[];
}

const VALID_SEVERITIES: readonly Severity[] = ["error", "warning", "info"];

/**
 * Load every plugin named in `config.plugins`, in order, and return their
 * combined rules plus any errors. Duplicate rule ids — whether a plugin
 * collides with a built-in or with another plugin — are reported as errors and
 * the offending rule is dropped so the run can still surface the problem.
 *
 * `builtinIds` is the set of ids already claimed by the core registry; pass it
 * so plugin authors can't silently shadow (or be shadowed by) a built-in rule.
 */
export async function loadPlugins(
  config: ResolvedConfig,
  builtinIds: Iterable<string>,
): Promise<PluginLoadResult> {
  const rules: Rule[] = [];
  const errors: string[] = [];
  const seen = new Map<string, string>(); // ruleId → source label

  for (const id of builtinIds) seen.set(id, "built-in");

  for (const spec of config.plugins) {
    let mod: unknown;
    try {
      mod = await importPlugin(spec);
    } catch (err) {
      errors.push(
        `failed to load plugin "${spec}": ${(err as Error).message}`,
      );
      continue;
    }

    const extracted = extractRules(mod);
    if (!extracted.ok) {
      errors.push(`plugin "${spec}": ${extracted.error}`);
      continue;
    }

    for (const [index, candidate] of extracted.rules.entries()) {
      const check = validateRule(candidate, index);
      if (!check.ok) {
        errors.push(`plugin "${spec}": ${check.error}`);
        continue;
      }
      const rule = check.rule;
      const prior = seen.get(rule.id);
      if (prior !== undefined) {
        errors.push(
          `plugin "${spec}": duplicate rule id "${rule.id}" (already provided by ${prior})`,
        );
        continue;
      }
      seen.set(rule.id, `plugin "${spec}"`);
      rules.push(rule);
    }
  }

  return { rules, errors };
}

/**
 * Dynamically import a plugin specifier. Local (absolute) paths are converted to
 * a `file://` URL so ESM import works on all platforms; bare specifiers go
 * through normal node module resolution.
 */
async function importPlugin(spec: string): Promise<unknown> {
  const target = isLocalSpecifier(spec) ? pathToFileURL(spec).href : spec;
  return import(target);
}

/** Result of pulling a `Rule[]` out of an imported module. */
type ExtractResult =
  | { ok: true; rules: unknown[] }
  | { ok: false; error: string };

/**
 * Extract the rule array from a loaded module, accepting the documented shapes:
 *   - `export default [rule, ...]`
 *   - `export default { rules: [rule, ...] }`
 *   - `export const rules = [rule, ...]`
 * ESM modules expose named/default exports on the namespace object; we probe
 * `default` first (the primary contract) then a top-level `rules`.
 */
function extractRules(mod: unknown): ExtractResult {
  const ns = mod as Record<string, unknown> | null;
  if (ns === null || typeof ns !== "object") {
    return { ok: false, error: "module did not export an object" };
  }

  const candidates: unknown[] = [ns.default, (ns as { rules?: unknown }).rules];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return { ok: true, rules: candidate };
    if (
      candidate &&
      typeof candidate === "object" &&
      Array.isArray((candidate as { rules?: unknown }).rules)
    ) {
      return { ok: true, rules: (candidate as { rules: unknown[] }).rules };
    }
  }

  return {
    ok: false,
    error:
      "expected a default export of Rule[] (or { rules: Rule[] }, or a named `rules` export)",
  };
}

/** Result of validating one plugin-provided rule candidate. */
type RuleCheck = { ok: true; rule: Rule } | { ok: false; error: string };

/**
 * Structurally validate a plugin rule: it must have a non-empty string `id`, a
 * `run` function, and (if present) a valid `defaultSeverity`. Missing
 * `defaultSeverity` defaults to `"warning"` so minimal plugins still work.
 */
function validateRule(candidate: unknown, index: number): RuleCheck {
  if (candidate === null || typeof candidate !== "object") {
    return { ok: false, error: `rule at index ${index} is not an object` };
  }
  const r = candidate as Partial<Rule>;
  if (typeof r.id !== "string" || r.id.trim() === "") {
    return { ok: false, error: `rule at index ${index} is missing a string "id"` };
  }
  if (typeof r.run !== "function") {
    return { ok: false, error: `rule "${r.id}" is missing a "run" function` };
  }
  if (
    r.defaultSeverity !== undefined &&
    !VALID_SEVERITIES.includes(r.defaultSeverity)
  ) {
    return {
      ok: false,
      error: `rule "${r.id}" has invalid defaultSeverity "${String(
        r.defaultSeverity,
      )}" (use ${VALID_SEVERITIES.join("/")})`,
    };
  }

  const rule: Rule = {
    id: r.id,
    description: typeof r.description === "string" ? r.description : r.id,
    defaultSeverity: r.defaultSeverity ?? "warning",
    rationale: r.rationale,
    example: r.example,
    run: r.run,
  };
  return { ok: true, rule };
}
