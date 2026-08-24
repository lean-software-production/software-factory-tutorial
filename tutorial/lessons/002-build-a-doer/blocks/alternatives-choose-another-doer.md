---
type: narrative
---

## Alternatives: choose another doer

Pi is the default doer, but the boundary is not tied to Pi. Claude Code and Codex can also act as
the doer when configured for non-interactive use. Read the same prompt, run the chosen CLI from
`calculator/`, and give it only the access you intend. From the session workspace, for example:

```sh
prompt=$(<factory/refactor.md)
(cd calculator && claude -p "$prompt")
(cd calculator && codex exec "$prompt")
```

These commands illustrate the shape of the substitution, not a shared security model. Each CLI has
different authentication, sandbox, and tool-permission options. Configure it so the doer can inspect
and edit the calculator but cannot check its own work or reach unrelated files.
