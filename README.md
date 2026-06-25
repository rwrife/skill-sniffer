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

## Quick start

```bash
# (once published)
npx skill-sniffer ./skills
npx skill-sniffer ./skills/foo/SKILL.md --json
npx skill-sniffer . --min-score 80   # fail CI if any skill scores under 80
```

## Local development

```bash
npm install
npm run build      # compile src/ -> dist/
npm test           # vitest
node bin/skill-sniffer --version
node bin/skill-sniffer path/to/skills/   # discovers SKILL.md / *.skill.md and parses each
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

🚧 Early.

- **M1 — Scaffold + hello-world ✅** TS/ESM project, `commander` CLI, `--version`, CI (build + test) on Node 18/20/22.
- **M2 — Parse + discover ✅** Recursive discovery of `SKILL.md` / `*.skill.md`, gray-matter frontmatter parsing into a `ParsedSkill` (`{ path, frontmatter, body, raw, error? }`), graceful handling of missing / empty / malformed-YAML files.
- **M3 — Rule engine + frontmatter rule + report ✅** Pluggable rule engine (`Rule` / `Finding` / `Report` types), the first real rule (`frontmatter`: requires `name` + `description`, warns on overlong descriptions, surfaces malformed YAML), and a terminal report grouped by file with severity colors. A throwing rule is isolated, never fatal.
- **M4 — Secret + prompt-injection rules ✅** The headline scents. `secrets` detects high-confidence credential shapes (AWS keys, `sk-…` provider keys, GitHub/Slack/Google tokens, PEM private-key headers, generic `API_KEY=value` assignments) and **redacts** the value in its message; obvious docs placeholders (`sk-xxxx`, `AKIA…EXAMPLE`, `your-api-key`) are ignored to keep false positives near zero. `injection` flags prompt-injection bait ("ignore previous instructions", "you are now…", "disregard your system prompt", exfiltration/guardrail-bypass lines), zero-width/bidi control characters (by codepoint), and agent-directed `<!-- … -->` comments. Findings carry **line + column**.

The scary stuff produces error-severity findings with a redacted value and a location:

```
$ node bin/skill-sniffer ./skills
/abs/skills/evil/SKILL.md
  ✗ error  🐕👅:8:1 prompt-injection instruction-override phrase: "Ignore previous instructions" (injection)
  ✗ error  🐕👅:10:32 possible OpenAI/Anthropic-style secret key leaked: sk-p…••••••Cy (secrets)
  ✗ error  🐕👅:12:1 hidden right-to-left override (U+202E) in skill text (injection)

1 skill(s) sniffed — 3 errors. 🐕👅 growl
```

More rules (token-bloat, broken-paths, tool-scope), the **Good Boy Score™**, `--json`, and CI gates (`--min-score`, `--max-warnings`, non-zero exit) arrive in M5–M6. See [`PLAN.md`](./PLAN.md) for the roadmap (M1–M6) and backlog.

## License

MIT
