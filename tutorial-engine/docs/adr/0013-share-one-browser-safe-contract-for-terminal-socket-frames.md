# 13. Share one browser-safe contract for terminal socket frames

Date: 2026-08-28

## Status

accepted

## Context

`public-contract.ts` guards the HTTP boundary: the browser parses every response through it before
rendering. The terminal WebSocket had no equivalent. `EmbeddedTerminal` called `JSON.parse` on each
frame with no `try`/`catch`, read the result as `any`, and passed a `verified-complete` frame's
`state` straight to React — the one path where server data reached component state without being
validated. A single malformed frame threw inside the listener and the terminal stopped updating for
the rest of the session.

Because no declaration was shared, the two ends drifted. Commit `f55dcf1` renamed `observer-status`
and `observer-error` to `attempt-status` and `attempt-error` and deleted `advice` and
`verified-complete` outright. The browser still had branches for all four. So did the v2 eval
driver, which silently recorded nothing for them — measured afterwards, it captured 3 of the 7
non-output frames the server actually sends.

## Decision

Declare the frames in `src/workbook/public-terminal-contract.ts`: a discriminated union
`PublicTerminalFrame`, a narrowing `parsePublicTerminalMessage`, and a serialiser
`publicTerminalFrame` that the server's send sites go through.

It is a sibling of `public-contract.ts` rather than an addition to it. That module is scoped to the
HTTP API; the socket is a different surface with a different lifetime. Like it, this module has no
Node imports, so the server that sends a frame and the browser that narrows one read the same
declaration.

`parsePublicTerminalMessage` throws on unreadable JSON, which the caller reports through the
existing error channel and keeps reading; it returns `undefined` for a well-formed frame this build
has no branch for, so an unknown type is skipped rather than ending the browser's reading of the
socket. `verified-complete` carries `state: unknown`, which forces its branch to run
`parsePublicWorkbookState` rather than trust the frame.

Frames no server code sends are named apart, as `PublicTerminalLegacyFrame`. `publicTerminalFrame`
accepts only the live union, so the server cannot send a dead frame even by accident.

## Consequences

A rename is now a type error at every send site and in both consumers, instead of silence. This was
verified rather than assumed: renaming `attempt-status` in the contract produces three distinct
errors in the eval driver alone.

The eval driver records all seven frames, so a trace is evidence rather than a partial picture that
looks complete. Its leak check still runs over the raw parsed object, not the narrowed frame, so an
unknown type cannot carry tutor guidance past it.

The legacy union is a deliberate holding position, not a permanent one. Removing those two branches
from the browser means deleting the `onAdvice` and `refresh` props they feed, which is a wider change
than the one this decision covers.
