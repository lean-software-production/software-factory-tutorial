---
type: narrative
---

## Advanced: substitute another validator

Pi is the default validator, but Claude Code or Codex may take this role when configured for
non-interactive, read-only work with permission to run the checks. Its access must differ from the
doer's: it may inspect the calculator and run validation commands, but it must not edit files. Do
not assume another CLI's default sandbox or permission model provides that boundary.
