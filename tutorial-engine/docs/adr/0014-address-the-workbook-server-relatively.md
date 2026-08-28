# 14. Address the workbook server relatively

Date: 2026-08-28

## Status

accepted

## Context

The server is built to be mounted under a path prefix. `isRoute` matches
`pathname === "/api/workbook/<route>"` or any path ending in it, `isTerminalRoute` does the same for
the socket, `assetPaths` walks path segments, and `vite.config.ts` sets `base: "./"` so the bundle
loads its assets relatively.

The client did not hold up its end. Of seven request paths, three were relative and four were
absolute, and the terminal socket was built from `location.host` plus an absolute path. Under a
prefix the four fetches and the socket would miss the mount while the other three worked — a split
failure that no test covered, because every test served the workbook from the root.

The wrappers had also drifted apart in a second way. Six near-identical functions each repeated the
method, the JSON headers and the `response.ok` check, and one of them, `postTutorMessage`, returned
`response.json()` typed as `PublicWorkbookState` without validating it. A malformed response
therefore surfaced as a crash inside React's render rather than a rejected request.

## Decision

Address the server relatively, everywhere, and decide the base in one place.

HTTP requests go through a single `request(path, init, parse)` helper that owns the `api/workbook/`
prefix, so the route name is the argument and a new call site cannot reintroduce a leading slash. A
body selects a JSON POST; no body selects a GET. Every response is parsed through
`public-contract.ts`; no function returns `response.json()` typed as a contract type.

The terminal socket derives its address the same way, from `new URL("api/workbook/terminal",
document.baseURI)` with the scheme swapped to `ws:`/`wss:`.

## Consequences

The workbook can be served under a path prefix without a client change, which is what the server was
already written for.

Two tests hold the property rather than leaving it to review: one asserts every request path is
relative, the other mounts the app under a `<base href>` differing from the harness page in scheme,
host and path at once, so it fails on any component of an address rebuilt from `location`.

Validation is now uniform, so a bad payload fails at the boundary with a rejected request instead of
inside a render. The cost is one indirection between a call site and `fetch`, which is the price of
having the base and the parse decided once.

Server-side clients that dial a known root origin — the server's own tests, and the eval driver —
correctly keep absolute addresses. This decision governs the browser client only.
