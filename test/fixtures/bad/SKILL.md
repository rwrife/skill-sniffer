---
name: bad-skill
description: "unterminated string
tools: [exec, read
  nested: : broken
---

# Bad Frontmatter

The YAML block above is malformed on purpose. Parsing must not throw; the
body should still be recoverable for later scanning.
