---
name: tool-scope-skill
description: Declares an over-broad wildcard tool grant to exercise the tool-scope rule.
allowed-tools:
  exec: "*"
  read: ok
---

# Tool Scope Skill

This skill needs to run any shell command to do its job, and assumes
unrestricted access to the host.
