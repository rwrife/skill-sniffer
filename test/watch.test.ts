import { describe, it, expect, vi, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  startWatch,
  sniffOnce,
  watchDirsFor,
  supportsRecursiveWatch,
  DEFAULT_DEBOUNCE_MS,
  type Clock,
  type Watcher,
  type SniffResult,
} from "../src/watch.js";
import { run } from "../src/cli.js";

/**
 * Issue #28 — `skill-sniffer <path> --watch`.
 *
 * Three layers, matching the codebase convention (see rank/since tests):
 *  1. Pure/hermetic unit tests over `startWatch` with everything injected — a
 *     fake clock (so the debounce is driven by hand, no real sleeps), a fake
 *     watch factory (so no real `fs.watch`), a stub runner (so we can count
 *     re-sniffs without the full pipeline), and a buffer sink. These assert the
 *     contract: initial sniff, one save = one re-run, debounced bursts, clean
 *     teardown — all deterministic.
 *  2. `sniffOnce` + `watchDirsFor` unit tests against a throwaway directory,
 *     exercising the real discover→score pipeline and dir resolution.
 *  3. End-to-end CLI tests driving `run()` for the incompatible-flag usage
 *     errors (`--watch` + `--json`/`--sarif`/`--since`), exactly as a shell
 *     would observe them.
 */

/** Strip ANSI so assertions match plain text regardless of TTY color support. */
function plain(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;]*m/g, "");
}

/**
 * A hand-cranked clock: `setTimeout` callbacks are stored, not scheduled, and
 * only fire when the test calls {@link FakeClock.flush}. This makes the
 * debounce fully deterministic — a burst of triggers collapses to whatever the
 * test decides, with zero wall-clock time.
 */
class FakeClock implements Clock {
  private pending = new Map<number, () => void>();
  private nextId = 1;

  setTimeout(fn: () => void, _ms: number): unknown {
    const id = this.nextId++;
    this.pending.set(id, fn);
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.pending.delete(handle as number);
  }

  /** Fire every currently-pending timer (in insertion order), then clear it. */
  flush(): void {
    const fns = [...this.pending.values()];
    this.pending.clear();
    for (const fn of fns) fn();
  }

  /** How many timers are currently armed (for debounce-coalescing asserts). */
  get armed(): number {
    return this.pending.size;
  }
}

/**
 * A fake watch factory that hands the test a way to fire "file changed" events
 * for any watched directory, and records which dirs were watched / closed — no
 * real `fs.watch` involved.
 */
function makeFakeWatchFactory() {
  const watched: string[] = [];
  const closed: string[] = [];
  const listeners = new Map<string, () => void>();

  const factory = (dir: string, _recursive: boolean, onChange: () => void): Watcher => {
    watched.push(dir);
    listeners.set(dir, onChange);
    return {
      close: () => {
        closed.push(dir);
        listeners.delete(dir);
      },
    };
  };

  /** Fire a change event on the first watched dir (or a named one). */
  const fire = (dir?: string) => {
    const target = dir ?? watched[0];
    listeners.get(target)?.();
  };

  return { factory, watched, closed, fire };
}

/** Flush the microtask queue so awaited async work inside the loop settles. */
async function tick(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("watch mode (issue #28)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("startWatch() core loop (fully injected)", () => {
    /** A stub runner that counts calls and returns a canned result. */
    function countingRunner(tag = "ok") {
      let calls = 0;
      const runner = async (): Promise<SniffResult> => {
        calls++;
        return {
          output: `report#${calls} (${tag})\n`,
          score: 100,
          filesChecked: 1,
        };
      };
      return { runner, calls: () => calls };
    }

    it("performs exactly one initial sniff and prints its report", async () => {
      const clock = new FakeClock();
      const { factory } = makeFakeWatchFactory();
      const { runner, calls } = countingRunner();
      let out = "";

      const handle = await startWatch(["/some/dir"], {
        runner,
        watchFactory: factory,
        clock,
        sink: (c) => (out += c),
        resolveWatchDirs: async () => ["/some/dir"],
      });
      await tick();

      expect(calls()).toBe(1);
      const text = plain(out);
      expect(text).toContain("sniffing /some/dir");
      expect(text).toContain("report#1");
      expect(text).toContain("waiting for changes");

      handle.close();
      await handle.closed;
    });

    it("re-sniffs once per change after the debounce fires", async () => {
      const clock = new FakeClock();
      const fake = makeFakeWatchFactory();
      const { runner, calls } = countingRunner();
      let out = "";

      const handle = await startWatch(["/d"], {
        runner,
        watchFactory: fake.factory,
        clock,
        sink: (c) => (out += c),
        resolveWatchDirs: async () => ["/d"],
      });
      await tick(); // initial sniff
      expect(calls()).toBe(1);

      fake.fire(); // one save
      clock.flush(); // debounce elapses
      await tick();

      expect(calls()).toBe(2);
      expect(plain(out)).toContain("report#2");

      handle.close();
      await handle.closed;
    });

    it("coalesces a burst of events into a single re-sniff (debounce)", async () => {
      const clock = new FakeClock();
      const fake = makeFakeWatchFactory();
      const { runner, calls } = countingRunner();

      const handle = await startWatch(["/d"], {
        runner,
        watchFactory: fake.factory,
        clock,
        sink: () => {},
        resolveWatchDirs: async () => ["/d"],
      });
      await tick();
      expect(calls()).toBe(1);

      // Five rapid saves before the debounce fires. Each trigger clears the
      // previous armed timer and arms a fresh one, so only ONE remains pending.
      fake.fire();
      fake.fire();
      fake.fire();
      fake.fire();
      fake.fire();
      expect(clock.armed).toBe(1);

      clock.flush();
      await tick();

      // Exactly one extra sniff for the whole burst.
      expect(calls()).toBe(2);

      handle.close();
      await handle.closed;
    });

    it("uses the default debounce window when none is given", async () => {
      // Guard the documented constant so the CLI help/README stay in sync.
      expect(DEFAULT_DEBOUNCE_MS).toBeGreaterThan(0);
      expect(DEFAULT_DEBOUNCE_MS).toBeLessThan(1000);
    });

    it("never re-sniffs after close(), even if events fire", async () => {
      const clock = new FakeClock();
      const fake = makeFakeWatchFactory();
      const { runner, calls } = countingRunner();

      const handle = await startWatch(["/d"], {
        runner,
        watchFactory: fake.factory,
        clock,
        sink: () => {},
        resolveWatchDirs: async () => ["/d"],
      });
      await tick();
      expect(calls()).toBe(1);

      handle.close();
      await handle.closed;

      // Post-close events must be ignored: no new timer, no new sniff.
      fake.fire();
      clock.flush();
      await tick();
      expect(calls()).toBe(1);
    });

    it("closes every watcher on teardown", async () => {
      const clock = new FakeClock();
      const fake = makeFakeWatchFactory();
      const { runner } = countingRunner();

      const handle = await startWatch(["/a", "/b"], {
        runner,
        watchFactory: fake.factory,
        clock,
        sink: () => {},
        resolveWatchDirs: async () => ["/a", "/b"],
      });
      await tick();
      expect(fake.watched).toEqual(["/a", "/b"]);

      handle.close();
      await handle.closed;
      expect(fake.closed.sort()).toEqual(["/a", "/b"]);
    });

    it("keeps watching when a sniff throws (reports, doesn't crash)", async () => {
      const clock = new FakeClock();
      const fake = makeFakeWatchFactory();
      let out = "";
      let calls = 0;
      const runner = async (): Promise<SniffResult> => {
        calls++;
        if (calls === 1) throw new Error("boom during sniff");
        return { output: "recovered\n", score: 100, filesChecked: 1 };
      };

      const handle = await startWatch(["/d"], {
        runner,
        watchFactory: fake.factory,
        clock,
        sink: (c) => (out += c),
        resolveWatchDirs: async () => ["/d"],
      });
      await tick();

      // Initial sniff threw → a notice, but the loop survives.
      expect(plain(out)).toContain("sniff failed");
      expect(plain(out)).toContain("boom during sniff");

      // A subsequent change still triggers a (now-succeeding) re-sniff.
      fake.fire();
      clock.flush();
      await tick();
      expect(calls).toBe(2);
      expect(plain(out)).toContain("recovered");

      handle.close();
      await handle.closed;
    });

    it("close() is idempotent and resolves closed exactly once", async () => {
      const clock = new FakeClock();
      const fake = makeFakeWatchFactory();
      const { runner } = countingRunner();

      const handle = await startWatch(["/d"], {
        runner,
        watchFactory: fake.factory,
        clock,
        sink: () => {},
        resolveWatchDirs: async () => ["/d"],
      });
      await tick();

      handle.close();
      handle.close(); // second call must be a no-op
      await expect(handle.closed).resolves.toBeUndefined();
      // Only the two dirs' single close each (here one dir) — not doubled.
      expect(fake.closed).toEqual(["/d"]);
    });
  });

  describe("watchDirsFor()", () => {
    it("watches a directory input directly", async () => {
      const dir = mkdtempSync(join(tmpdir(), "sniff-wdir-"));
      try {
        const dirs = await watchDirsFor([dir]);
        expect(dirs).toEqual([resolve(dir)]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("watches a file input's containing directory", async () => {
      const dir = mkdtempSync(join(tmpdir(), "sniff-wfile-"));
      try {
        const file = join(dir, "SKILL.md");
        writeFileSync(file, "x");
        const dirs = await watchDirsFor([file]);
        expect(dirs).toEqual([resolve(dir)]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("falls back to the parent dir for a missing path", async () => {
      const dirs = await watchDirsFor(["/no/such/path/here.md"]);
      expect(dirs).toEqual([resolve("/no/such/path")]);
    });

    it("de-duplicates and sorts watched directories", async () => {
      const dir = mkdtempSync(join(tmpdir(), "sniff-wdedup-"));
      try {
        writeFileSync(join(dir, "SKILL.md"), "x");
        writeFileSync(join(dir, "AGENTS.md"), "y");
        // Two file inputs in the same dir → a single watched directory.
        const dirs = await watchDirsFor([
          join(dir, "SKILL.md"),
          join(dir, "AGENTS.md"),
        ]);
        expect(dirs).toEqual([resolve(dir)]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("expands to subdirectories on platforms without recursive fs.watch", async () => {
      // On Linux, `fs.watch` isn't recursive, so watchDirsFor must return every
      // subdirectory of a root (excluding node_modules/.git/dist/build) so a
      // flat set of watchers still covers nested skill files. On macOS/Windows
      // one recursive watcher suffices, so only the root is returned.
      const dir = mkdtempSync(join(tmpdir(), "sniff-wtree-"));
      try {
        mkdirSync(join(dir, "nested", "deeper"), { recursive: true });
        mkdirSync(join(dir, "node_modules", "pkg"), { recursive: true });
        mkdirSync(join(dir, ".git"), { recursive: true });

        const dirs = await watchDirsFor([dir]);
        expect(dirs).toContain(resolve(dir));

        if (supportsRecursiveWatch()) {
          // macOS/Windows: just the root.
          expect(dirs).toEqual([resolve(dir)]);
        } else {
          // Linux: root + every non-ignored subdirectory.
          expect(dirs).toContain(resolve(dir, "nested"));
          expect(dirs).toContain(resolve(dir, "nested", "deeper"));
          // Ignored directories are never watched.
          expect(dirs).not.toContain(resolve(dir, "node_modules"));
          expect(dirs).not.toContain(resolve(dir, "node_modules", "pkg"));
          expect(dirs).not.toContain(resolve(dir, ".git"));
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("sniffOnce() pipeline", () => {
    it("scores a clean skill directory at 100 and renders a wag", async () => {
      const dir = mkdtempSync(join(tmpdir(), "sniff-once-clean-"));
      try {
        writeFileSync(
          join(dir, "SKILL.md"),
          "---\nname: ok\ndescription: a perfectly fine skill.\n---\n# ok\nbody\n",
        );
        const result = await sniffOnce([dir]);
        expect(result.score).toBe(100);
        expect(result.filesChecked).toBe(1);
        expect(plain(result.output)).toContain("good boy");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("surfaces findings and a lower score for a bad skill", async () => {
      const dir = mkdtempSync(join(tmpdir(), "sniff-once-bad-"));
      try {
        // Missing `description` → a frontmatter error → score below 100.
        writeFileSync(join(dir, "SKILL.md"), "---\nname: bad\n---\n# bad\n");
        const result = await sniffOnce([dir]);
        expect(result.filesChecked).toBe(1);
        expect(result.score).toBeLessThan(100);
        expect(plain(result.output).toLowerCase()).toContain("description");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("reports an empty directory as nothing to sniff (score 100)", async () => {
      const dir = mkdtempSync(join(tmpdir(), "sniff-once-empty-"));
      try {
        const result = await sniffOnce([dir]);
        expect(result.filesChecked).toBe(0);
        expect(result.score).toBe(100);
        expect(plain(result.output).toLowerCase()).toContain("no skills found");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("--watch via the CLI (incompatible flags)", () => {
    it("rejects --watch with --json (exit 2)", async () => {
      const out = await runCli(["test/fixtures/valid", "--watch", "--json"]);
      expect(out.code).toBe(2);
      expect(out.stderr).toContain("--watch cannot be combined with --json");
    });

    it("rejects --watch with --sarif (exit 2)", async () => {
      const out = await runCli([
        "test/fixtures/valid",
        "--watch",
        "--sarif",
        "out.sarif",
      ]);
      expect(out.code).toBe(2);
      expect(out.stderr).toContain("--watch cannot be combined with --sarif");
    });

    it("rejects --watch with --since (exit 2)", async () => {
      const out = await runCli(["test/fixtures/valid", "--watch", "--since"]);
      expect(out.code).toBe(2);
      expect(out.stderr).toContain("--watch cannot be combined with --since");
    });

    it("rejects --watch with --fix (exit 2)", async () => {
      const out = await runCli(["test/fixtures/valid", "--watch", "--fix"]);
      expect(out.code).toBe(2);
      expect(out.stderr).toContain("--watch cannot be combined with --fix");
    });
  });
});

/**
 * Drive the real CLI entry point ({@link run}), capturing stdout/stderr and the
 * returned exit code — the same harness the rank/since suites use.
 */
async function runCli(
  argv: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  let stdout = "";
  let stderr = "";
  const outOrig = process.stdout.write.bind(process.stdout);
  const errOrig = process.stderr.write.bind(process.stderr);
  // @ts-expect-error test capture
  process.stdout.write = (c: string) => ((stdout += c), true);
  // @ts-expect-error test capture
  process.stderr.write = (c: string) => ((stderr += c), true);
  let code = 0;
  try {
    code = await run(["node", "skill-sniffer", ...argv]);
  } finally {
    process.stdout.write = outOrig;
    process.stderr.write = errOrig;
  }
  return { stdout, stderr, code };
}
