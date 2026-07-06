import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  changedFilesSince,
  isGitRepo,
  refExists,
  GitError,
  type GitErrorKind,
} from "../src/git.js";
import { intersectChanged, discoverSkills } from "../src/discover.js";
import { run } from "../src/cli.js";

/**
 * Issue #23 — `--since <ref>` diff mode.
 *
 * The changed-files logic lives in `src/git.ts` and is exercised three ways:
 *  1. Pure unit tests via the `runGit` injection seam (no real git needed).
 *  2. Real-git integration tests in a throwaway repo (the actual contract).
 *  3. End-to-end CLI tests driving `buildProgram()` against that repo.
 */

// A fake `git` that answers from a scripted map; anything unmapped throws a
// classified error so we can assert the not-a-repo / bad-ref branches.
function fakeGit(responses: {
  insideWorkTree?: boolean;
  refs?: Set<string>;
  diff?: string;
  /** Force the diff call to throw with this git stderr. */
  diffThrows?: string;
}): (args: string[], cwd: string) => string {
  return (args: string[]): string => {
    if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") {
      if (responses.insideWorkTree === false) {
        throw gitFail("fatal: not a git repository (or any of the parent directories): .git");
      }
      return responses.insideWorkTree === false ? "false\n" : "true\n";
    }
    if (args[0] === "rev-parse" && args[1] === "--verify") {
      const ref = args[3]?.replace(/\^\{commit\}$/, "");
      if (responses.refs?.has(ref ?? "")) return `${ref}\n`;
      throw gitFail(`fatal: Needed a single revision`);
    }
    if (args[0] === "diff") {
      if (responses.diffThrows) throw gitFail(responses.diffThrows);
      return responses.diff ?? "";
    }
    if (args[0] === "fetch") return "";
    throw gitFail(`unexpected git ${args.join(" ")}`);
  };
}

function gitFail(stderr: string): Error {
  const e = new Error("git failed") as Error & { stderr: string };
  e.stderr = stderr;
  return e;
}

describe("git — changedFilesSince (pure, injected runner)", () => {
  it("runs a three-dot diff with ACMR filter and returns trimmed paths", () => {
    let seenArgs: string[] = [];
    const runGit = (args: string[]): string => {
      if (args[0] === "rev-parse") return "true\n";
      seenArgs = args;
      return "a/SKILL.md\nb/nested/thing.skill.md\n\n  c/AGENTS.md  \n";
    };
    const out = changedFilesSince("origin/main", { cwd: "/repo", runGit });
    expect(seenArgs).toEqual([
      "diff",
      "--name-only",
      "--diff-filter=ACMR",
      "origin/main...HEAD",
    ]);
    expect(out).toEqual(["a/SKILL.md", "b/nested/thing.skill.md", "c/AGENTS.md"]);
  });

  it("returns [] (not an error) when nothing changed", () => {
    const runGit = fakeGit({ diff: "" });
    expect(changedFilesSince("HEAD", { cwd: "/repo", runGit })).toEqual([]);
  });

  it("throws GitError(not-a-repo) when cwd isn't a work tree", () => {
    const runGit = fakeGit({ insideWorkTree: false });
    expectGitError(() => changedFilesSince("HEAD", { cwd: "/nope", runGit }), "not-a-repo");
  });

  it("throws GitError(bad-ref) for an unknown revision", () => {
    const runGit = fakeGit({
      diffThrows: "fatal: ambiguous argument 'nope...HEAD': unknown revision or path",
    });
    expectGitError(() => changedFilesSince("nope", { cwd: "/repo", runGit }), "bad-ref");
  });

  it("throws GitError(git-missing) when git isn't installed", () => {
    const runGit = (args: string[]): string => {
      if (args[0] === "rev-parse") return "true\n";
      const e = new Error("spawn git ENOENT") as Error & { code: string };
      e.code = "ENOENT";
      throw e;
    };
    expectGitError(() => changedFilesSince("HEAD", { cwd: "/repo", runGit }), "git-missing");
  });

  it("recovers a missing ref via fetch when fetchMissing is set", () => {
    let fetched = false;
    const refs = new Set<string>();
    const runGit = (args: string[]): string => {
      if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") return "true\n";
      if (args[0] === "rev-parse" && args[1] === "--verify") {
        const ref = args[3]?.replace(/\^\{commit\}$/, "") ?? "";
        if (refs.has(ref)) return `${ref}\n`;
        throw gitFail("fatal: Needed a single revision");
      }
      if (args[0] === "fetch") {
        fetched = true;
        refs.add("origin/main"); // now resolvable
        return "";
      }
      if (args[0] === "diff") {
        // First call (before fetch) fails; after fetch it succeeds.
        if (!fetched) throw gitFail("fatal: bad revision 'origin/main...HEAD'");
        return "a/SKILL.md\n";
      }
      throw gitFail("unexpected");
    };
    const out = changedFilesSince("origin/main", {
      cwd: "/repo",
      runGit,
      fetchMissing: true,
    });
    expect(fetched).toBe(true);
    expect(out).toEqual(["a/SKILL.md"]);
  });

  it("does NOT fetch for a bad ref when fetchMissing is off", () => {
    let fetched = false;
    const runGit = (args: string[]): string => {
      if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") return "true\n";
      if (args[0] === "fetch") {
        fetched = true;
        return "";
      }
      if (args[0] === "diff") throw gitFail("fatal: unknown revision 'x...HEAD'");
      throw gitFail("unexpected");
    };
    expectGitError(() => changedFilesSince("x", { cwd: "/repo", runGit }), "bad-ref");
    expect(fetched).toBe(false);
  });
});

function expectGitError(fn: () => unknown, kind: GitErrorKind): void {
  try {
    fn();
    throw new Error("expected a GitError to be thrown");
  } catch (err) {
    expect(err).toBeInstanceOf(GitError);
    expect((err as GitError).kind).toBe(kind);
  }
}

describe("discover — intersectChanged", () => {
  it("keeps only discovered files that are in the changed set, in discovery order", () => {
    const discovered = ["/r/a/SKILL.md", "/r/b/SKILL.md", "/r/c/SKILL.md"];
    const changed = ["/r/c/SKILL.md", "/r/a/SKILL.md", "/r/z/SKILL.md"];
    expect(intersectChanged(discovered, changed)).toEqual([
      "/r/a/SKILL.md",
      "/r/c/SKILL.md",
    ]);
  });

  it("normalizes both sides to absolute paths before comparing", () => {
    const discovered = [resolve("x/SKILL.md")];
    expect(intersectChanged(discovered, ["x/SKILL.md"])).toEqual([resolve("x/SKILL.md")]);
  });

  it("returns [] when nothing overlaps", () => {
    expect(intersectChanged(["/r/a/SKILL.md"], ["/r/b/SKILL.md"])).toEqual([]);
  });

  it("de-duplicates a changed path repeated across the set", () => {
    const discovered = ["/r/a/SKILL.md"];
    expect(intersectChanged(discovered, ["/r/a/SKILL.md", "/r/a/SKILL.md"])).toEqual([
      "/r/a/SKILL.md",
    ]);
  });
});

// ---- Real-git integration + CLI end-to-end -------------------------------

const CLEAN_FM = (name: string) =>
  `---\nname: ${name}\ndescription: A perfectly fine ${name} skill used for diff-mode integration tests.\n---\n# ${name}\nDo ${name} things.\n`;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

describe("git + CLI — real repository (integration)", () => {
  let repo: string;

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "sniffer-since-"));
    git(repo, "init", "-q");
    git(repo, "config", "user.email", "t@t.t");
    git(repo, "config", "user.name", "t");
    mkdirSync(join(repo, "a"), { recursive: true });
    mkdirSync(join(repo, "b"), { recursive: true });
    writeFileSync(join(repo, "a", "SKILL.md"), CLEAN_FM("alpha"));
    writeFileSync(join(repo, "b", "SKILL.md"), CLEAN_FM("bravo"));
    writeFileSync(join(repo, "README.md"), "# not a skill\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "base");
    // Second commit: change ONLY a/SKILL.md.
    writeFileSync(join(repo, "a", "SKILL.md"), CLEAN_FM("alpha") + "\nMore alpha.\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "touch alpha");
  });

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("isGitRepo / refExists reflect reality", () => {
    expect(isGitRepo(repo)).toBe(true);
    expect(isGitRepo(tmpdir())).toBe(false); // tmpdir root isn't a repo
    expect(refExists("HEAD", repo)).toBe(true);
    expect(refExists("HEAD~1", repo)).toBe(true);
    expect(refExists("no-such-ref", repo)).toBe(false);
  });

  it("changedFilesSince lists only the file changed vs HEAD~1", () => {
    const changed = changedFilesSince("HEAD~1", { cwd: repo });
    expect(changed).toEqual(["a/SKILL.md"]);
  });

  it("changedFilesSince returns [] against HEAD (no changes)", () => {
    expect(changedFilesSince("HEAD", { cwd: repo })).toEqual([]);
  });

  it("intersects with discovery: only changed skill files survive", async () => {
    const discovered = await discoverSkills([repo]);
    const changedAbs = changedFilesSince("HEAD~1", { cwd: repo }).map((p) =>
      resolve(repo, p),
    );
    const scoped = intersectChanged(discovered, changedAbs);
    expect(scoped).toEqual([resolve(repo, "a/SKILL.md")]);
  });

  it("CLI --since HEAD~1 lints only the changed file (JSON)", async () => {
    const out = await runCli(["--since", "HEAD~1", "--json", repo], repo);
    const report = JSON.parse(out.stdout);
    expect(report.skillsChecked).toBe(1);
    expect(report.scores.map((s: { path: string }) => s.path)).toEqual([
      resolve(repo, "a/SKILL.md"),
    ]);
    expect(out.code).toBe(0);
  });

  it("CLI --since HEAD prints a friendly no-changes note and exits 0", async () => {
    const out = await runCli(["--since", "HEAD", repo], repo);
    expect(out.stdout.toLowerCase()).toMatch(/nothing changed to sniff/);
    expect(out.code).toBe(0);
  });

  it("CLI --since with a bad ref errors and exits USAGE (2)", async () => {
    const out = await runCli(["--since", "no-such-ref", repo], repo);
    expect(out.stderr).toMatch(/could not resolve git ref/);
    expect(out.code).toBe(2);
  });

  it("CLI --since outside a git repo errors and exits USAGE (2)", async () => {
    const nonRepo = mkdtempSync(join(tmpdir(), "sniffer-nonrepo-"));
    try {
      mkdirSync(join(nonRepo, "x"), { recursive: true });
      writeFileSync(join(nonRepo, "x", "SKILL.md"), CLEAN_FM("x"));
      const out = await runCli(["--since", "HEAD", nonRepo], nonRepo);
      expect(out.stderr).toMatch(/not a git repository/);
      expect(out.code).toBe(2);
    } finally {
      rmSync(nonRepo, { recursive: true, force: true });
    }
  });

  it("CLI --since intersects with --include (format filter wins)", async () => {
    // alpha changed but is a skill, not an `agents` file → nothing to lint.
    const out = await runCli(["--since", "HEAD~1", "--include", "agents", repo], repo);
    expect(out.stdout.toLowerCase()).toMatch(/no skills found/);
    expect(out.code).toBe(0);
  });
});

/**
 * Drive the real CLI entry point ({@link run}) against a working directory,
 * capturing stdout/stderr and the returned exit code. `run` owns the
 * try/catch that maps thrown errors (bad ref, non-repo) to EXIT.USAGE, so this
 * observes the same exit codes a shell would. git needs the real cwd, so we
 * chdir for the duration and restore afterwards.
 */
async function runCli(
  argv: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  let stdout = "";
  let stderr = "";
  const outOrig = process.stdout.write.bind(process.stdout);
  const errOrig = process.stderr.write.bind(process.stderr);
  const cwdOrig = process.cwd();
  // @ts-expect-error test capture
  process.stdout.write = (c: string) => ((stdout += c), true);
  // @ts-expect-error test capture
  process.stderr.write = (c: string) => ((stderr += c), true);
  process.chdir(cwd);
  let code = 0;
  try {
    code = await run(["node", "skill-sniffer", ...argv]);
  } finally {
    process.stdout.write = outOrig;
    process.stderr.write = errOrig;
    process.chdir(cwdOrig);
  }
  return { stdout, stderr, code };
}
