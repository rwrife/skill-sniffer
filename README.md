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
npx skill-sniffer . --include skill,agents,claude  # scan only these formats
npx skill-sniffer . --exclude mcp                  # skip MCP manifests
npx skill-sniffer . --min-score 80    # fail CI if any skill scores under 80
npx skill-sniffer . --max-warnings 0  # fail CI on any warning
npx skill-sniffer --init              # write a .skillsnifferrc stub
npx skill-sniffer . --config team.json   # use a specific config file
npx skill-sniffer . --no-config          # ignore any .skillsnifferrc
npx skill-sniffer . --fix             # auto-clean the safe stuff in place
npx skill-sniffer . --fix --dry-run   # preview the cleanup as a diff
```

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
| `github-token` | `${{ github.token }}` | Token used for the comment (needs `pull-requests: write`). |

**Outputs**: `score` (0–100), `passed` (`"true"`/`"false"`), and `findings`
(total count) — handy for downstream steps.

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

See [`PLAN.md`](./PLAN.md) for the roadmap (M1–M6) and the v0.2+ backlog (SARIF output, diff/`--since` mode). `--fix`, config, the GitHub Action, and multi-format support are done.

## License

MIT
