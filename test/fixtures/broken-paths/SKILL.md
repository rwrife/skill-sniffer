---
name: broken-paths-skill
description: References one real sibling file and one missing one to exercise the broken-path rule.
---

# Broken Paths Skill

This skill ships a helper script. Run [the helper](./helper.sh) to set things up.

It also points at a missing companion: see [setup notes](./docs/setup.md) for details,
and run `./scripts/missing-tool.sh` before you start.

External links like [the homepage](https://example.com) and anchors like
[this section](#broken-paths-skill) must never be flagged — they aren't local paths.

A normal command in code such as `npm test` is prose, not a path, and stays quiet too.
