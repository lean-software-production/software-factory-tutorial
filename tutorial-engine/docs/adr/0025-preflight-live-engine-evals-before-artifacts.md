# 25. Preflight live engine evals before artifacts

Date: 2026-08-29

## Status

accepted

Complements [21. Preflight model-backed roles before workbook startup](0021-preflight-model-backed-roles-before-workbook-startup.md).

## Context

Live engine evals spend model tokens, start Docker-backed terminal containers, create disposable workspaces, and write ignored report artifacts. Before this decision, some setup failures could appear only after report directories or evaluation workspaces existed.

The eval runner also has two kinds of failures that must stay cheap and model-free: help/argument handling and explicit scope confirmation. Those must run before any external probe.

## Decision

The live v2 eval CLI now has a fail-fast preflight barrier before it creates `evals/reports/`, creates evaluation workspaces, starts a workbook server, or drives scenario sessions.

The order is fixed:

1. Parse scope and enforce `--all --yes` confirmation.
2. Require explicit `EVAL_JUDGE_MODEL`.
3. Refuse `PRACTICE_COACH_LOG_PROMPT=1` because Practice Coach prompts contain private rubric/evidence text.
4. Copy and load the disposable evaluator workbook fixture.
5. Check Docker CLI/daemon access, canonical workbook terminal image availability, disposable terminal-container start, the same in-container Pi authentication probe used by the production workbook terminal, and bounded cleanup. Docker argv contains only `--env OPENCODE_API_KEY`; the key value is supplied through a minimal Docker-client child environment rather than inherited wholesale from the parent process.
6. Preflight Main Tutor and Practice Coach models using the workbook startup preflight convention: disposable no-tools Pi sessions, minimal connectivity prompt, non-empty completion, bounded prompt wait, disposal in all cases, and recorded model identities only.
7. Preflight the judge command/model with a minimal JSON connectivity check. Judge prompts and stdout are byte-bounded, and the child process has a bounded lifetime.

External probes and Docker command execution are injectable so unit tests can verify order, timeout values, and side effects without spending tokens or requiring Docker. The actual CLI/preflight/paid run/metadata path reads `process.env`; explicit environment injection is retained only on pure configuration helpers and low-level probe APIs.

## Consequences

Configuration, fixture, Docker, role-model, and judge-model failures stop the live eval before report artifacts appear. Help and argument failures remain model-free.

Preflight diagnostics expose model identities, fixed structural judge command labels (`default-pi` or `configured-command`), and coarse capabilities, not credentials, prompt bodies, response bodies, raw Docker/model/judge command causes, command paths/arguments, or disposable absolute paths. If an attempted container start or Pi-auth preflight leaves cleanup unconfirmed, preflight fails with a fixed startup/auth cleanup error instead of reporting success while a credential-bearing container might still be alive. The per-run report lifecycle remains owned by the existing eval runner after preflight succeeds.
