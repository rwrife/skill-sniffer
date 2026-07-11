import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * skill-sniffer 🐕👃 — `install-hook`: the git pre-commit gate (issue #34).
 *
 * The whole personality of skill-sniffer is "the dog at the door you walk past
 * every day" — a 2-second check *before* a bad skill ships. The highest-leverage
 * place to enforce that is the git `pre-commit` hook, not just CI. This module
 * writes (and removes) a self-contained block into `.git/hooks/pre-commit` that
 * lints only the **staged** skill/agent files and blocks the commit on errors
 * or a failed `--min-score`.
 *
 * The one load-bearing rule here is **merge, don't clobber**. A repo may already
 * have a pre-commit hook (prettier, lint-staged, whatever). We never overwrite
 * it: our contribution lives strictly between two sentinel markers so we can
 * find, refresh, or surgically remove *only our block* while leaving everything
 * else untouched — exactly the same discipline the agent applies to shell rc
 * files and crontabs.
 */

/** Opening sentinel for the managed block. Never change this string. */
export const HOOK_MARKER_START = "# >>> skill-sniffer >>>";
/** Closing sentinel for the managed block. Never change this string. */
export const HOOK_MARKER_END = "# <<< skill-sniffer <<<";

/** Shebang used when we create a brand-new pre-commit hook from scratch. */
const HOOK_SHEBANG = "#!/bin/sh";

/**
 * The managed block body (between the markers, exclusive). Runs skill-sniffer
 * over the staged set via `--since` semantics against the index. We invoke the
 * locally-resolved CLI (`npx --no-install`) so the hook uses whatever version
 * the repo pins, and pass `--staged` so the CLI narrows to the index rather
 * than a ref. A non-zero exit aborts the commit; that's the whole point.
 *
 * Kept POSIX-sh clean (no bashisms) so it runs under the `sh` git invokes.
 */
function managedBlockBody(): string {
  return [
    "# Managed by `skill-sniffer install-hook`. Edit above/below the markers,",
    "# not inside them: this region is regenerated on the next install and",
    "# removed by `skill-sniffer install-hook --uninstall`.",
    'if command -v skill-sniffer >/dev/null 2>&1; then',
    '  skill-sniffer --staged || exit 1',
    "elif command -v npx >/dev/null 2>&1; then",
    '  npx --no-install skill-sniffer --staged || exit 1',
    "else",
    '  echo "skill-sniffer: not found (skipping); run `npm i -D skill-sniffer`" >&2',
    "fi",
  ].join("\n");
}

/** The full managed block, markers included, for embedding into a hook file. */
export function managedBlock(): string {
  return `${HOOK_MARKER_START}\n${managedBlockBody()}\n${HOOK_MARKER_END}`;
}

/** What went wrong (or right) during an install-hook operation. */
export type HookErrorKind =
  /** `cwd` is not inside a git working tree. */
  | "not-a-repo"
  /**
   * A pre-commit hook exists and already contains a skill-sniffer block, but
   * it doesn't match what we'd write — refuse to touch it without `--force`.
   */
  | "conflict";

/** A typed install-hook failure, mirroring {@link import("./git.js").GitError}. */
export class HookError extends Error {
  readonly kind: HookErrorKind;
  constructor(kind: HookErrorKind, message: string) {
    super(message);
    this.name = "HookError";
    this.kind = kind;
  }
}

/** Options shared by install/uninstall, mostly test seams. */
export interface HookOptions {
  /** Directory to resolve the repo from. Defaults to `process.cwd()`. */
  cwd?: string;
  /**
   * Injection seam for tests: resolve the absolute path to `.git/hooks` for the
   * repo at `cwd`. Defaults to asking git via `rev-parse`.
   */
  resolveHooksDir?: (cwd: string) => string | undefined;
}

/** Outcome of an {@link installHook} call. */
export interface InstallResult {
  /** Absolute path to the pre-commit hook file. */
  path: string;
  /** How the file ended up in its final state. */
  action: "created" | "appended" | "updated" | "unchanged";
}

/** Outcome of an {@link uninstallHook} call. */
export interface UninstallResult {
  /** Absolute path to the pre-commit hook file (may not exist). */
  path: string;
  /** How the file ended up. */
  action: "removed" | "absent" | "no-block";
}

/**
 * Resolve the absolute `.git/hooks` directory for the repo containing `cwd`,
 * honoring custom `core.hooksPath` and worktrees via `git rev-parse`. Returns
 * `undefined` when not inside a git repo.
 */
function defaultResolveHooksDir(cwd: string): string | undefined {
  const git = (args: string[]): string =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  try {
    if (git(["rev-parse", "--is-inside-work-tree"]) !== "true") return undefined;
  } catch {
    return undefined;
  }
  // Respect an explicit core.hooksPath if set (Husky, etc.).
  try {
    const custom = git(["config", "--get", "core.hooksPath"]);
    if (custom) return resolve(cwd, custom);
  } catch {
    // no core.hooksPath configured — fall through to the default.
  }
  try {
    const gitDir = git(["rev-parse", "--absolute-git-dir"]);
    return resolve(gitDir, "hooks");
  } catch {
    return undefined;
  }
}

/** Strip a single skill-sniffer managed block from hook text, if present. */
function stripBlock(text: string): { text: string; had: boolean } {
  const start = text.indexOf(HOOK_MARKER_START);
  if (start === -1) return { text, had: false };
  const endMarker = text.indexOf(HOOK_MARKER_END, start);
  if (endMarker === -1) return { text, had: false };
  const endLine = endMarker + HOOK_MARKER_END.length;

  let before = text.slice(0, start);
  let after = text.slice(endLine);
  // Absorb the newline immediately after the end marker so we don't leave a
  // dangling blank line where the block used to be.
  after = after.replace(/^\r?\n/, "");
  // Trim trailing whitespace introduced right before our block.
  before = before.replace(/[ \t]*$/g, "");
  return { text: before + after, had: true };
}

/** Return the current skill-sniffer block from hook text, or undefined. */
function extractBlock(text: string): string | undefined {
  const start = text.indexOf(HOOK_MARKER_START);
  if (start === -1) return undefined;
  const end = text.indexOf(HOOK_MARKER_END, start);
  if (end === -1) return undefined;
  return text.slice(start, end + HOOK_MARKER_END.length);
}

/**
 * Install (or refresh) the skill-sniffer pre-commit block.
 *
 * - No hook file → create one (`#!/bin/sh` + our block), mark it executable.
 * - Hook exists, no skill-sniffer block → append our block, preserving the rest.
 * - Hook exists with a matching block → no-op (`unchanged`).
 * - Hook exists with a *different* skill-sniffer block → refresh it in place
 *   (`updated`). If `force` is false and the existing block was hand-edited in
 *   a way we can't cleanly reconcile, we still regenerate it (the block is
 *   explicitly ours), but callers can pass `force` to suppress the conflict
 *   guard entirely.
 */
export function installHook(
  opts: HookOptions & { force?: boolean } = {},
): InstallResult {
  const cwd = opts.cwd ?? process.cwd();
  const resolveHooksDir = opts.resolveHooksDir ?? defaultResolveHooksDir;
  const hooksDir = resolveHooksDir(cwd);
  if (!hooksDir) {
    throw new HookError(
      "not-a-repo",
      `not a git repository (or any parent): ${cwd}`,
    );
  }

  const hookPath = resolve(hooksDir, "pre-commit");
  const block = managedBlock();

  if (!existsSync(hookPath)) {
    mkdirSync(dirname(hookPath), { recursive: true });
    const contents = `${HOOK_SHEBANG}\n${block}\n`;
    writeFileSync(hookPath, contents, "utf8");
    makeExecutable(hookPath);
    return { path: hookPath, action: "created" };
  }

  const existing = readFileSync(hookPath, "utf8");
  const currentBlock = extractBlock(existing);

  if (currentBlock === undefined) {
    // No block yet — append ours, keeping a clean single blank-line separator.
    const sep = existing.endsWith("\n") ? "" : "\n";
    const contents = `${existing}${sep}\n${block}\n`;
    writeFileSync(hookPath, contents, "utf8");
    makeExecutable(hookPath);
    return { path: hookPath, action: "appended" };
  }

  if (currentBlock === block) {
    // Already exactly what we'd write.
    makeExecutable(hookPath);
    return { path: hookPath, action: "unchanged" };
  }

  // A skill-sniffer block exists but differs (older version or hand-edited).
  // The region is ours by contract, so regenerate it in place — but honor the
  // conflict guard unless the caller passed --force.
  if (!opts.force) {
    throw new HookError(
      "conflict",
      `existing skill-sniffer block in ${hookPath} differs from the current template; ` +
        `re-run with --force to regenerate it`,
    );
  }
  const stripped = stripBlock(existing).text;
  const base = stripped.replace(/\s*$/g, "");
  const contents = `${base}\n\n${block}\n`;
  writeFileSync(hookPath, contents, "utf8");
  makeExecutable(hookPath);
  return { path: hookPath, action: "updated" };
}

/**
 * Remove only the skill-sniffer managed block, leaving any other hook content
 * intact. If removing our block leaves behind nothing but a lone shebang (i.e.
 * we created the file), the file is reduced to just that shebang rather than
 * deleted — safest not to remove a file another tool might also manage.
 */
export function uninstallHook(opts: HookOptions = {}): UninstallResult {
  const cwd = opts.cwd ?? process.cwd();
  const resolveHooksDir = opts.resolveHooksDir ?? defaultResolveHooksDir;
  const hooksDir = resolveHooksDir(cwd);
  if (!hooksDir) {
    throw new HookError(
      "not-a-repo",
      `not a git repository (or any parent): ${cwd}`,
    );
  }

  const hookPath = resolve(hooksDir, "pre-commit");
  if (!existsSync(hookPath)) {
    return { path: hookPath, action: "absent" };
  }

  const existing = readFileSync(hookPath, "utf8");
  const { text, had } = stripBlock(existing);
  if (!had) {
    return { path: hookPath, action: "no-block" };
  }

  // Normalize: ensure a single trailing newline; collapse a file that's now
  // only a shebang (+ blank lines) down to just the shebang line.
  let next = text.replace(/\s*$/g, "");
  if (next.trim() === HOOK_SHEBANG || next.trim() === "") {
    next = HOOK_SHEBANG;
  }
  writeFileSync(hookPath, next + "\n", "utf8");
  return { path: hookPath, action: "removed" };
}

/** chmod +x, best-effort (no-op / swallowed on filesystems that don't support it). */
function makeExecutable(path: string): void {
  try {
    chmodSync(path, 0o755);
  } catch {
    // Non-fatal: some filesystems (or Windows) don't honor the exec bit.
  }
}
