/**
 * skill-sniffer 🐕👃 — shared git plumbing (issue #23).
 *
 * The single source of truth for "which files changed vs a ref". Both the
 * GitHub Action ({@link ../action/run.ts}) and the CLI `--since <ref>` flag call
 * {@link changedFilesSince} so the diff logic lives in exactly one place.
 *
 * The one non-obvious decision here is the **three-dot** diff (`ref...HEAD`).
 * That compares the merge-base of `ref` and `HEAD` against `HEAD`, i.e. exactly
 * what *this* branch adds/modifies relative to where it forked — ignoring churn
 * that landed on `ref` in the meantime. It's what you want for "did my change
 * introduce a footgun?" both in CI (base branch) and locally (`HEAD~1`, a tag,
 * `origin/main`, …).
 *
 * Errors are typed via {@link GitError} with a discriminating {@link GitErrorKind}
 * so callers can react differently to "not a git repo" / "bad ref" (a genuine
 * misuse → non-zero exit) versus an empty changed-set (perfectly fine → exit 0).
 * Pure string/`git` work; no network beyond an opt-in shallow-fetch fallback.
 */

import { execFileSync } from "node:child_process";

/** What went wrong when resolving a git diff, for actionable error handling. */
export type GitErrorKind =
  /** `cwd` is not inside a git working tree. */
  | "not-a-repo"
  /** The requested ref/commit could not be resolved. */
  | "bad-ref"
  /** `git` isn't installed / not on PATH. */
  | "git-missing"
  /** Any other git failure we couldn't classify. */
  | "git-error";

/**
 * A typed git failure. `kind` lets callers branch (e.g. CLI treats `not-a-repo`
 * and `bad-ref` as usage errors) without string-matching stderr.
 */
export class GitError extends Error {
  readonly kind: GitErrorKind;
  constructor(kind: GitErrorKind, message: string) {
    super(message);
    this.name = "GitError";
    this.kind = kind;
  }
}

/** Options for {@link changedFilesSince}. */
export interface ChangedFilesOptions {
  /** Directory to run git in. Defaults to `process.cwd()`. */
  cwd?: string;
  /**
   * When the ref is missing locally (common on shallow CI clones), attempt a
   * single `git fetch --depth=1 origin <ref>` before giving up. Off by default
   * so local CLI use never silently hits the network; the Action opts in.
   */
  fetchMissing?: boolean;
  /**
   * Injection seam for tests: run a git subcommand and return stdout, or throw
   * on non-zero exit. Defaults to a real `execFileSync` invocation.
   */
  runGit?: (args: string[], cwd: string) => string;
}

/** Default git runner: exec `git <args>` in `cwd`, returning stdout as UTF-8. */
function defaultRunGit(args: string[], cwd: string): string {
  // `stderr: "pipe"` captures git's own diagnostics onto the thrown error
  // (where {@link classifyGitError} reads them) instead of leaking a raw
  // `fatal: …` line to the terminal alongside our cleaner typed message.
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** True when `cwd` sits inside a git working tree. */
export function isGitRepo(
  cwd: string = process.cwd(),
  runGit: (args: string[], cwd: string) => string = defaultRunGit,
): boolean {
  try {
    const out = runGit(["rev-parse", "--is-inside-work-tree"], cwd);
    return out.trim() === "true";
  } catch {
    return false;
  }
}

/** True when `ref` resolves to a commit in the repo at `cwd`. */
export function refExists(
  ref: string,
  cwd: string = process.cwd(),
  runGit: (args: string[], cwd: string) => string = defaultRunGit,
): boolean {
  try {
    // `--verify --quiet <ref>^{commit}` resolves and asserts it's a commit-ish;
    // exits non-zero (→ throw) when the ref is unknown.
    runGit(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], cwd);
    return true;
  } catch {
    return false;
  }
}

/** Classify why an `execFileSync`-style git error happened, from its stderr. */
function classifyGitError(err: unknown): GitErrorKind {
  const e = err as { code?: string; stderr?: string | Buffer };
  if (e?.code === "ENOENT") return "git-missing";
  const stderr =
    typeof e?.stderr === "string"
      ? e.stderr
      : e?.stderr?.toString("utf8") ?? "";
  const s = stderr.toLowerCase();
  if (s.includes("not a git repository")) return "not-a-repo";
  if (
    s.includes("unknown revision") ||
    s.includes("bad revision") ||
    s.includes("ambiguous argument") ||
    s.includes("no such ref") ||
    s.includes("fatal: bad object")
  ) {
    return "bad-ref";
  }
  return "git-error";
}

/**
 * Return the repo-relative paths of files changed since `ref` (three-dot diff
 * against `HEAD`), filtered to Added/Copied/Modified/Renamed (deletions are
 * dropped — there's nothing left on disk to lint). Paths are exactly as git
 * prints them (POSIX-style, repo-relative); callers resolve them to absolute.
 *
 * Throws {@link GitError} with a precise `kind` for the failure modes that a
 * caller should surface distinctly:
 *  - `git-missing` — git not installed.
 *  - `not-a-repo`  — `cwd` isn't a git working tree.
 *  - `bad-ref`     — `ref` doesn't resolve (and couldn't be fetched, if asked).
 *
 * An empty return array means "the ref is fine, nothing relevant changed" — a
 * normal, non-error outcome the caller handles as a friendly exit 0.
 */
export function changedFilesSince(
  ref: string,
  options: ChangedFilesOptions = {},
): string[] {
  const cwd = options.cwd ?? process.cwd();
  const runGit = options.runGit ?? defaultRunGit;

  if (!isGitRepo(cwd, runGit)) {
    throw new GitError(
      "not-a-repo",
      `not a git repository (or any parent): ${cwd}`,
    );
  }

  const diffArgs = [
    "diff",
    "--name-only",
    "--diff-filter=ACMR",
    `${ref}...HEAD`,
  ];

  const runDiff = (): string => runGit(diffArgs, cwd);

  let raw: string;
  try {
    raw = runDiff();
  } catch (err) {
    const kind = classifyGitError(err);
    if (kind === "git-missing") {
      throw new GitError("git-missing", "git is not installed or not on PATH");
    }

    // A missing ref on a shallow clone can sometimes be recovered by fetching
    // it once, when the caller opts in. Only retry for ref problems.
    if (kind === "bad-ref" && options.fetchMissing) {
      try {
        runGit(["fetch", "--depth=1", "origin", ref], cwd);
      } catch {
        // Fetch failed too — fall through to the bad-ref error below.
      }
      if (refExists(ref, cwd, runGit)) {
        try {
          raw = runDiff();
          return splitPaths(raw);
        } catch (err2) {
          throw toGitError(classifyGitError(err2), ref, cwd);
        }
      }
    }

    throw toGitError(kind, ref, cwd);
  }

  return splitPaths(raw);
}

/**
 * Return the repo-relative paths of files currently **staged** for commit
 * (i.e. present in the index vs `HEAD`), filtered to Added/Copied/Modified/
 * Renamed — deletions are dropped since there's nothing left on disk to lint.
 * This is the pre-commit gate's file set: it lints exactly what's about to be
 * committed, not the working tree at large.
 *
 * Unlike {@link changedFilesSince} this needs no ref and works in a repo with
 * no commits yet (`git diff --cached` against the empty tree just lists every
 * staged add). Paths are exactly as git prints them (POSIX-style, repo-
 * relative); callers resolve them to absolute.
 *
 * Throws {@link GitError} with a precise `kind`:
 *  - `git-missing` — git not installed.
 *  - `not-a-repo`  — `cwd` isn't a git working tree.
 *
 * An empty return array means "nothing relevant is staged" — a normal,
 * non-error outcome a pre-commit hook handles as a friendly exit 0.
 */
export function stagedFiles(options: ChangedFilesOptions = {}): string[] {
  const cwd = options.cwd ?? process.cwd();
  const runGit = options.runGit ?? defaultRunGit;

  if (!isGitRepo(cwd, runGit)) {
    throw new GitError(
      "not-a-repo",
      `not a git repository (or any parent): ${cwd}`,
    );
  }

  const diffArgs = [
    "diff",
    "--cached",
    "--name-only",
    "--diff-filter=ACMR",
  ];

  try {
    return splitPaths(runGit(diffArgs, cwd));
  } catch (err) {
    const kind = classifyGitError(err);
    if (kind === "git-missing") {
      throw new GitError("git-missing", "git is not installed or not on PATH");
    }
    if (kind === "not-a-repo") {
      throw new GitError(
        "not-a-repo",
        `not a git repository (or any parent): ${cwd}`,
      );
    }
    throw new GitError("git-error", "git diff --cached failed");
  }
}

/** Build a {@link GitError} with a helpful message for a given kind. */
function toGitError(kind: GitErrorKind, ref: string, cwd: string): GitError {
  switch (kind) {
    case "not-a-repo":
      return new GitError(
        "not-a-repo",
        `not a git repository (or any parent): ${cwd}`,
      );
    case "bad-ref":
      return new GitError(
        "bad-ref",
        `could not resolve git ref "${ref}" (unknown revision)`,
      );
    case "git-missing":
      return new GitError("git-missing", "git is not installed or not on PATH");
    default:
      return new GitError("git-error", `git diff failed for ref "${ref}"`);
  }
}

/** Split raw `git diff --name-only` output into trimmed, non-empty lines. */
function splitPaths(raw: string): string[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}
