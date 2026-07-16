import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Versioned prompt-injection signature packs (issue #40, PLAN §8.9).
 *
 * The prompt-injection rule's bait signatures live in an updatable JSON pack
 * rather than inline regexes, so signatures can evolve without a code release
 * and stay auditable. A default pack ships bundled (`packs/injection/v1.json`,
 * copied into `dist/` at build time); projects can point at a custom/newer pack
 * via `--injection-pack <file>` or config `injectionPack` (local file only,
 * offline).
 */

/** One bait signature as authored in a pack JSON. */
export interface PackSignature {
  /** Stable id for the signature (for auditing/diffing packs). */
  id: string;
  /** Human-facing label used in the finding message. */
  label: string;
  /** Regex source string. */
  pattern: string;
  /** Regex flags (e.g. `"i"`). `i` is forced on for case-insensitive scanning. */
  flags?: string;
  /** Severity for hits. */
  severity: "error" | "warning";
  /** Optional human note about what the signature catches. */
  description?: string;
  /**
   * Detector family. `"phrase"` (default) scans the raw text for bait phrases;
   * `"comment"` matches agent-directed HTML comments and reports a fixed
   * message rather than the matched snippet.
   */
  kind?: "phrase" | "comment";
}

/** A signature with its pattern compiled to a RegExp, ready for the engine. */
export interface CompiledSignature extends PackSignature {
  re: RegExp;
  kind: "phrase" | "comment";
}

/** A fully-loaded, compiled injection pack. */
export interface InjectionPack {
  version: string;
  description?: string;
  signatures: CompiledSignature[];
  /** Where the pack came from: `"bundled"` or an absolute file path. */
  source: string;
}

/** Result of a load attempt: the pack on success, or a fatal error message. */
export type LoadPackResult =
  | { ok: true; pack: InjectionPack }
  | { ok: false; error: string };

/** Absolute path to the bundled default pack, resolved relative to this module. */
export function bundledInjectionPackPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "packs/injection/v1.json");
}

/**
 * Load and validate an injection pack from a JSON file. Any structural problem
 * (unreadable file, bad JSON, missing/duplicate/invalid signatures, unparseable
 * regex) is reported as a single fatal error — no partial packs.
 */
export function loadInjectionPack(file: string): LoadPackResult {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    return { ok: false, error: `cannot read injection pack "${file}": ${(err as Error).message}` };
  }

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: `injection pack "${file}" is not valid JSON: ${(err as Error).message}` };
  }

  return compileInjectionPack(data, file);
}

/** Load the bundled default pack. Bundled pack problems are treated as fatal. */
export function loadBundledInjectionPack(): InjectionPack {
  const path = bundledInjectionPackPath();
  const result = loadInjectionPack(path);
  if (!result.ok) {
    // The bundled pack is shipped with the tool; a failure here is a build bug.
    throw new Error(`bundled injection pack failed to load: ${result.error}`);
  }
  return { ...result.pack, source: "bundled" };
}

/**
 * Validate + compile a parsed pack object. Exported so tests can exercise
 * malformed shapes without touching disk. `source` labels the pack's origin.
 */
export function compileInjectionPack(data: unknown, source: string): LoadPackResult {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return { ok: false, error: `injection pack "${source}": expected a JSON object` };
  }
  const obj = data as Record<string, unknown>;

  const version =
    typeof obj.version === "string"
      ? obj.version
      : typeof obj.version === "number"
        ? String(obj.version)
        : undefined;
  if (version === undefined || version.trim() === "") {
    return { ok: false, error: `injection pack "${source}": missing or invalid "version"` };
  }

  if (!Array.isArray(obj.signatures)) {
    return { ok: false, error: `injection pack "${source}": "signatures" must be an array` };
  }
  if (obj.signatures.length === 0) {
    return { ok: false, error: `injection pack "${source}": "signatures" is empty` };
  }

  const compiled: CompiledSignature[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < obj.signatures.length; i++) {
    const raw = obj.signatures[i];
    const where = `signature #${i + 1}`;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return { ok: false, error: `injection pack "${source}": ${where} is not an object` };
    }
    const sig = raw as Record<string, unknown>;

    if (typeof sig.id !== "string" || sig.id.trim() === "") {
      return { ok: false, error: `injection pack "${source}": ${where} has an invalid "id"` };
    }
    if (seen.has(sig.id)) {
      return { ok: false, error: `injection pack "${source}": duplicate signature id "${sig.id}"` };
    }
    seen.add(sig.id);

    if (typeof sig.label !== "string" || sig.label.trim() === "") {
      return { ok: false, error: `injection pack "${source}": signature "${sig.id}" has an invalid "label"` };
    }
    if (typeof sig.pattern !== "string" || sig.pattern === "") {
      return { ok: false, error: `injection pack "${source}": signature "${sig.id}" has an invalid "pattern"` };
    }
    if (sig.severity !== "error" && sig.severity !== "warning") {
      return {
        ok: false,
        error: `injection pack "${source}": signature "${sig.id}" has an invalid "severity" (expected "error" or "warning")`,
      };
    }
    const kind = sig.kind === undefined ? "phrase" : sig.kind;
    if (kind !== "phrase" && kind !== "comment") {
      return {
        ok: false,
        error: `injection pack "${source}": signature "${sig.id}" has an invalid "kind" (expected "phrase" or "comment")`,
      };
    }
    const flags = typeof sig.flags === "string" ? sig.flags : "";
    // Force case-insensitive scanning to match the historical inline behavior.
    const effectiveFlags = flags.includes("i") ? flags : `${flags}i`;

    let re: RegExp;
    try {
      re = new RegExp(sig.pattern, effectiveFlags);
    } catch (err) {
      return {
        ok: false,
        error: `injection pack "${source}": signature "${sig.id}" has an invalid pattern: ${(err as Error).message}`,
      };
    }

    compiled.push({
      id: sig.id,
      label: sig.label,
      pattern: sig.pattern,
      flags: effectiveFlags,
      severity: sig.severity,
      description: typeof sig.description === "string" ? sig.description : undefined,
      kind,
      re,
    });
  }

  return {
    ok: true,
    pack: { version, description: typeof obj.description === "string" ? obj.description : undefined, signatures: compiled, source },
  };
}
