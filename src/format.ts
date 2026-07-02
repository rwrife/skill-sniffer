import type { SkillFormat } from "./types.js";

/**
 * skill-sniffer 🐕👃 — agent-context format detection (issue #10).
 *
 * Skills aren't the only agent-instruction files with footguns. This module
 * classifies a file path into a {@link SkillFormat} and owns the glob patterns
 * used to discover each format. Discovery + parsing thread the detected format
 * onto every `ParsedSkill` so rules can adapt: the format-agnostic rules
 * (secrets, injection, token-bloat, broken-paths) run on everything, while the
 * frontmatter *contract* (required `name`/`description`) only applies to native
 * `skill` files and degrades gracefully elsewhere.
 *
 * Everything here is pure string work — no disk, no network. Classification is
 * total (`unknown` is the catch-all) so callers never have to handle a null.
 */

/**
 * Per-format discovery globs, keyed by {@link SkillFormat}. `unknown` has none
 * (it's only ever produced by direct classification of an odd path, never
 * globbed for). Case-insensitive matching is applied by the discoverer, so a
 * lowercase `agents.md` or uppercase `CLAUDE.MD` still resolves.
 *
 * Notes on the patterns:
 * - **skill** — the native convention: `SKILL.md` at any depth plus the
 *   `*.skill.md` variant some toolchains use.
 * - **agents / claude** — repo-root-style instruction files, but authors nest
 *   them (e.g. per-package `AGENTS.md`), so we glob at any depth.
 * - **cursorrules** — Cursor's `.cursorrules` (legacy, repo-root) and the newer
 *   `.cursor/rules/*.mdc` project-rule files.
 * - **mcp** — MCP server manifests: a bare `mcp.json` or the `*.mcp.json`
 *   convention. JSON, not Markdown, but it still ships secrets/over-broad
 *   grants worth sniffing.
 */
export const FORMAT_GLOBS: Record<Exclude<SkillFormat, "unknown">, string[]> = {
  skill: ["**/SKILL.md", "**/*.skill.md"],
  agents: ["**/AGENTS.md"],
  claude: ["**/CLAUDE.md"],
  cursorrules: ["**/.cursorrules", "**/.cursor/rules/**/*.mdc"],
  mcp: ["**/mcp.json", "**/*.mcp.json"],
};

/** Every discoverable format, in a stable order (skills first). */
export const ALL_FORMATS: readonly Exclude<SkillFormat, "unknown">[] = [
  "skill",
  "agents",
  "claude",
  "cursorrules",
  "mcp",
] as const;

/**
 * Human-friendly labels for each format, used in reports/diagnostics. Keeps the
 * mapping in one place so the pretty reporter and docs stay consistent.
 */
export const FORMAT_LABELS: Record<SkillFormat, string> = {
  skill: "SKILL.md",
  agents: "AGENTS.md",
  claude: "CLAUDE.md",
  cursorrules: ".cursorrules",
  mcp: "MCP manifest",
  unknown: "unknown",
};

/**
 * Classify a file path into its {@link SkillFormat} purely from its name.
 *
 * Matching is case-insensitive and backslash-normalized (Windows paths), and
 * only the basename (plus, for `.cursor/rules`, a light path check) is
 * considered. Returns `"unknown"` when nothing matches so callers get a total
 * function — discovery only ever hands us paths it globbed, but direct-file
 * inputs can be anything.
 */
export function classifyFormat(filePath: string): SkillFormat {
  const norm = String(filePath).replace(/\\/g, "/").toLowerCase();
  const base = norm.slice(norm.lastIndexOf("/") + 1);

  if (base === "skill.md" || base.endsWith(".skill.md")) return "skill";
  if (base === "agents.md") return "agents";
  if (base === "claude.md") return "claude";
  if (base === ".cursorrules") return "cursorrules";
  // Cursor's newer project rules live under `.cursor/rules/**.mdc`.
  if (base.endsWith(".mdc") && norm.includes("/.cursor/rules/")) {
    return "cursorrules";
  }
  if (base === "mcp.json" || base.endsWith(".mcp.json")) return "mcp";

  return "unknown";
}

/**
 * True when a file path matches *any* known agent-context format. Used by
 * discovery to decide whether a directly-passed file is worth including.
 */
export function isKnownFormat(filePath: string): boolean {
  return classifyFormat(filePath) !== "unknown";
}

/**
 * True for the native skill format (`SKILL.md` / `*.skill.md`) — the only one
 * that carries a frontmatter *contract*. Rules use this to decide whether to
 * enforce required `name`/`description` fields. A missing/undefined format is
 * treated as `"skill"` for back-compatibility with hand-built `ParsedSkill`s.
 */
export function isSkillFormat(format: SkillFormat | undefined): boolean {
  return format === undefined || format === "skill";
}

/**
 * Resolve the set of formats to scan from `--include` / `--exclude` selectors.
 *
 * - With no selectors, every format is scanned (the default, back-compatible
 *   with the skills-only behavior since skills are always included).
 * - `include` narrows to exactly the named formats (order-independent; the
 *   returned list keeps {@link ALL_FORMATS} order for determinism).
 * - `exclude` removes formats from whatever the include step produced.
 *
 * Unknown selector names are ignored here (the CLI validates + warns on them),
 * so this stays a pure set operation that never throws.
 */
export function resolveFormats(opts: {
  include?: readonly string[];
  exclude?: readonly string[];
}): Exclude<SkillFormat, "unknown">[] {
  const includeSet = normalizeSelectors(opts.include);
  const excludeSet = normalizeSelectors(opts.exclude);

  return ALL_FORMATS.filter((fmt) => {
    if (includeSet.size > 0 && !includeSet.has(fmt)) return false;
    if (excludeSet.has(fmt)) return false;
    return true;
  });
}

/**
 * Aliases accepted from `--include` / `--exclude` so users can type the natural
 * thing (`agents.md`, `claude`, `cursor`, `mcp`) and land on a canonical id.
 */
const FORMAT_ALIASES: Record<string, Exclude<SkillFormat, "unknown">> = {
  skill: "skill",
  skills: "skill",
  "skill.md": "skill",
  agents: "agents",
  "agents.md": "agents",
  agent: "agents",
  claude: "claude",
  "claude.md": "claude",
  cursorrules: "cursorrules",
  ".cursorrules": "cursorrules",
  cursor: "cursorrules",
  mcp: "mcp",
  "mcp.json": "mcp",
};

/** Canonicalize a single selector string, or `undefined` if unrecognized. */
export function canonicalFormat(
  selector: string,
): Exclude<SkillFormat, "unknown"> | undefined {
  return FORMAT_ALIASES[selector.trim().toLowerCase()];
}

/** Map a list of raw selectors to a set of canonical format ids. */
function normalizeSelectors(
  selectors: readonly string[] | undefined,
): Set<Exclude<SkillFormat, "unknown">> {
  const out = new Set<Exclude<SkillFormat, "unknown">>();
  for (const raw of selectors ?? []) {
    const canon = canonicalFormat(raw);
    if (canon) out.add(canon);
  }
  return out;
}
