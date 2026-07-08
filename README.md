# skill-sniffer 🐕👃

> An ESLint for the Skills era. Point it at your `SKILL.md` files; it sniffs out the footguns before your agent eats them.

Everybody's writing agent skills (`SKILL.md` for Claude Code, Codex CLI, and friends). Almost nobody is checking them for landmines. **skill-sniffer** is a paranoid, **offline** CLI that lints, audits, and **scores** your skill files.

## What it sniffs

- 🔑 **Leaked secrets** — AWS keys, `sk-...` / `ghp_...` tokens, `API_KEY=`, private-key headers.
- 🪤 **Prompt-injection bait** — "ignore previous instructions", "you are now…", hidden/zero-width chars, sneaky instruction comments.
- 🐘 **Token bloat** — estimates token weight and growls when a skill blows the budget.
- 🔗 **Broken local paths** — resolves relative paths against the skill's own dir and flags the dead ones.
- 📋 **Missing/malformed frontmatter** — requires `name` + `description`, sane lengths.
- 🛠️ **Over-broad tool grants** — wildcards like `exec: *` or "any shell command".

Every file gets a **Good Boy Score™** (0–100). Clean file? Wag. Leaked key? Growl.

## Beyond `SKILL.md` — multi-format support

Skills aren't the only agent-context files with footguns. skill-sniffer also
discovers and lints:

| Format | Matched files | Frontmatter contract? |
| --- | --- | --- |
| **Skill** (native) | `SKILL.md`, `*.skill.md` | ✅ requires `name` + `description` |
| **AGENTS.md** | `AGENTS.md` | — none (degrades gracefully) |
| **CLAUDE.md** | `CLAUDE.md` | — none |
| **Cursor rules** | `.cursorrules`, `.cursor/rules/**.mdc` | — none |
| **MCP manifest** | `mcp.json`, `*.mcp.json` | — none |

The format-agnostic rules — **secrets**, **injection**, **token-bloat**, and
**broken-paths** — run on *every* format. The frontmatter `name`/`description`
contract only applies to native skills; on formats that carry no frontmatter it
degrades gracefully (no false "missing frontmatter" errors), while a genuinely
malformed YAML block is still reported and an overlong `description` is still
warned about wherever one appears.

Control which formats are scanned with repeatable / comma-separated selectors:

```bash
skill-sniffer .                              # all formats (default)
skill-sniffer . --include skill,agents       # only SKILL.md + AGENTS.md
skill-sniffer . --include cursor             # only .cursorrules / .cursor rules
skill-sniffer . --exclude mcp                # everything except MCP manifests
```

Selectors accept friendly aliases (`skills`, `agents.md`, `cursor`, `mcp`, …);
an unrecognized name prints a warning and is ignored.

## Quick start

```bash
# (once published)
npx skill-sniffer ./skills
npx skill-sniffer ./skills/foo/SKILL.md --json
npx skill-sniffer . --sarif skill-sniffer.sarif  # SARIF 2.1.0 for code-scanning
npx skill-sniffer . --include skill,agents,claude  # scan only these formats
npx skill-sniffer . --exclude mcp                  # skip MCP manifests
npx skill-sniffer . --min-score 80    # fail CI if any skill scores under 80
npx skill-sniffer . --max-warnings 0  # fail CI on any warning
npx skill-sniffer . --since origin/main  # only lint skills changed vs a ref (fast CI / pre-commit)
npx skill-sniffer --init              # write a .skillsnifferrc stub
npx skill-sniffer . --config team.json   # use a specific config file
npx skill-sniffer . --no-config          # ignore any .skillsnifferrc
npx skill-sniffer . --fix             # auto-clean the safe stuff in place
npx skill-sniffer . --fix --dry-run   # preview the cleanup as a diff
npx skill-sniffer explain token-bloat # offline docs for a rule id
npx skill-sniffer explain             # list every rule + one-liner
```

## Understanding findings (`explain`)

When skill-sniffer growls it prints a terse finding and a **rule id** (e.g.
`token-bloat`). To turn that cryptic id into a teaching moment, ask it to
`explain` — think "ESLint docs, but in your terminal, offline":

```bash
skill-sniffer explain frontmatter
```

```text
frontmatter  [error]
Require name + description frontmatter on skills; warn on missing or overlong description.

Why this rule exists
A skill's `name` and `description` are the only parts an agent sees before
deciding whether to load it, so a missing or empty one makes the skill
undiscoverable (or silently mis-picked)…

Example
✗ bad (yaml)
  ---
  name:
  description:
  ---
✓ good (yaml)
  ---
  name: pdf-extract
  description: Extract text + tables from PDFs into Markdown.
  ---
```

- **`explain <rule-id>`** — prints the id, default severity, one-line
  description, a longer rationale, and (when available) a colorized bad → good
  example.
- **`explain`** (no argument) — lists every registered rule with its one-liner,
  for discoverability.
- **`explain <unknown-id>`** — exits non-zero and suggests the valid ids, so a
  typo is a nudge rather than a dead end.

Everything is fully offline and zero-dependency — the docs live with the rules.

### Good Boy Score™

Every file starts at **100** and loses points per scent — **error −25**,
**warning −8**, **info −2** — clamped to `[0, 100]`. The **overall** score is the
*minimum* across files (a kennel is only as good as its worst-behaved dog), so a
single nasty skill can't hide behind clean ones in CI.

### CI gates & exit codes

| Exit | Meaning |
| ---- | ------- |
| `0`  | clean — no errors and no gate tripped |
| `1`  | a gate tripped: an `error` finding exists, `--min-score` not met, or `--max-warnings` exceeded |
| `2`  | bad invocation / internal error |

Warnings and info **never** fail the build on their own — only an `error` finding
or an explicit `--min-score` / `--max-warnings` gate does. Add `--json` to get a
stable, schema-versioned report for tooling:

```jsonc
{
  "schema": "skill-sniffer/report@1",
  "version": "0.1.0",
  "score": 50,                 // overall Good Boy Score™ (min across files)
  "skillsChecked": 1,
  "counts": { "error": 2, "warning": 0, "info": 0 },
  "scores": [{ "path": "…/SKILL.md", "score": 50, "counts": { … } }],
  "findings": [{ "ruleId": "broken-paths", "severity": "error",
                 "message": "…", "path": "…", "line": 11, "column": 10 }]
}
```

### Watch mode (`--watch`) — re-sniff on save while authoring

Writing a skill is a tight loop: tweak the frontmatter, adjust a tool grant,
trim some bloat, check the score, repeat. `--watch` collapses that from
*“save → switch terminal → rerun”* to instant. The process stays up, watches the
path(s) you pointed it at, and **re-sniffs on every change**, clearing the screen
and reprinting the report + Good Boy Score™ each cycle.

```bash
skill-sniffer ./skills --watch     # sniff ./skills, then re-sniff on save
skill-sniffer --watch              # bare flag watches the current directory
```

```text
[watch] sniffing ./skills … (Ctrl-C to stop)
🐕 good boy — 3 skill(s) sniffed, no scents found.  🏅 Good Boy Score™: 100/100
[watch] waiting for changes… (Ctrl-C to stop)
# (you save skills/loose/SKILL.md) →
[watch] change detected — re-sniffing…
/abs/skills/loose/SKILL.md
  ✗ error  … missing required frontmatter field `description` (frontmatter)
1 skill(s) sniffed — 1 error. 🐕👅 growl  🦴 Good Boy Score™: 75/100
[watch] waiting for changes… (Ctrl-C to stop)
```

- **Never gates.** Watch is an authoring aid, not a CI check — it *never* exits
  on findings. It runs until **Ctrl-C**, then shuts down cleanly (exit `0`),
  closing every watcher.
- **Re-discovers each cycle.** Added or deleted skill files are picked up
  automatically — it watches the containing director(ies), not a frozen file
  list, so a brand-new `SKILL.md` shows up the moment you create it.
- **Debounced.** A single editor save often fires several filesystem events; a
  short (~120 ms) debounce coalesces the burst into exactly one re-sniff.
- **Respects `--include` / `--exclude` and `.skillsnifferrc`** just like a normal
  run, so what you watch matches what you'd lint.
- **Zero new dependencies** — it's built on Node's `fs.watch`, offline as ever.
- **Human-only.** Streaming machine output onto a clearing screen is nonsense,
  and diff mode is a one-shot CI concept, so `--watch` with `--json`, `--sarif`,
  `--since`, or `--fix` is a usage error (exit `2`).

### Diff mode (`--since <ref>`) — only sniff what changed

On a big kennel, re-scanning every skill on every commit is wasteful. `--since
<ref>` lints **only the skill files that changed vs a git ref** — a three-dot
diff (`<ref>...HEAD`), so it reflects exactly what your branch added or modified
relative to where it forked, ignoring unrelated churn on the base. It's the fast
path for pre-commit hooks and CI.

```bash
skill-sniffer --since HEAD~1          # what did my last commit touch?
skill-sniffer --since origin/main .   # what does this branch change vs main?
skill-sniffer --since                 # bare flag defaults the ref to origin/main
```

- The changed set is **intersected with normal discovery** — the usual
  `**/SKILL.md` / `*.skill.md` (+ `--include` / `--exclude` format filters) still
  apply, so an unchanged or excluded-format file is never linted.
- All the usual gates (`--min-score`, `--max-warnings`) and outputs (`--json`,
  `--sarif`) apply to the changed subset.
- **No changed skill files** → exit `0` with a friendly *“nothing changed to
  sniff”* note (great for pre-commit: it just no-ops when your change didn't
  touch a skill).
- **Not a git repo** or an **unknown ref** → a clear error and exit `2`
  (deliberately distinct from the clean no-changes case).

A minimal **pre-commit** hook that only sniffs staged-branch changes:

```bash
#!/usr/bin/env bash
# .git/hooks/pre-commit
exec npx skill-sniffer --since HEAD --min-score 80 .
```

And the **fast-CI** shape — sniff just the PR's changes against its base:

```yaml
- uses: actions/checkout@v4
  with: { fetch-depth: 0 }        # need history for the diff
- run: npx skill-sniffer --since origin/${{ github.base_ref }} . --min-score 80
```

> The bundled [GitHub Action](#github-action-pr-scores) already diffs the PR base
> internally; `--since` brings that same changed-only speed to **local** runs and
> hand-rolled CI. Both share one implementation under the hood.

### Token leaderboard (`rank`) — what's eating your context?

Every skill file is injected into your agent's context *verbatim, every time it
loads* — so its size is a recurring tax on every turn. The `token-bloat` rule
*warns* when a single file crosses a budget; `skill-sniffer rank` takes the
complementary view and sorts **every** discovered file heaviest-first, so you
can see at a glance which ones to trim first.

```bash
skill-sniffer rank ./skills
```

```
  ~5212  skills/loose/SKILL.md 💩 over budget
   ~840  skills/deploy/SKILL.md
   ~312  skills/hello/SKILL.md

3 file(s), ~6364 tokens total, ~2121 avg, 1 over the 2000 budget. Heaviest: skills/loose/SKILL.md
```

- **Same estimate as the linter.** `rank` reuses the exact chars/4 heuristic
  `token-bloat` uses, so the two views never disagree about what "heavy" means.
- `--top <n>` shows only the *n* heaviest rows — but the **total and average
  still reflect every file**, so capping the list never lies about the sum.
- `--budget <n>` sets the over-budget flag threshold (default `2000`, matching
  `token-bloat`).
- `--include` / `--exclude` and `--since <ref>` scope the file set exactly like
  `sniff`, so you can rank *just what changed* on a branch.
- `--json` emits a stable, schema-versioned (`skill-sniffer/rank@1`) payload —
  heaviest-first `entries`, plus `total` / `average` / `overBudgetCount` /
  `filesRanked` — for budgeting scripts and CI dashboards.

```bash
skill-sniffer rank ./skills --top 5 --json
```

`rank` is a **report, not a gate**: it never lints, never fails on a heavy file,
and always exits `0` on success (a bad `--since` ref still exits `2`). Use it to
spot bloat; use `sniff --min-score` to actually enforce it.

### SARIF output (`--sarif`) — findings in the GitHub UI

`--json` is great for tooling, but findings still only live in logs. **SARIF
2.1.0** (`--sarif`) is the format GitHub **code-scanning** speaks: upload it and
every finding shows up in the **Security tab** and as an **inline PR annotation**
on the exact line — the same integration ESLint and shellcheck get, no server
required.

```bash
skill-sniffer ./skills --sarif skill-sniffer.sarif   # write SARIF to a file
skill-sniffer ./skills --sarif                       # …or stream it to stdout
```

- `--sarif <path>` writes SARIF to that file; you can combine it with `--json`
  (JSON goes to stdout, SARIF to the file).
- Bare `--sarif` streams SARIF to **stdout** and is therefore **mutually
  exclusive** with `--json` (two machine formats can't share stdout).
- Severity maps to SARIF levels: `error → error`, `warning → warning`,
  `info → note`. Findings with a line number get a `region.startLine`; whole-file
  findings degrade to a file-level annotation. Artifact URIs are **repo-relative**
  so annotations land on the right file on any runner.

Upload it from a workflow with `github/codeql-action/upload-sarif`:

```yaml
# .github/workflows/skill-sniffer-sarif.yml
name: skill-sniffer (code-scanning)
on:
  pull_request:
    paths: ["**/SKILL.md", "**/*.skill.md"]

permissions:
  contents: read
  security-events: write   # required to upload SARIF

jobs:
  sniff:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npx skill-sniffer . --sarif skill-sniffer.sarif
        continue-on-error: true   # upload results even when the gate trips
      - uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: skill-sniffer.sarif
```

The bundled GitHub Action can emit the SARIF for you too — set its `sarif` input
(see the [table below](#github-action-pr-scores)) and add an `upload-sarif` step
pointed at that path.

### GitHub Action (PR scores)

Gate skills in CI and get the Good Boy Score™ commented right on the PR. The
action lints only the **changed** skill files in a pull request and posts a
single *sticky* comment (it edits the same comment each push instead of spamming
new ones).

```yaml
# .github/workflows/skill-sniffer.yml
name: skill-sniffer
on:
  pull_request:
    paths:
      - "**/SKILL.md"
      - "**/*.skill.md"

permissions:
  contents: read
  pull-requests: write   # needed to post the score comment

jobs:
  sniff:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0      # so the action can diff against the PR base
      - uses: rwrife/skill-sniffer@v1
        with:
          min-score: "80"     # fail the check if any changed skill scores < 80
```

**Inputs**

| Input | Default | Description |
| ----- | ------- | ----------- |
| `min-score` | _(none)_ | Fail the check if the overall score (min across changed files) is below this. Blank = only fail on `error` findings. |
| `comment` | `true` | Post/update the sticky PR comment. Set `"false"` to run as a silent gate. |
| `sarif` | _(none)_ | Path to write a SARIF 2.1.0 report to (e.g. `"skill-sniffer.sarif"`) for a downstream `upload-sarif` step. Blank = no SARIF. |
| `github-token` | `${{ github.token }}` | Token used for the comment (needs `pull-requests: write`). |

**Outputs**: `score` (0–100), `passed` (`"true"`/`"false"`), and `findings`
(total count) — handy for downstream steps.

To also surface findings in code-scanning, set the `sarif` input and add an
upload step:

```yaml
      - uses: rwrife/skill-sniffer@v1
        with:
          sarif: skill-sniffer.sarif
      - uses: github/codeql-action/upload-sarif@v3
        if: always()   # upload even if the gate failed the check
        with:
          sarif_file: skill-sniffer.sarif
```

(Uploading needs `security-events: write` in the job's `permissions`.)

The comment shows a pass/fail headline, a per-file score table (worst dog first),
and the loudest findings. No changed skill files? It posts a quiet "nothing to
sniff" and passes, clearing any earlier red comment.

### Config (`.skillsnifferrc`)

Tune the dog per project. `--init` drops a `.skillsnifferrc` stub (it won't
clobber an existing one):

```jsonc
{
  "$schema": "skill-sniffer/config@1",
  "tokenBudget": 2000,   // token-bloat warning budget (chars/4 heuristic)
  "minScore": 0,         // fail if any skill scores below this (0 disables)
  "maxWarnings": -1,     // fail if total warnings exceed this (-1 disables)
  "rules": {
    // off / on, a severity ("error" | "warning" | "info"), or { enabled, severity }
    "injection": "on",
    "token-bloat": "warning",
    "broken-paths": "off"
  }
}
```

**What you can configure**

- **Enable/disable rules** by id — `false`/`"off"` turns a rule off, `true`/`"on"`
  keeps it. Rule ids: `frontmatter`, `secrets`, `injection`, `tool-scope`,
  `broken-paths`, `token-bloat`.
- **Override severity** — give a rule a severity string (`"error"`/`"warning"`/
  `"info"`) to change how loud it is, or the object form
  `{ "enabled": true, "severity": "error" }`.
- **Token budget** + the **`minScore` / `maxWarnings`** CI-gate defaults.

**Discovery & formats.** skill-sniffer walks **upward** from the target path
until it finds the first of `.skillsnifferrc`, `.skillsnifferrc.json`,
`.skillsnifferrc.yaml`, or `.skillsnifferrc.yml` (so one rc at your repo root
covers every skill below it). JSON and YAML are both supported — the
extension-less dotfile accepts either. No new dependency: YAML is parsed by the
same engine that reads frontmatter.

**Precedence** (highest wins):

```
built-in defaults  <  .skillsnifferrc  <  CLI flags
```

So `--min-score 90` overrides a config `minScore`, and `--max-warnings`
overrides a config `maxWarnings`. Point at a specific file with
`--config <path>` (a named-but-missing file is a usage error), or ignore any
config entirely with `--no-config`. Unknown keys and bad values are reported as
non-fatal `config warning:` notes rather than failing the run.

### Auto-fix (`--fix`)

`--fix` mechanically cleans up the findings that are **unambiguously safe** to
rewrite, so you don't hand-edit boilerplate:

- **Strips invisible/bidi characters** — the zero-width and direction-override
  chars the injection rule flags (they render as nothing but still reach the model).
- **Reorders frontmatter** — hoists `name` then `description` to the top, leaving
  every other key in place. It's a *textual* reorder: quoting, comments, and
  block scalars are preserved verbatim (no YAML re-serialization).
- **Trims trailing whitespace** on every line.
- **Collapses redundant blank lines** (3+ → 1) and normalizes the trailing newline.

It is **safe by construction**: `--fix` never rewrites prompt-injection *intent*
and never touches secrets — those stay reported for a human to handle. It's also
idempotent (running it twice changes nothing) and skips malformed YAML rather
than guessing. Add `--dry-run` to preview the changes as a unified diff without
writing any files:

```bash
$ skill-sniffer ./skills --fix --dry-run
would fix skills/foo/SKILL.md 🐕
  • stripped 1 invisible/bidi character
  • reordered 2 frontmatter keys (name, description first)
  • trimmed trailing whitespace on 3 lines
```

`--fix` is a maintenance action, not a gate: it always exits `0` on success
(whether or not anything needed fixing) and `2` only on a read/write error. Keep
using a plain `skill-sniffer .` run (with `--min-score` / `--max-warnings`) to
gate CI.

## Local development

```bash
npm install
npm run build      # compile src/ -> dist/
npm test           # vitest
node bin/skill-sniffer --version
node bin/skill-sniffer path/to/skills/   # discovers SKILL.md / *.skill.md / AGENTS.md / CLAUDE.md / .cursorrules / MCP manifests and parses each
```

Point it at a directory and it recursively discovers every `SKILL.md` and
`*.skill.md`, parses frontmatter + body, runs the rule engine, and prints a
report grouped by file (malformed or unreadable files are flagged, never
fatal):

```
$ node bin/skill-sniffer ./skills
/abs/skills/foo/SKILL.md
  ⚠ warning frontmatter `description` is 355 chars (over 200); trim it to save context tokens (frontmatter)
/abs/skills/bar/SKILL.md
  ✗ error  🐕👅 missing required frontmatter field `name` (frontmatter)

2 skill(s) sniffed — 1 error, 1 warning. 🐕👅 growl
```

A clean run gets a wag:

```
$ node bin/skill-sniffer ./skills
🐕 good boy — 3 skill(s) sniffed, no scents found.
```

## Why not just use SkillSpector / eslint?

- **SkillSpector** is a heavyweight enterprise vulnerability scanner. skill-sniffer is the 2-second local dog at the door you walk past every day.
- **eslint/markdownlint** don't understand skill *semantics* — frontmatter contracts, token budgets, tool-grant scope, or injection aimed at agents.
- **Offline by design.** No network, no telemetry, no LLM calls. Runs in CI without secrets.

## Status

✅ **v0.1 feature-complete** (M1–M6). The full v0.1 ruleset, Good Boy Score™, `--json`, and CI gates are in. **v0.2 in progress:** `--fix` auto-cleanup, `.skillsnifferrc` config (rule enable/disable, severity overrides, tunable budget/gates), and multi-format support (`AGENTS.md` / `CLAUDE.md` / `.cursorrules` / MCP manifests) have landed.

- **M1 — Scaffold + hello-world ✅** TS/ESM project, `commander` CLI, `--version`, CI (build + test) on Node 18/20/22.
- **M2 — Parse + discover ✅** Recursive discovery of `SKILL.md` / `*.skill.md`, gray-matter frontmatter parsing into a `ParsedSkill` (`{ path, frontmatter, body, raw, error? }`), graceful handling of missing / empty / malformed-YAML files.
- **M3 — Rule engine + frontmatter rule + report ✅** Pluggable rule engine (`Rule` / `Finding` / `Report` types), the first real rule (`frontmatter`: requires `name` + `description`, warns on overlong descriptions, surfaces malformed YAML), and a terminal report grouped by file with severity colors. A throwing rule is isolated, never fatal.
- **M4 — Secret + prompt-injection rules ✅** The headline scents. `secrets` detects high-confidence credential shapes (AWS keys, `sk-…` provider keys, GitHub/Slack/Google tokens, PEM private-key headers, generic `API_KEY=value` assignments) and **redacts** the value in its message; obvious docs placeholders (`sk-xxxx`, `AKIA…EXAMPLE`, `your-api-key`) are ignored to keep false positives near zero. `injection` flags prompt-injection bait ("ignore previous instructions", "you are now…", "disregard your system prompt", exfiltration/guardrail-bypass lines), zero-width/bidi control characters (by codepoint), and agent-directed `<!-- … -->` comments. Findings carry **line + column**.
- **M5 — Token-bloat + broken-path + tool-scope rules ✅** Rounds out the v0.1 ruleset. `token-bloat` estimates token weight (chars/4 heuristic) and warns past a configurable budget (default 2000). `broken-paths` extracts relative file references (markdown links/images + path-shaped inline code), resolves each against the **skill's own directory**, and errors on the ones missing from disk — URLs, anchors, and absolute/home paths are deliberately ignored. `tool-scope` flags wildcard / overly broad tool grants both in frontmatter (`allowed-tools: { exec: "*" }`, bare `*` in arrays) and in prose ("any shell command", "run arbitrary code", "unrestricted access").
- **M6 — Good Boy Score + JSON + CI gates ✅** Makes it scorable and CI-friendly. `score.ts` turns findings into a **Good Boy Score™** (0–100) per file and overall (the overall is the *minimum* per-file score, so the weakest skill sets the grade). `--json` emits a stable, schema-versioned (`skill-sniffer/report@1`) machine report. CI gates: `--min-score <n>` and `--max-warnings <n>` with proper non-zero exit codes (`0` clean, `1` gate tripped, `2` usage error); errors always fail, warnings/info only fail behind a gate. `--init` writes a `.skillsnifferrc` config stub (never clobbering an existing one).
- **v0.2 — `--fix` auto-cleanup ✅** Mechanically rewrites the *unambiguously safe* findings: strips invisible/bidi chars, reorders frontmatter (`name`/`description` first, formatting preserved), trims trailing whitespace, and collapses redundant blank lines. Safe by construction — never rewrites prompt-injection intent or secrets — idempotent, and skips malformed YAML. `--dry-run` previews the changes as a unified diff.
- **v0.2 — GitHub Action + PR score comment ✅** A drop-in `uses: rwrife/skill-sniffer@v1` composite action that lints the **changed** skill files in a PR (three-dot `base...HEAD` diff), then posts/updates a single *sticky* comment with a pass/fail headline, a per-file Good Boy Score™ table, and the loudest findings. A `min-score` input fails the check; `comment: false` runs it as a silent gate; it exposes `score`/`passed`/`findings` outputs. See the [GitHub Action](#github-action-pr-scores) usage above.
- **v0.2 — Multi-format support ✅** Discovers and lints `AGENTS.md`, `CLAUDE.md`, `.cursorrules` / `.cursor/rules/**.mdc`, and MCP manifests (`mcp.json` / `*.mcp.json`) alongside native `SKILL.md`. Format-agnostic rules (secrets, injection, token-bloat, broken-paths) run on all of them; the frontmatter `name`/`description` contract applies to skills only and degrades gracefully elsewhere. `--include` / `--exclude` choose which formats to scan.
- **v0.2 — SARIF output ✅** `--sarif [path]` emits a **SARIF 2.1.0** report (backlog item #6) so findings surface natively in **GitHub code-scanning** (Security tab + inline PR annotations) via `github/codeql-action/upload-sarif`. Maps severity → SARIF level (`error`/`warning`/`note`), emits the rule registry as `reportingDescriptor`s, and uses **repo-relative** artifact URIs; findings with a line get a `region`, whole-file ones degrade to file-level. The GitHub Action gained a `sarif` input to write the file for a downstream upload step. See the [SARIF output](#sarif-output---sarif--findings-in-the-github-ui) section above.
- **v0.2 — `explain` command ✅** `skill-sniffer explain <rule-id>` prints offline docs for a rule: id, default severity, one-line description, a longer rationale, and a colorized bad → good example. `explain` with no argument lists every registered rule for discoverability; an unknown id exits non-zero and suggests the valid ids. Zero new dependencies — the docs live alongside the rules via optional `rationale`/`example` metadata on the `Rule` contract. See [Understanding findings](#understanding-findings-explain) above.

- **v0.2 — Diff mode (`--since`) ✅** `skill-sniffer --since <ref>` lints only the skill files changed vs a git ref (a three-dot `<ref>...HEAD` diff; bare `--since` defaults to `origin/main`) for fast pre-commit / CI runs. The changed set is intersected with normal discovery + `--include`/`--exclude`, so unchanged or excluded-format files are skipped; all gates and outputs apply to the subset. No changed skills exits `0` with a friendly note; a non-repo or unknown ref errors with exit `2`. The changed-files logic is shared with the GitHub Action (one implementation in `src/git.ts`). See the [Diff mode](#diff-mode---since-ref--only-sniff-what-changed) section above.

- **v0.2 — Token leaderboard (`rank`) ✅** `skill-sniffer rank [paths…]` (backlog item #8) sorts discovered agent-context files **heaviest-first** by estimated token weight, reusing the *same* chars/4 estimate as `token-bloat` so the views never drift. `--top <n>` caps the shown rows while the total/average still cover every file; `--budget <n>` sets the over-budget flag (default 2000); `--include`/`--exclude` and `--since` scope the set exactly like `sniff`; `--json` emits a schema-versioned (`skill-sniffer/rank@1`) payload. It's a report, not a gate — always exits `0` on success (a bad `--since` ref still exits `2`). See the [Token leaderboard](#token-leaderboard-rank--whats-eating-your-context) section above.

- **v0.2 — Watch mode (`--watch`) ✅** `skill-sniffer <path> --watch` (backlog item #11) keeps the process alive and **re-sniffs on save**, clearing + reprinting the report and Good Boy Score™ each cycle to tighten the authoring loop. It re-discovers every cycle (so added/deleted skills are caught), **debounces** bursty editor writes into one re-run, and honors `--include`/`--exclude` + `.skillsnifferrc`. It never gates — it runs until Ctrl-C, then exits `0` cleanly and closes its watchers. Built on Node's `fs.watch` (zero new deps); mutually exclusive with `--json`/`--sarif`/`--since`/`--fix` (exit `2`). See the [Watch mode](#watch-mode---watch--re-sniff-on-save-while-authoring) section above.

The scary stuff produces error-severity findings with a redacted value and a location:

```
$ node bin/skill-sniffer ./skills
/abs/skills/evil/SKILL.md
  ✗ error  🐕👅:8:1 prompt-injection instruction-override phrase: "Ignore previous instructions" (injection)
  ✗ error  🐕👅:10:32 possible OpenAI/Anthropic-style secret key leaked: sk-p…••••••Cy (secrets)
  ✗ error  🐕👅:12:1 hidden right-to-left override (U+202E) in skill text (injection)

1 skill(s) sniffed — 3 errors. 🐕👅 growl
```

The token/path/scope scents fire on the obvious footguns:

```
$ node bin/skill-sniffer ./skills
/abs/skills/loose/SKILL.md
  ✗ error  🐕👅 overly broad tool grant in `allowed-tools`: `exec: *` — scope it to the specific tools the skill needs (tool-scope)
  ✗ error  🐕👅:11:10 broken local path: `./scripts/missing-tool.sh` does not exist (resolved against the skill's directory) (broken-paths)
  ⚠ warning skill is ~5212 tokens (over the 2000 budget); trim it to save context on every load (token-bloat)

1 skill(s) sniffed — 2 errors, 1 warning. 🐕👅 growl
```

Findings roll up into a **Good Boy Score™**, and CI gates turn that into a pass/fail:

```
$ node bin/skill-sniffer ./skills --min-score 80
/abs/skills/loose/SKILL.md
  ✗ error  🐕👅 overly broad tool grant in `allowed-tools`: `exec: *` — scope it to the specific tools the skill needs (tool-scope)
  ✗ error  🐕👅:11:10 broken local path: `./scripts/missing-tool.sh` does not exist (resolved against the skill's directory) (broken-paths)

1 skill(s) sniffed — 2 errors. 🐕👅 growl
💩 Good Boy Score™: 50/100
$ echo $?
1
```

A clean run wags and exits `0`:

```
$ node bin/skill-sniffer ./skills --min-score 80
🐕 good boy — 3 skill(s) sniffed, no scents found.
🏅 Good Boy Score™: 100/100
$ echo $?
0
```

See [`PLAN.md`](./PLAN.md) for the roadmap (M1–M6) and the v0.2+ backlog. SARIF
output (`--sarif`), the `explain` command, diff/`--since` mode, the `rank`
leaderboard, and watch mode (`--watch`) are done. `--fix`, config, the GitHub
Action, and multi-format support are done too.

## License

MIT
