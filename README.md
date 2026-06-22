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

## Why not just use SkillSpector / eslint?

- **SkillSpector** is a heavyweight enterprise vulnerability scanner. skill-sniffer is the 2-second local dog at the door you walk past every day.
- **eslint/markdownlint** don't understand skill *semantics* — frontmatter contracts, token budgets, tool-grant scope, or injection aimed at agents.
- **Offline by design.** No network, no telemetry, no LLM calls. Runs in CI without secrets.

## Status

🚧 Early. See [`PLAN.md`](./PLAN.md) for the roadmap (M1–M6) and backlog.

## License

MIT
