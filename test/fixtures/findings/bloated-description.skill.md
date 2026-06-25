---
name: bloated-description-skill
description: This description is deliberately, exhaustively, almost comically long so that it sails well past the two-hundred character budget the frontmatter rule enforces, because every one of these characters becomes context tokens an agent has to read every single time it loads the skill, which is exactly the kind of quiet bloat skill-sniffer exists to growl at.
---

# Bloated Description

The frontmatter is valid but the `description` is way over budget, so the
rule should emit a single warning (not an error).
