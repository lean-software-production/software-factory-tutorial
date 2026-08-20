---
type: narrative
---

## Advanced: a boundary that inspects rather than removes

Pi extensions can intercept a tool call and refuse it — `examples/extensions/confirm-destructive.ts`
in the Pi package is this shape. That would let the validator keep `bash` while a hook rejected
anything that modifies a file.

It is more machinery for a weaker guarantee. A boundary enforced by removing a capability is one you
can verify by reading the command line; a boundary enforced by inspecting each use of a capability
is
only as good as the inspector. Prefer taking the tool away.
