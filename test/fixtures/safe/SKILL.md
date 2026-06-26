---
name: safe-docs-skill
description: Documentation that talks about secrets and prompts without leaking or baiting.
---

# Safe Docs Skill

This skill explains how to configure credentials safely.

Set your provider key as an environment variable, e.g. `export API_KEY=your-api-key-here`.
Never hardcode a value like `sk-xxxxxxxxxxxxxxxxxxxxxx`; the example `AKIAIOSFODNN7EXAMPLE`
from the AWS docs is a placeholder, not a real key.

When writing instructions, be explicit and previous steps should build on each other.
This sentence mentions "instructions" and "system" without telling any agent to ignore them.

<!-- Note for maintainers: keep this fixture clean. -->
