import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, parse as parsePath, resolve } from "node:path";
import matter from "gray-matter";
import type { Rule, Severity } from "./types.js";
import { DEFAULT_TOKEN_BUDGET } from "./rules/token-bloat.js";

/**
 * skill-sniffer 🐕👃 — `.skillsnifferrc` config loading (issue #8).
 *
 * Lets a project tune the dog: enable/disable rules by id, override per-rule
 * severity, and set the token budget + CI-gate defaults (`min-score`,
 * `max-warnings`). The contract, in priority order (highest wins):
 *
 *   built-in defaults  <  .skillsnifferrc  <  CLI flags
 *
 * Config is discovered by walking **upward** from the target path(s) until a
 * recognized rc file is found (or the filesystem root), matching how tools like
 * ESLint/Prettier resolve project config. Zero network, zero new deps: JSON is
 * parsed with `JSON.parse`; YAML reuses the `js-yaml` engine already bundled
 * inside `gray-matter` (our frontmatter parser), so `.yaml`/`.yml` configs work
 * without adding a dependency.
 *
 * Everything here is forgiving by design — a config file is a convenience, not
 * a landmine. Unknown keys are ignored (with the option to surface warnings),
 * bad types fall back to defaults rather than throwing, and a malformed file
 * raises a single clear error the CLI turns into a usage message.
 */

/** Recognized config filenames, in discovery precedence (first match wins). */
export const CONFIG_FILENAMES = [
  ".skillsnifferrc",
  ".skillsnifferrc.json",
  ".skillsnifferrc.yaml",
  ".skillsnifferrc.yml",
] as const;

/** The set of rule ids the config may reference (for validation warnings). */
export const KNOWN_RULE_IDS = [
  "frontmatter",
  "secrets",
  "injection",
  "provenance",
  "tool-scope",
  "broken-paths",
  "token-bloat",
] as const;

/** Valid severity strings a config may assign to a rule. */
const SEVERITIES: readonly Severity[] = ["error", "warning", "info"];

/**
 * Per-rule setting as it may appear in a config file. Accepts several ergonomic
 * spellings:
 *   - `false` / `"off"`           → disable the rule
 *   - `true`  / `"on"`            → enable (keep default severity)
 *   - `"error" | "warning" | "info"` → enable + override severity
 *   - `{ enabled?, severity? }`   → explicit object form
 */
export type RuleSetting =
  | boolean
  | "off"
  | "on"
  | Severity
  | { enabled?: boolean; severity?: Severity };

/** The raw, user-authored config shape (everything optional, loosely typed). */
export interface RawConfig {
  tokenBudget?: number;
  minScore?: number;
  maxWarnings?: number;
  rules?: Record<string, RuleSetting>;
  /**
   * Custom rule plugins (issue #39, PLAN §8.3). Each entry is either a
   * node-module specifier (`"skill-sniffer-plugin-foo"`) or a local path
   * (`"./local-rules.js"`), resolved offline against the config file's dir.
   */
  plugins?: string[];
  /**
   * Versioned injection signature pack (issue #40, PLAN §8.9). A local file
   * path (resolved offline against the config file's dir) pointing at a
   * custom/newer injection pack; overrides the bundled default.
   */
  injectionPack?: string;
  /** Baseline-diff gate defaults (issue #32). */
  baseline?: { maxNewFindings?: number; maxScoreDrop?: number };
  /** Tolerated and ignored — lets the stub advertise a schema id. */
  $schema?: string;
}

/**
 * A fully-resolved rule override: whether the rule runs at all, and an optional
 * severity that replaces the rule's own per-finding choice.
 */
export interface ResolvedRuleConfig {
  enabled: boolean;
  severity?: Severity;
}

/**
 * The normalized config the engine + CLI consume. Always fully populated:
 * numeric knobs carry their effective values and `rules` has an entry for every
 * id the config mentioned. `sourcePath` is the file it came from (or
 * `undefined` for pure defaults), handy for diagnostics.
 */
export interface ResolvedConfig {
  tokenBudget: number;
  /** `undefined` means "no min-score gate" (default). */
  minScore?: number;
  /** `undefined` means "no max-warnings gate" (default). */
  maxWarnings?: number;
  /**
   * Baseline-diff gate defaults (issue #32). `undefined` means "no default"
   * (falls back to the built-in 0). CLI flags still override these.
   */
  baselineMaxNewFindings?: number;
  baselineMaxScoreDrop?: number;
  /**
   * Custom rule plugin specifiers (issue #39), in declaration order. Local
   * paths are resolved to absolute against the config file's directory; bare
   * specifiers are left as-is for node module resolution. Empty when none.
   */
  plugins: string[];
  /**
   * Absolute path to a custom injection signature pack (issue #40), or
   * `undefined` to use the bundled default. Resolved against the config dir.
   */
  injectionPack?: string;
  /** Per-rule resolution keyed by rule id. Missing id ⇒ rule runs as default. */
  rules: Record<string, ResolvedRuleConfig>;
  /** Absolute path the config was loaded from, if any. */
  sourcePath?: string;
  /** Non-fatal validation notes (unknown rule ids, ignored keys, etc.). */
  warnings: string[];
}

/** The baseline config used when no file is found and no overrides apply. */
export function defaultConfig(): ResolvedConfig {
  return {
    tokenBudget: DEFAULT_TOKEN_BUDGET,
    minScore: undefined,
    maxWarnings: undefined,
    baselineMaxNewFindings: undefined,
    baselineMaxScoreDrop: undefined,
    plugins: [],
    injectionPack: undefined,
    rules: {},
    sourcePath: undefined,
    warnings: [],
  };
}

/**
 * Walk upward from `start` looking for the first recognized config file.
 *
 * `start` may be a file or a directory; files resolve to their parent dir. We
 * climb one directory at a time until a config is found or we hit the FS root.
 * Returns the absolute path of the first hit, or `undefined` if none exists.
 */
export function findConfigFile(start: string): string | undefined {
  let dir = resolve(start);
  // If `start` points at a file, begin the search in its directory.
  try {
    if (existsSync(dir) && isFile(dir)) dir = dirname(dir);
  } catch {
    dir = dirname(dir);
  }

  const { root } = parsePath(dir);
  // Bounded climb: at most until the filesystem root.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    for (const name of CONFIG_FILENAMES) {
      const candidate = resolve(dir, name);
      if (existsSync(candidate) && isFile(candidate)) return candidate;
    }
    if (dir === root) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/**
 * Discover a config for a run, given the CLI target paths.
 *
 * Searches upward from the **first** target path (the common case is a single
 * path; for multiple, the first one anchors discovery — projects keep one rc at
 * the root anyway). Returns `undefined` when nothing is found so callers can
 * fall back to {@link defaultConfig}.
 */
export function discoverConfigPath(paths: readonly string[]): string | undefined {
  const anchor = paths.length > 0 ? paths[0] : process.cwd();
  return findConfigFile(anchor);
}

/**
 * Parse a config file's text into a {@link RawConfig}.
 *
 * Format is chosen by extension: `.json` (and the extension-less
 * `.skillsnifferrc`, which we treat as JSON-first) parse as JSON; `.yaml`/`.yml`
 * parse as YAML. YAML is read through `gray-matter` (our existing frontmatter
 * parser, which bundles `js-yaml`) by framing the body as a frontmatter block —
 * no new dependency, and because JSON is a subset of YAML the extension-less
 * dotfile accepts either flavor transparently.
 *
 * Throws a single descriptive `Error` on malformed input — the CLI converts
 * that into a usage error rather than a stack trace.
 */
export function parseConfigText(text: string, filename: string): RawConfig {
  const ext = extOf(filename);

  const asJson = (): unknown => JSON.parse(text);
  // Frame the text as a YAML frontmatter block so gray-matter's bundled
  // js-yaml parses it. Empty input yields `{}`. JSON parses too (JSON ⊂ YAML).
  const asYaml = (): unknown => matter(`---\n${text}\n---\n`).data ?? {};

  let data: unknown;
  try {
    if (ext === ".yaml" || ext === ".yml") {
      data = asYaml();
    } else if (ext === ".json") {
      data = asJson();
    } else {
      // Extension-less `.skillsnifferrc`: prefer JSON, fall back to YAML.
      try {
        data = asJson();
      } catch {
        data = asYaml();
      }
    }
  } catch (err) {
    throw new Error(
      `failed to parse config ${filename}: ${(err as Error).message}`,
    );
  }

  if (data === null || data === undefined) return {};
  if (typeof data !== "object" || Array.isArray(data)) {
    throw new Error(
      `config ${filename} must be a JSON/YAML object, got ${describeType(data)}`,
    );
  }
  return data as RawConfig;
}

/**
 * Normalize a {@link RawConfig} into a fully-resolved, validated config.
 *
 * Validation is *lenient*: bad values are dropped (with a warning) rather than
 * fatal, so a single typo doesn't block a lint run. Recognized issues are
 * collected in `warnings` for the CLI to surface. `sourcePath` is threaded
 * through for diagnostics.
 */
export function normalizeConfig(
  raw: RawConfig,
  sourcePath?: string,
): ResolvedConfig {
  const cfg = defaultConfig();
  cfg.sourcePath = sourcePath;
  const warnings = cfg.warnings;

  // --- numeric knobs ------------------------------------------------------
  if (raw.tokenBudget !== undefined) {
    const n = asPositiveInt(raw.tokenBudget);
    if (n === undefined) {
      warnings.push(
        `ignoring "tokenBudget": expected a positive integer, got ${describeType(raw.tokenBudget)}`,
      );
    } else {
      cfg.tokenBudget = n;
    }
  }

  if (raw.minScore !== undefined) {
    const n = asInt(raw.minScore);
    if (n === undefined || n < 0 || n > 100) {
      warnings.push(
        `ignoring "minScore": expected an integer 0–100, got ${describeType(raw.minScore)}`,
      );
    } else if (n > 0) {
      // 0 means "no gate" (the stub default) — valid, just no gate. Only a
      // positive score installs an actual gate.
      cfg.minScore = n;
    }
  }

  if (raw.maxWarnings !== undefined) {
    const n = asInt(raw.maxWarnings);
    if (n === undefined) {
      warnings.push(
        `ignoring "maxWarnings": expected an integer ≥ 0 (or -1 to disable), got ${describeType(raw.maxWarnings)}`,
      );
    } else if (n >= 0) {
      // A negative value (e.g. the stub's -1 default) is the documented
      // "disable" sentinel — valid, install no gate and stay silent.
      cfg.maxWarnings = n;
    }
  }

  // --- baseline gate defaults (issue #32) ---------------------------------
  if (raw.baseline !== undefined) {
    if (
      typeof raw.baseline !== "object" ||
      raw.baseline === null ||
      Array.isArray(raw.baseline)
    ) {
      warnings.push(
        `ignoring "baseline": expected an object, got ${describeType(raw.baseline)}`,
      );
    } else {
      const { maxNewFindings, maxScoreDrop } = raw.baseline;
      if (maxNewFindings !== undefined) {
        const n = asInt(maxNewFindings);
        if (n === undefined || n < 0) {
          warnings.push(
            `ignoring "baseline.maxNewFindings": expected an integer ≥ 0, got ${describeType(maxNewFindings)}`,
          );
        } else {
          cfg.baselineMaxNewFindings = n;
        }
      }
      if (maxScoreDrop !== undefined) {
        const n = asInt(maxScoreDrop);
        if (n === undefined || n < 0) {
          warnings.push(
            `ignoring "baseline.maxScoreDrop": expected an integer ≥ 0, got ${describeType(maxScoreDrop)}`,
          );
        } else {
          cfg.baselineMaxScoreDrop = n;
        }
      }
    }
  }

  // --- custom rule plugins (issue #39) ------------------------------------
  if (raw.plugins !== undefined) {
    if (!Array.isArray(raw.plugins)) {
      warnings.push(
        `ignoring "plugins": expected an array of specifiers, got ${describeType(raw.plugins)}`,
      );
    } else {
      // Resolve local paths against the config file's directory so relative
      // specifiers mean "relative to .skillsnifferrc", not the cwd. Bare
      // node-module specifiers are passed through untouched.
      const baseDir = sourcePath ? dirname(sourcePath) : process.cwd();
      for (const entry of raw.plugins) {
        if (typeof entry !== "string" || entry.trim() === "") {
          warnings.push(
            `ignoring plugin entry: expected a non-empty string, got ${describeType(entry)}`,
          );
          continue;
        }
        cfg.plugins.push(resolvePluginSpecifier(entry.trim(), baseDir));
      }
    }
  }

  // --- injection pack override (issue #40) --------------------------------
  if (raw.injectionPack !== undefined) {
    if (typeof raw.injectionPack !== "string" || raw.injectionPack.trim() === "") {
      warnings.push(
        `ignoring "injectionPack": expected a non-empty file path, got ${describeType(raw.injectionPack)}`,
      );
    } else {
      const baseDir = sourcePath ? dirname(sourcePath) : process.cwd();
      cfg.injectionPack = resolve(baseDir, raw.injectionPack.trim());
    }
  }

  // --- per-rule settings --------------------------------------------------
  if (raw.rules !== undefined) {
    if (typeof raw.rules !== "object" || raw.rules === null || Array.isArray(raw.rules)) {
      warnings.push(
        `ignoring "rules": expected an object mapping rule id → setting, got ${describeType(raw.rules)}`,
      );
    } else {
      for (const [id, setting] of Object.entries(raw.rules)) {
        if (!KNOWN_RULE_IDS.includes(id as (typeof KNOWN_RULE_IDS)[number])) {
          warnings.push(
            `unknown rule "${id}" in "rules" (known: ${KNOWN_RULE_IDS.join(", ")})`,
          );
          // Still record it — harmless, and forward-compatible with new rules.
        }
        const resolved = resolveRuleSetting(setting);
        if (!resolved.ok) {
          warnings.push(`ignoring rule "${id}": ${resolved.error}`);
          continue;
        }
        cfg.rules[id] = resolved.value;
      }
    }
  }

  return cfg;
}

/**
 * Load + normalize the config for a set of target paths.
 *
 * - `explicitPath` (from `--config`) short-circuits discovery and **must**
 *   exist (a missing explicit config is a usage error — the user named it).
 * - Otherwise discovery walks upward from the first target path.
 * - When `enabled` is `false` (`--no-config`), discovery is skipped entirely
 *   and built-in defaults are returned.
 *
 * Never throws for a *missing* discovered file (that's the normal no-config
 * case); only an explicitly-named-but-absent file or a malformed file throws.
 */
export function loadConfig(
  paths: readonly string[],
  opts: { explicitPath?: string; enabled?: boolean; injectionPack?: string } = {},
): ResolvedConfig {
  const { explicitPath, enabled = true, injectionPack } = opts;

  const applyOverrides = (cfg: ResolvedConfig): ResolvedConfig => {
    if (injectionPack !== undefined && injectionPack.trim() !== "") {
      // A CLI --injection-pack is resolved against the cwd and wins over config.
      cfg.injectionPack = resolve(process.cwd(), injectionPack.trim());
    }
    return cfg;
  };

  if (!enabled) return applyOverrides(defaultConfig());

  let sourcePath: string | undefined;
  if (explicitPath) {
    const abs = isAbsolute(explicitPath)
      ? explicitPath
      : resolve(process.cwd(), explicitPath);
    if (!existsSync(abs)) {
      throw new Error(`config file not found: ${explicitPath}`);
    }
    sourcePath = abs;
  } else {
    sourcePath = discoverConfigPath(paths);
  }

  if (!sourcePath) return applyOverrides(defaultConfig());

  let text: string;
  try {
    text = readFileSync(sourcePath, "utf8");
  } catch (err) {
    throw new Error(
      `failed to read config ${sourcePath}: ${(err as Error).message}`,
    );
  }

  const raw = parseConfigText(text, sourcePath);
  return applyOverrides(normalizeConfig(raw, sourcePath));
}

/**
 * Apply config to the rule set: drop disabled rules, keep the rest in order.
 *
 * Severity overrides are *not* applied here — they're enforced at finding time
 * via the engine's {@link RuleContext} so each rule still picks its own
 * per-finding severity unless the config overrides its whole id. This function
 * only decides *which* rules run.
 */
export function selectRules(
  rules: readonly Rule[],
  config: ResolvedConfig,
): Rule[] {
  return rules.filter((rule) => config.rules[rule.id]?.enabled !== false);
}

// ---------------------------------------------------------------------------
// internal helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a plugin specifier for later loading.
 *
 * A specifier is treated as a **local path** when it is absolute or begins with
 * `.` / `/` (or a `~` home ref) — those are resolved to an absolute path against
 * `baseDir` so they mean "relative to the config file". Anything else is a bare
 * node-module specifier and is returned unchanged for node resolution.
 */
export function resolvePluginSpecifier(spec: string, baseDir: string): string {
  if (isLocalSpecifier(spec)) {
    if (isAbsolute(spec)) return spec;
    return resolve(baseDir, spec);
  }
  return spec;
}

/** True when a plugin specifier names a local file path rather than a package. */
export function isLocalSpecifier(spec: string): boolean {
  return (
    isAbsolute(spec) ||
    spec.startsWith("./") ||
    spec.startsWith("../") ||
    spec.startsWith(".\\") ||
    spec.startsWith("..\\") ||
    spec === "." ||
    spec === ".."
  );
}

/** Outcome of resolving one raw rule setting: ok with a value, or an error. */
type RuleSettingResult =
  | { ok: true; value: ResolvedRuleConfig }
  | { ok: false; error: string };

/** Resolve one raw rule setting into `{ enabled, severity? }` or an error. */
function resolveRuleSetting(setting: RuleSetting): RuleSettingResult {
  // boolean → enable/disable, keep default severity.
  if (typeof setting === "boolean") {
    return { ok: true, value: { enabled: setting } };
  }

  if (typeof setting === "string") {
    const s = setting.toLowerCase();
    if (s === "off" || s === "false" || s === "disabled") {
      return { ok: true, value: { enabled: false } };
    }
    if (s === "on" || s === "true" || s === "enabled") {
      return { ok: true, value: { enabled: true } };
    }
    if (isSeverity(s)) {
      return { ok: true, value: { enabled: true, severity: s } };
    }
    return {
      ok: false,
      error: `unrecognized setting "${setting}" (use off/on or a severity: ${SEVERITIES.join("/")})`,
    };
  }

  if (setting && typeof setting === "object" && !Array.isArray(setting)) {
    const out: ResolvedRuleConfig = { enabled: true };
    if (setting.enabled !== undefined) {
      if (typeof setting.enabled !== "boolean") {
        return { ok: false, error: `"enabled" must be a boolean` };
      }
      out.enabled = setting.enabled;
    }
    if (setting.severity !== undefined) {
      if (!isSeverity(setting.severity)) {
        return {
          ok: false,
          error: `"severity" must be one of ${SEVERITIES.join("/")}`,
        };
      }
      out.severity = setting.severity;
    }
    return { ok: true, value: out };
  }

  return { ok: false, error: `expected a boolean, severity string, or object` };
}

/** Type guard for the {@link Severity} union. */
function isSeverity(value: unknown): value is Severity {
  return typeof value === "string" && (SEVERITIES as readonly string[]).includes(value);
}

/** Coerce to a positive (> 0) integer, or `undefined` if not one. */
function asPositiveInt(value: unknown): number | undefined {
  const n = asInt(value);
  return n !== undefined && n > 0 ? n : undefined;
}

/** Coerce to a finite integer, or `undefined`. Strings of digits are accepted. */
function asInt(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isInteger(value) ? value : undefined;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isInteger(n) ? n : undefined;
  }
  return undefined;
}

/** Lowercased file extension including the dot (e.g. ".json"), or "". */
function extOf(filename: string): string {
  const { ext } = parsePath(filename);
  return ext.toLowerCase();
}

/** Best-effort "is this path a regular file" check that never throws. */
function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Human-readable type label for diagnostics. */
function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}
