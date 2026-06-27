import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * skill-sniffer 🐕👃 — `--init` config scaffolding.
 *
 * Writes a commented `.skillsnifferrc` stub into the target directory so users
 * have a discoverable starting point for project config. The file is JSON with
 * the knobs M6 exposes (token budget + the CI gate thresholds). Full rule
 * enable/disable wiring is a v0.2 backlog item (issue #8); this stub documents
 * the shape without promising behavior the engine doesn't yet honor.
 *
 * Pure-ish and safe: it never overwrites an existing config (returns
 * `created: false` instead) and only touches the single dotfile it owns.
 */

/** Default config the stub is seeded with (mirrors built-in defaults). */
export const DEFAULT_CONFIG = {
  /** Token-bloat warning budget (chars/4 heuristic). */
  tokenBudget: 2000,
  /** Fail the run if any skill scores below this (0 disables). */
  minScore: 0,
  /** Fail the run if total warnings exceed this (-1 disables). */
  maxWarnings: -1,
} as const;

/** Canonical config filename. */
export const RC_FILENAME = ".skillsnifferrc";

/** Result of an `--init` attempt. */
export interface InitResult {
  /** Absolute path to the config file. */
  path: string;
  /** True if a new file was written; false if one already existed. */
  created: boolean;
}

/**
 * Write a `.skillsnifferrc` stub into `dir` (default: cwd).
 *
 * Refuses to clobber an existing file: if one is already present, returns
 * `{ created: false }` so the CLI can report "already exists" rather than
 * silently nuking the user's config.
 */
export function writeConfigStub(dir: string = process.cwd()): InitResult {
  const path = resolve(dir, RC_FILENAME);
  if (existsSync(path)) {
    return { path, created: false };
  }

  const body = JSON.stringify(
    {
      $schema: "skill-sniffer/config@1",
      ...DEFAULT_CONFIG,
    },
    null,
    2,
  );
  writeFileSync(path, body + "\n", "utf8");
  return { path, created: true };
}
