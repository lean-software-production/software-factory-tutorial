# V2 Live Evaluator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the legacy evaluator with live, model-backed evaluation of a dedicated v2 workbook.

**Architecture:** A disposable Markdown-manifest test workbook is served by the real v2 workbook
server. An HTTP/WebSocket driver performs scripted learner actions and records public state,
terminal transcripts, reflection exchanges, and artifacts. Deterministic protocol gates run before
a second real model judges scenario-specific tutor-quality criteria.

**Tech Stack:** TypeScript, Vitest, v2 workbook server, HTTP, WebSocket, Pi, existing evaluator
judge/report utilities.

**Spec:** `docs/superpowers/specs/2026-08-20-v2-live-evaluator-design.md`

## Global Constraints

- The evaluator never loads or mutates the authored curriculum.
- Live evaluation uses real tutor and judge models; only deterministic unit tests use fakes.
- `npm run eval` is the model-costing live command; root `npm run check` remains deterministic.
- Public-state assertions must prove private `tutor` guidance is never exposed.
- Delete legacy v1 evaluator dependencies rather than supporting both protocols.

---

### Task 1: Create the isolated evaluation workbook

**Files:**
- Create: `evals/workbook/workbook.md`
- Create: `evals/workbook/lessons/01-evaluator/part.md`
- Create: `evals/workbook/lessons/01-evaluator/01-live-session/lesson.md`
- Create: `evals/workbook/lessons/01-evaluator/01-live-session/blocks/*.md`
- Test: `evals/test/workbook-fixture.test.ts`

- [ ] Write a failing test that copies the fixture to a temporary directory and calls
  `loadWorkbook()`; assert its block order, H1/H2 titles, command block, clue-only block, reflection,
  and transition.
- [ ] Run the test and confirm the missing fixture fails.
- [ ] Author the fixture with narrative, exact-command terminal practice, clue-only terminal practice,
  reflection, and transition blocks. Use disposable `.tmp` files only.
- [ ] Re-run the test and commit `evals: add v2 live-evaluation workbook`.

### Task 2: Build the v2 session recorder

**Files:**
- Create: `evals/v2/session.ts`
- Create: `evals/v2/workspace.ts`
- Create: `evals/v2/types.ts`
- Test: `evals/test/v2-session.test.ts`

- [ ] Write failing tests for `createEvaluationWorkspace()` and `recordPublicState()`.
- [ ] Implement a temporary fixture copy, server startup, public-state recorder, and artifact snapshot.
- [ ] Add a `V2SessionTrace` containing scenario ID, public states, terminal transcript, reflections,
  events, and artifacts. Do not include private tutor guidance.
- [ ] Run focused tests and commit `evals: record v2 workbook sessions`.

### Task 3: Drive HTTP and terminal WebSocket actions

**Files:**
- Create: `evals/v2/driver.ts`
- Modify: `evals/v2/session.ts`
- Test: `evals/test/v2-driver.test.ts`

- [ ] Write failing tests for Continue, reflection submission, terminal command submission, and
  rejection of private tutor fields in API responses.
- [ ] Implement an HTTP client for workbook state/actions and a WebSocket terminal client that records
  output until an observer/completion state arrives.
- [ ] Run the driver against the real workbook server in test mode with deterministic adapters.
- [ ] Commit `evals: drive v2 workbook sessions`.

### Task 4: Add live scenarios and model judgement

**Files:**
- Create: `evals/v2/scenarios.ts`
- Create: `evals/v2/judge.ts`
- Modify: `evals/run.ts`
- Test: `evals/test/v2-scenarios.test.ts`

- [ ] Write failing deterministic tests for scenario gates: exact command success, unexpected output,
  clue-only task, reflection follow-up, and transition completion.
- [ ] Implement scenario declarations and deterministic gates over `V2SessionTrace`.
- [ ] Adapt the existing judge invocation/report format to send only trace plus scenario criteria to a
  real judge model after gates pass.
- [ ] Make `evals/run.ts` select v2 scenarios and write reports with model identities, trace, judge
  result, and artifact snapshot.
- [ ] Commit `evals: run live v2 tutor scenarios`.

### Task 5: Replace legacy scripts and evaluator tests

**Files:**
- Modify: `package.json`
- Modify: `evals/tsconfig.json`
- Delete: legacy `evals/harness/*`, `evals/scenarios/lesson-*`, and v1-only evaluator tests
- Create/Modify: v2 evaluator unit tests

- [ ] Write a failing package-script test that asserts `check:eval`, `test:eval`, and `eval` target
  the v2 evaluator and that root `check` remains model-free.
- [ ] Remove legacy imports and source files after v2 coverage is present.
- [ ] Update scripts so `eval` builds `tutorial-engine` then runs the live v2 evaluator.
- [ ] Run `npm run check:eval`, `npm run test:eval`, root `npm run check`, and commit
  `evals: replace legacy evaluator`.

### Task 6: Verify the live path

**Files:**
- Modify: `evals/README.md`
- Test: `evals/test/live-eval-regressions.test.ts`

- [ ] Update README with authentication/model prerequisites, explicit cost warning, scenario selection,
  and report locations.
- [ ] Run deterministic root checks, tutorial-engine checks/build, and one selected live scenario.
- [ ] Inspect its report to confirm no private tutor guidance appears in public trace and the judge
  received the recorded learner session.
- [ ] Commit `docs: document v2 live evaluator`.
