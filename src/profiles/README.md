# Built-in compatibility profiles

`skill-sniffer compat <path>` evaluates local skill files against these bundled
JSON profiles, offline. Sources were checked on 2026-11-17. These are conservative
static contracts, **not host emulators or guarantees that a skill will load**.
Host versions, configuration, permissions, environment gates, duplicates,
symlinks, aggregate context budgets, and supporting files are not evaluated.

| Profile | Required metadata | Description advisory | Project discovery guidance |
| --- | --- | --- | --- |
| `claude-code` | None (directory/body fallbacks) | 1536 characters, including `when_to_use`; listing truncates | `.claude/skills/*/SKILL.md` |
| `codex` | `name`, `description` | 1024 characters (spec, enforcement unverified) | `.agents/skills/*/SKILL.md` |
| `copilot` | `name`, `description` | 1024 characters (spec, enforcement unverified) | `.github/skills/*/SKILL.md`, `.claude/skills/*/SKILL.md`, `.agents/skills/*/SKILL.md` |
| `openclaw` | `description` (name falls back to directory) | 1024 characters (spec, enforcement unverified) | `skills/**/SKILL.md`, `.agents/skills/**/SKILL.md` |

Sources: [Claude Code](https://code.claude.com/docs/en/skills),
[Codex](https://developers.openai.com/codex/skills),
[Copilot](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/add-skills),
[OpenClaw](https://docs.openclaw.ai/tools/skills), and the
[Agent Skills specification](https://agentskills.io/specification).

## JSON fields and severity

- `requiredFields`: non-empty string metadata checked using the existing
  frontmatter rule. Missing required values fail. Claude Code documents all
  fields as optional; OpenClaw's loading section documents a name fallback
  despite the stricter authoring example.
- `allowedFrontmatterKeys`: documented host fields plus standard metadata.
  Other keys warn, not fail: ignored and unknown behavior must not be confused
  with rejection. Claude Code explicitly ignores unknown keys.
- `forbiddenFrontmatterKeys`: documented rejections only. Currently empty:
  no verified local-host forbidden-key rejection is asserted.
- `maxDescriptionLength`, `descriptionSuffixField`: advisory character limit,
  optionally combining the description and another string field with a newline.
  Limits count Unicode code points; exceeding them warns, never claims rejection.
- `maxBytes`: verified per-file rejection limit, measured as UTF-8 bytes.
  Currently `null` for all profiles: **unknown, not unlimited**. Managed OpenClaw
  upload limits and claude.ai upload validation do not apply to these profiles.
- `tokenBudget`: approximate raw-file token advisory using the existing
  token-bloat rule (characters / 4). The shared 5000-token budget comes from the
  spec's instruction-size recommendation, **not a host rejection limit**.
  `null` disables the advisory when none is established.
- `discoveryGlobs`: project installation guidance, not scan filters. `compat`
  scans every native skill under the input directory so misplaced files are
  not silently omitted. All four hosts require the exact `SKILL.md` filename;
  `*.skill.md` and case variants fail until renamed. Root placement is not
  gated: a standalone skill may be checked before installation. Personal,
  admin, plugin, and other configurable roots are outside these illustrative
  globs. OpenClaw's depth/stop rules are not simulated.
- `parseErrorSeverity`: malformed YAML fails strict contracts; Claude Code
  and OpenClaw document parser fallbacks, so malformed YAML warns there.
- `sources`, `notes`: provenance, scope, and uncertainty. Both JSON and text
  output preserve caveats. Source URLs are never fetched at runtime.

`pass` means no modeled violation, `warn` means advisory/uncertain portability,
and `fail` means a documented contract is violated. Exit code 1 means at least
one selected host fails; warnings alone exit 0. Unknown hosts, missing paths,
and paths with no skill files exit 2. Project lint configuration and plugins
cannot disable compatibility checks.

To update a profile, verify official host documentation, update its sources and
notes, and add boundary tests. Do not promote spec recommendations or observed
behavior on another product surface into hard host rejections.
