# 21. Preflight model-backed roles before workbook startup

Date: 2026-08-29

## Status

superseded

Superseded by [26. Use one stateless Main Tutor for practice review](0026-use-one-stateless-main-tutor-for-practice-review.md)

Complements [11. Use a terminal Practice Coach with Main Tutor authority](0011-use-a-terminal-practice-coach-with-main-tutor-authority.md) and [20. Bound terminal assessment retries with recoverable feedback](0020-bound-terminal-assessment-retries-with-recoverable-feedback.md).

## Context

The workbook uses two model-backed roles during ordinary interaction: the Main Tutor and the terminal Practice Coach. A launch could previously create a session, print successful startup lines, start the HTTP server, and open the browser before either role made its first provider call. If a configured model had expired credentials, no quota, or a usage-limit error, the learner discovered the problem only after the browser was already running and a later action needed that role.

Model calls cost time and money, so the gate must happen after authored content and session resolution have succeeded. That order means invalid content, an invalid session id, or a bad lesson jump fails before paid calls. It also means model failure prints no launch lines: the session may have been resolved or created, but the workbook has not started.

ADRs 0011 and 0020 define the runtime roles and bounded terminal-assessment retry policy. This decision adds a startup check; it does not change runtime authority or terminal assessment recovery.

## Decision

Before the CLI prints launch lines, starts `startWorkbookServer`, opens a browser, or installs signal handlers, it preflights both configured model-backed roles:

- Main Tutor, resolved with `TUTOR_MODEL` through the existing tutor model policy.
- Practice Coach, resolved with `PRACTICE_COACH_MODEL` through the existing practice-coach model policy.

The probes start concurrently and are awaited with a success barrier. Normal success latency is the slower model call, not the sum of both calls. The barrier is fail-fast: the first known role failure rejects startup immediately, without waiting for the sibling role. The underlying Pi provider calls are not cancellable, so the sibling may continue after the CLI has rejected; the coordinator still observes its eventual settlement. Identical configured provider/model identities are not deduplicated because each role has its own startup contract and diagnostics.

Each probe creates a bare, disposable Pi session with no tools, extensions, skills, prompt templates, themes, context files, compaction, or Pi agent retry. It uses in-memory state, sends only a minimal no-secret connectivity prompt, requires a genuine non-empty assistant completion, records the actual selected `session.state.model` when available, and disposes the session in all cases. The workbook uses one wrapper attempt for preflight; lower-level provider behavior inside that one prompt is the Pi adapter boundary.

Failures are reported as role-specific startup errors that name the role, environment variable, requested model when known, selected model when known, and original provider reason such as a usage-limit message.

Low-level server APIs remain unprobed. Direct calls to `startWorkbookServer` are still available for fixtures, tests, and evaluations that intentionally supply fake tutors or control model startup separately.

## Consequences

Learners fail fast before browser startup when either configured model-backed role is unusable, and the error names the failing role/model rather than surfacing later as a stalled workbook action.

A normal launch now performs two small provider calls before listening. That adds the cost and latency of the slower startup probe. Since session resolution precedes the gate, authored/session validation still happens before those paid calls, and model failure does not print successful launch lines.

The CLI gate protects ordinary workbook launches. It does not make deterministic terminal validators, alter runtime retry policy, or require every test/evaluation fixture that bypasses the CLI to call real models.
