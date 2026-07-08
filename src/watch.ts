import { watch as fsWatch, type FSWatcher } from "node:fs";
import { stat, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import pc from "picocolors";
import { discoverSkills, type DiscoverOptions } from "./discover.js";
import { parseSkills } from "./parse.js";
import { runEngine } from "./engine.js";
import { scoreReport } from "./score.js";
import { renderPretty } from "./report/pretty.js";
import { loadConfig } from "./config.js";
import { getVersion } from "./version.js";

/**
 * skill-sniffer 🐕👃 — watch mode (`skill-sniffer <path> --watch`, issue #28).
 *
 * Tightens the authoring loop from "save → switch terminal → rerun" to instant:
 * the process stays up, re-discovers + re-sniffs the given path(s) whenever a
 * file underneath them changes, and reprints the pretty report + Good Boy
 * Score™ each cycle. Offline and dependency-free — it leans on `node:fs.watch`
 * alone (no chokidar, no polling library).
 *
 * Design, mirroring the issue's contract:
 * - **Never exits on findings.** The whole point is to stay up while you fix
 *   things, so exit codes are irrelevant here; the loop runs until an abort
 *   signal (Ctrl-C in the CLI) and then exits 0 cleanly, closing every watcher.
 * - **Re-discovers each cycle.** Newly-added or deleted skill files are picked
 *   up because we watch the *containing directories* (recursively where the
 *   platform supports it, else per-directory) and re-run discovery on change —
 *   never a stale, initially-matched file list.
 * - **Debounced.** A single editor save often fires several `fs.watch` events;
 *   a short debounce coalesces a burst into exactly one re-sniff.
 * - **Testable.** All the moving parts (the clock, the watch factory, the sink
 *   we print to, and the single-run function) are injectable, so the unit tests
 *   drive the loop with fake timers and programmatic writes — no real sleeps,
 *   no dependence on OS watcher timing.
 *
 * The machine-output flags (`--json`/`--sarif`) and `--since` are rejected by
 * the CLI *before* we get here (a stream of JSON on a clearing screen is
 * nonsense, and diff mode is a one-shot CI concept), so this module only ever
 * renders the human report.
 */

/** Default debounce window (ms): long enough to coalesce one save's burst. */
export const DEFAULT_DEBOUNCE_MS = 120;

/**
 * A started watch session. The CLI (or a test) calls {@link WatchHandle.close}
 * to tear everything down; `closed` resolves once the loop has fully stopped
 * and every watcher is released, so callers can await a clean shutdown.
 */
export interface WatchHandle {
  /** Stop watching: closes all fs watchers, cancels any pending debounce. */
  close(): void;
  /** Resolves once the session has fully stopped (all watchers closed). */
  readonly closed: Promise<void>;
}

/**
 * The minimal watcher surface {@link startWatch} needs. `node:fs`'s
 * {@link FSWatcher} satisfies this; tests substitute a fake so no real files
 * are watched. `onChange` is invoked whenever the underlying path emits a
 * change/rename event.
 */
export interface Watcher {
  close(): void;
}

/**
 * Factory that begins watching one directory and routes its change/rename
 * events to `onChange`. Defaults to {@link nodeWatchFactory} (real
 * `fs.watch`); injectable for hermetic tests.
 */
export type WatchFactory = (
  dir: string,
  recursive: boolean,
  onChange: () => void,
) => Watcher;

/** A minimal clock so the debounce can be driven by fake timers in tests. */
export interface Clock {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Where watch output goes. Defaults to stdout; tests capture into a buffer. */
export type Sink = (chunk: string) => void;

/**
 * Runs one sniff over the given paths and returns the rendered human report
 * plus the overall score. Injectable so tests can assert re-run *counts*
 * without exercising the whole discover→engine→score pipeline, and so the CLI
 * can share the exact production pipeline. The default is {@link sniffOnce}.
 */
export type SniffRunner = (
  paths: string[],
  options: DiscoverOptions,
) => Promise<SniffResult>;

/** Result of a single watch-mode sniff: what to print and the score. */
export interface SniffResult {
  /** Fully-rendered, ready-to-print report text (already newline-terminated). */
  output: string;
  /** Overall Good Boy Score™ for this cycle (0–100). */
  score: number;
  /** How many files were sniffed this cycle (for the status line). */
  filesChecked: number;
}

/** Options for {@link startWatch}. */
export interface WatchOptions extends DiscoverOptions {
  /** Debounce window in ms (default {@link DEFAULT_DEBOUNCE_MS}). */
  debounceMs?: number;
  /** Clear the screen before each cycle's report (default true). */
  clearScreen?: boolean;
  /** Injectable single-run function (default {@link sniffOnce}). */
  runner?: SniffRunner;
  /** Injectable watcher factory (default real `fs.watch`). */
  watchFactory?: WatchFactory;
  /** Injectable clock for the debounce (default global timers). */
  clock?: Clock;
  /** Injectable output sink (default `process.stdout.write`). */
  sink?: Sink;
  /**
   * Resolve the set of directories to watch for a given input path set.
   * Injectable so tests can pin it; defaults to {@link watchDirsFor}, which
   * watches each input directory (or a file's parent directory).
   */
  resolveWatchDirs?: (paths: string[]) => Promise<string[]>;
}

/**
 * Start watch mode over `paths`. Performs one initial sniff immediately, then
 * re-sniffs (debounced) whenever a watched directory reports a change, until
 * {@link WatchHandle.close} is called.
 *
 * The returned promise resolves as soon as watching is *established* (after the
 * first sniff has been kicked off and watchers are attached); use the handle's
 * `closed` promise to await full teardown. Errors from an individual sniff are
 * caught and printed as a dim notice rather than tearing the session down — a
 * transient bad edit shouldn't kill your watcher.
 */
export async function startWatch(
  paths: string[],
  options: WatchOptions = {},
): Promise<WatchHandle> {
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const clearScreen = options.clearScreen ?? true;
  const runner = options.runner ?? sniffOnce;
  const watchFactory = options.watchFactory ?? nodeWatchFactory;
  const clock: Clock = options.clock ?? globalClock;
  const sink: Sink = options.sink ?? ((c) => process.stdout.write(c));
  const resolveDirs = options.resolveWatchDirs ?? watchDirsFor;
  const discoverOpts: DiscoverOptions = {
    include: options.include,
    exclude: options.exclude,
  };

  let stopped = false;
  let running = false;
  let rerunQueued = false;
  let debounceHandle: unknown;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((r) => (resolveClosed = r));
  /** Active watchers keyed by absolute directory path (for incremental adds). */
  const watchers = new Map<string, Watcher>();
  const recursive = supportsRecursiveWatch();

  /**
   * (Re)attach watchers to cover the current directory set. On recursive
   * platforms this is the input roots; on Linux it's the full expanded subtree,
   * so newly-created nested directories gain a watcher on the next cycle (their
   * creation already fired the parent's watcher → re-sniff → here). Directories
   * that vanished keep their now-inert watcher until teardown — harmless.
   */
  async function refreshWatchers(): Promise<void> {
    if (stopped) return;
    let dirs: string[];
    try {
      dirs = await resolveDirs(paths);
    } catch {
      return; // resolution hiccup; keep the watchers we already have.
    }
    for (const dir of dirs) {
      if (watchers.has(dir)) continue;
      try {
        watchers.set(dir, watchFactory(dir, recursive, trigger));
      } catch {
        // A directory that can't be watched (permissions, races) is skipped
        // rather than fatal — the rest of the session still works.
      }
    }
  }

  /** Perform a single sniff cycle: clear, run, print report + status. */
  async function cycle(reason?: string): Promise<void> {
    if (stopped) return;
    running = true;
    try {
      if (clearScreen) sink(CLEAR_SCREEN);
      if (reason) sink(pc.dim(`[watch] ${reason}\n`));
      const result = await runner(paths, discoverOpts);
      sink(result.output);
      sink(waitingLine());
    } catch (err) {
      // A bad edit (unreadable file, mid-write truncation) shouldn't kill the
      // session — report it and keep watching.
      sink(
        `${pc.yellow("[watch] sniff failed:")} ${(err as Error).message}\n` +
          waitingLine(),
      );
    } finally {
      running = false;
      // Pick up any directories that appeared this cycle so nested edits on a
      // freshly-created folder are watched going forward (Linux especially).
      await refreshWatchers();
      // If a change landed mid-run, honor exactly one coalesced re-sniff.
      if (rerunQueued && !stopped) {
        rerunQueued = false;
        void cycle("change detected — re-sniffing…");
      }
    }
  }

  /** Debounced trigger: collapse a burst of fs events into one re-sniff. */
  function trigger(): void {
    if (stopped) return;
    clock.clearTimeout(debounceHandle);
    debounceHandle = clock.setTimeout(() => {
      if (stopped) return;
      if (running) {
        // A cycle is in flight; mark that we owe one more when it finishes.
        rerunQueued = true;
        return;
      }
      void cycle("change detected — re-sniffing…");
    }, debounceMs);
  }

  // Header + first sniff. We watch directories (not the initially-matched
  // files) so added/removed skills are caught. `fs.watch` supports recursion
  // natively only on macOS/Windows; on Linux we compensate by expanding the
  // watch set to every subdirectory (see resolveWatchDirs default) and
  // refreshing it each cycle, so nested edits are still observed.
  sink(pc.dim(`[watch] sniffing ${paths.join(", ")} … (Ctrl-C to stop)\n`));

  await refreshWatchers();

  // Kick off the initial sniff (not awaited: startWatch resolves once watching
  // is established; the first report prints asynchronously).
  void cycle();

  const handle: WatchHandle = {
    close(): void {
      if (stopped) return;
      stopped = true;
      clock.clearTimeout(debounceHandle);
      for (const w of watchers.values()) {
        try {
          w.close();
        } catch {
          // Best-effort teardown; a watcher already gone is fine.
        }
      }
      watchers.clear();
      resolveClosed();
    },
    closed,
  };
  return handle;
}

/** ANSI: clear the screen and move the cursor home (used between cycles). */
const CLEAR_SCREEN = "\u001b[2J\u001b[H";

/** The dim "waiting for changes" footer printed after each cycle's report. */
function waitingLine(): string {
  return pc.dim("[watch] waiting for changes… (Ctrl-C to stop)\n");
}

/** The real clock: thin wrappers over the global timer functions. */
const globalClock: Clock = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/**
 * The default {@link WatchFactory}: a thin wrapper over `node:fs.watch`. Every
 * change/rename event maps to a single `onChange()` call (the debounce upstream
 * decides how to coalesce). We deliberately ignore the event's filename — the
 * loop re-discovers from scratch, so *which* file changed doesn't matter.
 */
export function nodeWatchFactory(
  dir: string,
  recursive: boolean,
  onChange: () => void,
): Watcher {
  const w: FSWatcher = fsWatch(dir, { recursive }, () => onChange());
  // A watcher error (e.g. the dir was removed) shouldn't crash the process;
  // swallow it and let the next discovery reflect reality.
  w.on("error", () => {});
  return { close: () => w.close() };
}

/**
 * True when `fs.watch`'s `recursive` option is honored on this platform. Node
 * only supports it natively on macOS and Windows; on Linux (and others) it's a
 * no-op, so we expand the watch set to every subdirectory instead.
 */
export function supportsRecursiveWatch(): boolean {
  return process.platform === "darwin" || process.platform === "win32";
}

/** Directory names never worth watching (mirrors discovery's ignore list). */
const WATCH_IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
]);

/**
 * Resolve the directories to watch for a set of input paths. A directory input
 * is watched directly; a file input has its containing directory watched (so a
 * rewrite of that file, which some editors do via rename, is still observed).
 * Missing inputs are skipped. Results are de-duplicated, absolute, and sorted.
 *
 * On platforms without native recursive `fs.watch` ({@link supportsRecursiveWatch}
 * is false, i.e. Linux), each directory is **expanded to its full subtree** so a
 * flat set of per-directory watchers still catches edits to nested skill files.
 * On macOS/Windows a single recursive watcher covers the subtree, so only the
 * top directories are returned.
 */
export async function watchDirsFor(paths: string[]): Promise<string[]> {
  const roots = new Set<string>();
  for (const p of paths) {
    const abs = resolve(p);
    try {
      const info = await stat(abs);
      roots.add(info.isDirectory() ? abs : dirname(abs));
    } catch {
      // Path doesn't exist (yet) — watch its parent so it's caught if created.
      roots.add(dirname(abs));
    }
  }

  if (supportsRecursiveWatch()) {
    return [...roots].sort();
  }

  // Linux: no recursive watch — enumerate every subdirectory of each root so
  // the non-recursive watchers cover the whole tree.
  const all = new Set<string>();
  for (const root of roots) {
    all.add(root);
    for (const sub of await listSubdirs(root)) all.add(sub);
  }
  return [...all].sort();
}

/**
 * Recursively list every subdirectory under `dir` (excluding
 * {@link WATCH_IGNORE_DIRS}), best-effort. Unreadable directories are skipped
 * rather than fatal — a permissions hiccup on one branch shouldn't sink watch
 * mode. Returns absolute paths; `dir` itself is not included.
 */
async function listSubdirs(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (WATCH_IGNORE_DIRS.has(entry.name)) continue;
    const child = join(dir, entry.name);
    out.push(child);
    out.push(...(await listSubdirs(child)));
  }
  return out;
}

/**
 * The default {@link SniffRunner}: the full production pipeline for one cycle —
 * discover → parse → engine (config-aware) → score → render pretty. Returns the
 * rendered text and overall score. Kept here (rather than duplicated in the
 * CLI) so watch mode and a one-shot run can never drift.
 */
export async function sniffOnce(
  paths: string[],
  options: DiscoverOptions = {},
): Promise<SniffResult> {
  const files = await discoverSkills(paths, options);
  if (files.length === 0) {
    return {
      output: `${pc.yellow("no skills found")} 🐕💨 (nothing to sniff under ${paths.join(", ")})\n`,
      score: 100,
      filesChecked: 0,
    };
  }

  const skills = await parseSkills(files);
  const config = loadConfig(paths, { enabled: true });
  const report = runEngine(skills, { config });
  const scored = scoreReport(
    report,
    skills.map((s) => s.path),
  );

  return {
    output: renderPretty(scored),
    score: scored.score,
    filesChecked: skills.length,
  };
}

export { getVersion };
