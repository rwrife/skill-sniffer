# skill-sniffer 🐕👃

> An ESLint for the Skills era. Point it at your `SKILL.md` files; it sniffs out the footguns before your agent eats them.

## 1. Pitch

Everybody is writing agent skills now — `SKILL.md` files for Claude Code, Codex CLI, and friends — and almost nobody is checking them for landmines. **skill-sniffer** is a paranoid, offline CLI that lints, audits, and **scores** your skill files: it flags leaked secrets, prompt-injection bait, token bloat, broken local paths, missing frontmatter, and tool grants that are way too broad. Think `eslint`/`shellcheck`, but for the thing you're about to hand an autonomous agent.

## 2. Trend inspiration

The Skills ecosystem went vertical in mid-2026, and the very next beat is **governance, security, and "does this skill actually help?"** That's the wave skill-sniffer rides.

- **GitHub Trending Weekly (2026-06-17)** — the Skills ecosystem is explicitly entering its "security governance phase." `addyosmani/agent-skills` (+11k stars/wk, 61k total) is the production-grade skills library; `agent-skills-eval` (HN: "do skills actually improve agent output?") shows the community pivoting from *adoption* to *critical evaluation*. <https://www.shareuhack.com/en/posts/github-trending-weekly-2026-06-17>
- **NVIDIA/SkillSpector** (+4.6k stars/wk) — a scanner that found **26% of AI skills in the wild contain vulnerabilities.** Heavy, enterprise-flavored, server-side. There is an obvious gap for a *tiny local linter* you run before you commit. <https://github.com/NVIDIA/SkillSpector>
- **chopratejas/headroom** (+10.6k stars/wk) — "compress tool outputs/logs/RAG chunks, 60–95% fewer tokens." Token budget is a first-class concern in 2026; bloated skill files burn context. skill-sniffer treats **token weight as a lint rule**, inspired by this. <https://github.com/chopratejas/headroom>
- **Non-AI practical utilities are breaking through** — `tamnd/kage` (Go, offline site-mirror) outscored most AI tools on HN, signaling devs reward small, offline, *useful* tools over hype. skill-sniffer is deliberately offline-first in that spirit.
- **Anti-cloud / privacy demand** — "What 9,300 Reddit posts reveal about app gaps in 2026" highlights a strong local-first / no-cloud movement. A linter that never phones home fits that mood. <https://digitalbiztalk.com/article/what-9300-reddit-posts-reveal-about-app-gaps-in-2026>

## 3. Why it's different

- **vs NVIDIA SkillSpector** — that's a heavyweight vulnerability *scanner* (Python, enterprise, CI-scale, security-team audience). skill-sniffer is a **2-second local CLI** with a developer-friendly score, opinionated style rules, and `--fix`. SkillSpector is the airport scanner; skill-sniffer is the dog at the door you actually walk past every day.
- **vs `eslint`/`markdownlint`** — generic linters don't understand skill *semantics*: frontmatter contracts (`name`/`description`/`location`), token budgets, tool-grant scope, or injection patterns aimed at *agents*. skill-sniffer has rules that only make sense for skills.
- **vs our own `canary-cage`** — canary-cage plants runtime tripwires to *catch agents in the act* of biting injected text. skill-sniffer does **static analysis of the skill files themselves**, before runtime, so the bait never ships. Defense-in-depth, opposite end of the pipeline.
- **vs our own `link-coroner`** — link-coroner autopsies dead *URLs* across a repo. skill-sniffer checks *local file paths referenced by skills* (the classic "resolve relative to SKILL.md" footgun) plus a dozen non-link rules. Different target, different ruleset.
- **Personality** — it's a sniffer dog. Findings are "scents." A clean file gets a wag; a leaked key gets a growl. The score is a **Good Boy Score™** out of 100.

As far as I know, there's no small, offline, opinionated *linter-with-a-score* aimed specifically at hand-authored skill files. SkillSpector is the closest, and it's a different weight class.

## 4. MVP scope (v0.1)

The smallest genuinely-useful thing:

- `skill-sniffer <path>` — lint a single `SKILL.md` or a directory of skills (recursive glob for `**/SKILL.md` + `*.skill.md`).
- **Frontmatter rules** — require `name` + `description`; warn on missing/overlong `description`; flag malformed YAML.
- **Secret detection** — regex pack for common keys (AWS, OpenAI/Anthropic-style `sk-...`, GitHub PAT `ghp_`, generic `API_KEY=`, private-key headers).
- **Prompt-injection scent** — flag classic bait phrases ("ignore previous instructions", "you are now", "disregard your system prompt", hidden/zero-width chars, suspicious `<!-- -->` instruction comments).
- **Token-bloat rule** — estimate token weight (chars/4 heuristic); warn past a configurable budget (default 2k).
- **Broken-path rule** — resolve relative paths mentioned in the skill against the skill's own directory; flag ones that don't exist on disk.
- **Tool-grant scope** — if frontmatter/body declares allowed tools, flag wildcards / overly broad grants (e.g. `exec: *`, "any shell command").
- **Output** — pretty terminal report grouped by file, severity colors, and a **Good Boy Score™** (0–100). `--json` for machines/CI. Non-zero exit when errors found (`--max-warnings`, `--min-score` gates).

## 5. Tech stack

Boring, fast, zero-network.

- **Node.js + TypeScript** — ubiquitous in the agent-tooling world, trivial `npx skill-sniffer` distribution, great for shipping a single CLI binary later via `pkg`/`bun build`.
- **`commander`** — argument parsing, dependable.
- **`gray-matter`** — battle-tested YAML frontmatter parsing.
- **`picocolors`** — tiny, fast terminal colors (no chalk bloat).
- **`fast-glob`** — recursive file discovery.
- **`vitest`** — fast tests, ESM-native.
- **No network, no telemetry, no LLM calls.** Pure static analysis. Offline by design — that's a feature, not a limitation.

Justification: every dep here is small, stable, and load-bearing. The whole point is a tool that starts instantly and runs in CI without secrets or network.

## 6. Architecture

```
bin/skill-sniffer        # thin CLI entry → src/cli.ts
src/
  cli.ts                 # commander setup, flags, exit codes
  discover.ts            # glob skill files from path(s)
  parse.ts               # read file + gray-matter → { frontmatter, body, raw }
  engine.ts              # run all rules over each parsed skill, collect Findings
  score.ts               # Findings → Good Boy Score (0–100)
  report/
    pretty.ts            # human terminal report (grouped, colorized, wag/growl)
    json.ts              # machine-readable report
  rules/
    index.ts             # rule registry (id, severity, run())
    frontmatter.ts
    secrets.ts
    injection.ts
    token-bloat.ts
    broken-paths.ts
    tool-scope.ts
  types.ts               # Finding, Rule, Severity, Report
```

Core contract: a **Rule** is `{ id, description, defaultSeverity, run(skill, ctx) => Finding[] }`. The engine just maps rules over skills and aggregates. Adding a rule = drop a file in `rules/`, register it. That's the whole extensibility story.

## 7. Milestones (each shippable)

1. **M1 — Scaffold + hello-world.** TS project, `commander` CLI, `bin/` entry, `skill-sniffer --version` / `skill-sniffer <file>` prints "sniffed: <file> 🐕" and exits 0. CI runs build + a trivial test.
2. **M2 — Parse + discover.** `discover.ts` globs `**/SKILL.md`/`*.skill.md`; `parse.ts` returns frontmatter+body via gray-matter. Handles missing/empty/malformed files gracefully.
3. **M3 — Rule engine + frontmatter rule + report.** `engine.ts`, `types.ts`, the rule registry, the first real rule (frontmatter `name`/`description`), and the pretty report grouped by file with severities.
4. **M4 — Secret + injection rules.** Regex packs for secrets and prompt-injection bait (incl. zero-width/hidden chars). These are the headline value.
5. **M5 — Token-bloat + broken-path + tool-scope rules.** Round out the ruleset; `broken-paths` resolves against each skill's own dir.
6. **M6 — Good Boy Score + JSON + CI gates.** `score.ts`, `--json`, `--min-score`, `--max-warnings`, proper non-zero exit codes. Document usage in README; ship a `--init` config stub.

## 8. Backlog / future features (v0.2+)

1. **`--fix`** — auto-strip zero-width chars, normalize frontmatter ordering, trim trailing bloat.
2. **Config file** (`.skillsnifferrc`) — enable/disable rules, tune severities, set token budget per project.
3. **Custom rule plugins** — load user rules from a `skill-sniffer-plugin-*` package.
4. **GitHub Action** — drop-in `uses: rwrife/skill-sniffer@v1` that comments the score on PRs touching skill files.
5. **Diff mode** — only lint skills changed vs `main` (`--since`), for fast CI.
6. **SARIF output** — so findings show in GitHub code-scanning UI.
7. **Multi-format support** — `AGENTS.md`, `CLAUDE.md`, `.cursorrules`, MCP server manifests.
8. **Token-weight leaderboard** — `skill-sniffer rank` sorts your skills heaviest-first (headroom-style budgeting).
9. **Injection rule packs** — versioned, updatable bait signatures (community-contributed).
10. **"Explain" mode** — `skill-sniffer explain <rule-id>` with rationale + a safe rewrite example.
11. **Watch mode** — `--watch` re-sniffs on save during authoring.
12. **Score badge** — emit a shields.io-style Good Boy Score badge for your README.

## 9. Out of scope

- **Runtime / live-agent interception.** That's canary-cage's job. skill-sniffer is static-only.
- **Actually executing skills or calling any LLM.** No network, ever, in core.
- **Auto-fixing prompt-injection semantics.** We flag and (later) strip obvious junk; we don't rewrite intent.
- **A hosted dashboard / SaaS / accounts.** This is a CLI. Local-first, no telemetry.
- **Full SAST of arbitrary code referenced by skills.** We sniff the skill file and its declared surface, not your whole codebase.
- **Non-Markdown skill formats in v0.1** (binary/proprietary) — backlog only.
