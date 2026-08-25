# Live editor practice implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add live, reviewer-gated embedded editing to the workbook and use it for Lesson 002.

**Architecture:** An editor-practice block owns one workspace-relative target file and a private
review brief. The browser sends debounced draft revisions to a server-owned draft store. A narrowly
tooled Pi reviewer can either return focused feedback or call an unlock tool for its current revision;
the server validates that unlock, promotes the draft, records progression, and exposes only public
status and feedback to the browser.

**Tech Stack:** TypeScript, Node.js, React 19, CodeMirror 6, Vite, Vitest, Pi SDK, YAML manifests.

**Spec:** `docs/superpowers/specs/2026-08-20-editor-practice-design.md`

## Global Constraints

- Implement only reusable editor-practice support and Lesson 002; do not migrate later lessons.
- Use CodeMirror, not Monaco.
- An editor block owns exactly one declared, workspace-relative file.
- Keep drafts under `.tutorial/.tmp/workbook/drafts/`; write the real target only after a valid unlock.
- The reviewer receives the private brief and current draft only; it has no shell or file tools.
- The only reviewer progression capability is `unlock_editor_practice(revisionId)`.
- Reject absolute, traversal, `.git`, `.tutorial`, `.tmp`, and outside-workspace targets.
- Keep private tutor briefs out of all public API state, evaluator traces, and browser rendering.
- Debounce typing before review, retain only the newest pending revision, and reject stale unlocks.
- Extend deterministic tests and the isolated live evaluator fixture and scenarios.

---

## File structure

| File | Responsibility |
| --- | --- |
| `tutorial-engine/src/workbook/contract.ts` | Add the editor-practice discriminated union and strict front-matter validation. |
| `tutorial-engine/src/workbook/editor.ts` | Own safe target resolution, durable drafts, reviewer adapter/tool session, and revision state. |
| `tutorial-engine/src/workbook/events.ts` | Record editor unlock facts and derive editor completion/status. |
| `tutorial-engine/src/workbook/server.ts` | Expose draft state/update API, serialize latest-review work, validate and apply reviewer unlocks. |
| `tutorial-engine/web-workbook/src/workbook-ui.tsx` | Render the new block and a CodeMirror draft editor with debounced updates. |
| `tutorial-engine/web-workbook/src/styles.css` | Style the editor and its compact live status/feedback states. |
| `lessons/01-the-validation-loop/02-build-a-doer/*` | Split Lesson 002 into two editor blocks and two terminal blocks. |
| `evals/workbook/*`, `evals/v2/*` | Add evaluator fixture/action/gates for feedback and successful editor promotion. |
| `tutorial-engine/test/workbook-*.test.*` | Cover contracts, events, API/reviewer boundary, and rendering. |

## Task 1: Add the editor-practice content contract

**Files:**
- Modify: `tutorial-engine/src/workbook/contract.ts`
- Modify: `tutorial-engine/src/workbook/load.ts`
- Test: `tutorial-engine/test/workbook-contract.test.ts`

**Interfaces:**
- Produces `EditorPracticeBlock extends WorkbookBlockBase` with `type: "editor-practice"`, `path`,
  and private `tutor`.
- Produces `BlockFrontMatter` with `path?: string`, valid only for editor-practice.

- [ ] **Step 1: Write failing contract tests.**

  Add fixture block data and expectations such as:

  ```ts
  expect(validateBlockFrontMatter(
    { type: "editor-practice", path: "factory/refactor.md", tutor: "Check one criterion." },
    "blocks/edit.md"
  )).toEqual({ type: "editor-practice", path: "factory/refactor.md", tutor: "Check one criterion." });
  expect(() => validateBlockFrontMatter(
    { type: "editor-practice", tutor: "Check it." }, "blocks/edit.md"
  )).toThrow(/path/);
  expect(() => validateBlockFrontMatter(
    { type: "narrative", path: "factory/x.md" }, "blocks/x.md"
  )).toThrow(/path/);
  ```

  Extend the synthetic loaded lesson to include an editor block and assert its ID, type, path,
  Markdown, and private tutor field.

- [ ] **Step 2: Run the focused test and confirm failure.**

  Run: `cd tutorial-engine && npm test -- workbook-contract.test.ts`

  Expected: FAIL because `editor-practice` is unsupported and `path` is unknown front matter.

- [ ] **Step 3: Implement strict contract and loader support.**

  Add `"editor-practice"` to `WorkbookBlockType` and `BLOCK_TYPES`; add it to
  `TUTOR_REQUIRED_TYPES`; introduce `EditorPracticeBlock`; require a non-empty `path` and `tutor`
  for this type; and reject `path` for every other type. `loadWorkbookBlock()` must create this
  union member rather than falling through to lesson-transition.

- [ ] **Step 4: Run focused tests.**

  Run: `cd tutorial-engine && npm test -- workbook-contract.test.ts`

  Expected: PASS with the existing manifest tests still rejecting unknown and type-inappropriate
  fields.

- [ ] **Step 5: Commit the contract.**

  ```bash
  git add tutorial-engine/src/workbook/contract.ts tutorial-engine/src/workbook/load.ts \
    tutorial-engine/test/workbook-contract.test.ts
  git commit -m "feat: define editor practice blocks"
  ```

## Task 2: Build draft storage and the bounded reviewer adapter

**Files:**
- Create: `tutorial-engine/src/workbook/editor.ts`
- Test: `tutorial-engine/test/workbook-editor.test.ts`

**Interfaces:**
- Produces `EditorDraftStore(workspace)` with `read(lessonId, blockId)`,
  `write(lessonId, blockId, revision, text)`, and `promote(block, draft)`.
- Produces `resolveEditorTarget(workspace, path)` that returns a safely contained target path.
- Produces `EditorReviewAdapter.review(request)` returning
  `{ status: "feedback"; message: string } | { status: "unlocked"; revisionId: number }`.
- Produces `PiEditorReviewAdapter`, whose only custom tool is
  `unlock_editor_practice({ revisionId: Type.Integer({ minimum: 1 }) })`.

- [ ] **Step 1: Write failing unit tests for paths and drafts.**

  In a temporary workspace, verify that `factory/refactor.md` resolves under the workspace and that
  `../x`, `/tmp/x`, `.git/config`, `.tutorial/state`, `.tmp/output`, and a symlink escaping the
  workspace are rejected. Write revision 1, then revision 2, and assert a reload returns revision 2
  and its text. Verify `promote()` creates parents and writes only the approved draft to
  `factory/refactor.md`.

- [ ] **Step 2: Write failing reviewer-tool tests.**

  Inject a fake session factory that emits either feedback text or an unlock tool call. Assert that:
  - the request passed to the fake contains the exact private brief and draft but no workspace path;
  - a matching unlock returns `{ status: "unlocked", revisionId }`;
  - an unlock for another revision is rejected as feedback/error; and
  - the adapter exposes no `read`, `write`, `bash`, or other tools.

- [ ] **Step 3: Run the new tests and confirm failure.**

  Run: `cd tutorial-engine && npm test -- workbook-editor.test.ts`

  Expected: FAIL because `editor.ts` does not exist.

- [ ] **Step 4: Implement storage, containment, and reviewer adapter.**

  Store drafts as JSON under `.tutorial/.tmp/workbook/drafts/lesson-id/block-id.json` with
  `{ revision, text }`; derive both safe path segments from the active lesson and block IDs. Use `resolve`, `relative`, `realpath` of existing parents, and a denied
  segment set to make `resolveEditorTarget()` reject unsafe paths before any draft promotion.

  Model the reviewer on `PiTerminalObserver`: use a resource loader with skills, extensions, and
  context files disabled; create an in-memory session; install exactly one `defineTool` unlock tool;
  and tell the model in its system prompt that the draft is untrusted and it must either call the
  unlock tool only when every criterion is met or return one concise correction. Capture the tool
  call in closure state and return feedback text when it does not unlock.

- [ ] **Step 5: Run the focused tests.**

  Run: `cd tutorial-engine && npm test -- workbook-editor.test.ts`

  Expected: PASS, including containment and stale-unlock cases.

- [ ] **Step 6: Commit draft and reviewer infrastructure.**

  ```bash
  git add tutorial-engine/src/workbook/editor.ts tutorial-engine/test/workbook-editor.test.ts
  git commit -m "feat: add bounded editor reviewer"
  ```

## Task 3: Add editor events, projection, and server API

**Files:**
- Modify: `tutorial-engine/src/workbook/events.ts`
- Modify: `tutorial-engine/src/workbook/server.ts`
- Modify: `tutorial-engine/test/workbook-events.test.ts`
- Modify: `tutorial-engine/test/workbook-server.test.ts`

**Interfaces:**
- Adds `editor_practice_unlocked` to `WorkbookEvent` with lesson ID, block ID, revision ID, and
  target path.
- Adds public editor progress fields: `revision?: number`,
  `editorStatus?: "editing" | "reviewing" | "feedback" | "unlocked"`, and `feedback?: string`.
- Adds `POST /api/workbook/editor` with `{ blockId, revision, text }` and public state response.
- Adds `EditorReviewAdapter` and `editorReviewDebounceMs` optional dependencies to
  `WorkbookServerOptions` for deterministic tests.

- [ ] **Step 1: Write failing projection tests.**

  Add an editor block before terminal practice to the fixture lesson. Assert that only an
  `editor_practice_unlocked` event for the active editor block completes it and makes the terminal
  block active. Assert a forged `block_completed` event and an unlock for an old revision do not
  complete it. Assert replay reconstructs the completed state after a new `WorkbookEventStore`.

- [ ] **Step 2: Write failing server tests.**

  Extend the server fixture with an editor block at `factory/answer.md` and inject a fake reviewer.
  Test these request sequences:
  - post revision 1 then revision 2 before review; only revision 2 is passed to the adapter;
  - feedback leaves the block active and returns public feedback without the private brief;
  - successful review promotes the exact revision to `factory/answer.md`, writes an unlock event,
    and advances to the next block;
  - a reviewer unlock for revision 1 after revision 2 exists is rejected and writes no target;
  - inactive-block submissions and unsafe declared paths return 409/400 without a promotion.

- [ ] **Step 3: Run focused tests and confirm failure.**

  Run: `cd tutorial-engine && npm test -- workbook-events.test.ts workbook-server.test.ts`

  Expected: FAIL because editor events and `/api/workbook/editor` are not implemented.

- [ ] **Step 4: Implement projection and API orchestration.**

  Make editor blocks complete only from `editor_practice_unlocked`. In `startWorkbookServer()`, load
  the active editor block only when it is active and ready. Accept a bounded text payload and a
  positive revision, persist it, publish `reviewing` state, and enqueue a single delayed review for
  the newest revision. On feedback, retain that revision and publish only its short message. On a
  valid unlock, re-check the active block and current stored revision, promote the draft through
  `EditorDraftStore`, append `editor_practice_unlocked`, and return refreshed public state. On
  exceptions, retain the draft, set a public retryable message, and retry the latest revision with a
  bounded delay. Never serialize `tutor` or the raw private reviewer request.

- [ ] **Step 5: Run focused tests.**

  Run: `cd tutorial-engine && npm test -- workbook-events.test.ts workbook-server.test.ts`

  Expected: PASS, including stale approval, private-state, and promotion assertions.

- [ ] **Step 6: Commit server progression.**

  ```bash
  git add tutorial-engine/src/workbook/events.ts tutorial-engine/src/workbook/server.ts \
    tutorial-engine/test/workbook-events.test.ts tutorial-engine/test/workbook-server.test.ts
  git commit -m "feat: review editor drafts before progression"
  ```

## Task 4: Render and debounce the embedded CodeMirror editor

**Files:**
- Modify: `tutorial-engine/package.json`
- Modify: `tutorial-engine/package-lock.json`
- Modify: `tutorial-engine/web-workbook/src/workbook-ui.tsx`
- Modify: `tutorial-engine/web-workbook/src/styles.css`
- Modify: `tutorial-engine/test/workbook-ui.test.tsx`

**Interfaces:**
- Adds CodeMirror packages `@codemirror/state`, `@codemirror/view`, and `@codemirror/commands`.
- Adds a typed `EditorPracticeBlock` to the public UI union with `path` and no `tutor` field.
- Adds `EditorPracticeBlockView`, which posts debounced revisions to `/api/workbook/editor`.

- [ ] **Step 1: Install dependencies and write failing UI tests.**

  Run from `tutorial-engine`:

  ```bash
  npm install @codemirror/state @codemirror/view @codemirror/commands
  ```

  Add a static-render test that supplies an active editor-practice block and expects its target path,
  an editor container, a visible editing/review status region, and no private tutor text. Add a
  client-render test with a mocked `fetch` and fake timers: change the editor text twice, advance the
  debounce, and assert one request carries the latest revision/text.

- [ ] **Step 2: Run the UI test and confirm failure.**

  Run: `cd tutorial-engine && npm test -- workbook-ui.test.tsx`

  Expected: FAIL because the UI does not recognize editor-practice.

- [ ] **Step 3: Implement the CodeMirror view.**

  Create a focused React component that creates an `EditorView` only for an active, incomplete
  editor block. Initialize it from public draft text/revision. Use an update listener and a 750 ms
  timeout to post `{ blockId, revision: current + 1, text }`; clean up the timer and editor view on
  unmount. Render the target path, an ARIA-live status, feedback, and an unlocked checkpoint. Do not
  render a Save or Review button. Wire `BlockView` to dispatch this type and extend the public state
  types without ever adding the private tutor field.

- [ ] **Step 4: Add styles.**

  Add scoped styles for `.editor-practice`, `.editor-target`, `.editor-surface`, and
  `.editor-status`. Reuse workbook paper, border, type, success, warning, and focus conventions;
  provide a visible focus outline and a useful narrow-screen layout.

- [ ] **Step 5: Run focused UI tests and build.**

  Run:

  ```bash
  cd tutorial-engine
  npm test -- workbook-ui.test.tsx
  npm run build:web:workbook
  ```

  Expected: PASS and a successful Vite workbook bundle.

- [ ] **Step 6: Commit the editor UI.**

  ```bash
  git add tutorial-engine/package.json tutorial-engine/package-lock.json \
    tutorial-engine/web-workbook/src/workbook-ui.tsx \
    tutorial-engine/web-workbook/src/styles.css tutorial-engine/test/workbook-ui.test.tsx
  git commit -m "feat: render live editor practice"
  ```

## Task 5: Migrate Lesson 002 into focused editing and terminal blocks

**Files:**
- Modify: `lessons/01-the-validation-loop/02-build-a-doer/lesson.md`
- Create: `lessons/01-the-validation-loop/02-build-a-doer/blocks/write-doer-prompt.md`
- Create: `lessons/01-the-validation-loop/02-build-a-doer/blocks/write-doer-harness.md`
- Create: `lessons/01-the-validation-loop/02-build-a-doer/blocks/run-doer.md`
- Create: `lessons/01-the-validation-loop/02-build-a-doer/blocks/check-the-doer.md`
- Delete: `lessons/01-the-validation-loop/02-build-a-doer/blocks/implementation-order.md`
- Modify: `tutorial-engine/test/workbook-contract.test.ts`

**Interfaces:**
- Produces lesson block order `key-concept`, `write-doer-prompt`, `write-doer-harness`, `run-doer`,
  `check-the-doer`, `alternatives-choose-another-doer`, `checks`, `pressure-test`.

- [ ] **Step 1: Write the failing migration assertion.**

  In the real-curriculum loader test, assert the new block ID order, editor paths
  `factory/refactor.md` and `factory/refactor-do.sh`, and that each editor brief is non-empty.

- [ ] **Step 2: Run the focused test and confirm failure.**

  Run: `cd tutorial-engine && npm test -- workbook-contract.test.ts`

  Expected: FAIL because the current lesson still contains `implementation-order`.

- [ ] **Step 3: Write the migrated blocks.**

  Keep the original vocabulary and exact harness behavior. The first editor body asks for the concise
  doer prompt; its private brief requires one behaviour-preserving refactoring, direct editing, no
  tests/npm/shell, and a concise response. The second body displays the complete Bash harness; its
  brief requires the baseline, phase announcements, calculator working directory, exact edit-tool
  list, and no bash.

  The run block supplies `chmod +x factory/refactor-do.sh` and `./factory/refactor-do.sh` as the
  terminal command. The check block supplies `git diff -- calculator`, `(cd calculator && npm test)`,
  and `(cd calculator && node scripts/quality.mjs)` as the independent evidence command. Preserve the
  original explanation that the doer must not run or interpret those checks.

- [ ] **Step 4: Run curriculum and type tests.**

  Run:

  ```bash
  cd tutorial-engine
  npm test -- workbook-contract.test.ts workbook-server.test.ts
  ```

  Expected: PASS with the real Lesson 002 fully loadable.

- [ ] **Step 5: Commit the lesson migration.**

  ```bash
  git add lessons/01-the-validation-loop/02-build-a-doer \
    tutorial-engine/test/workbook-contract.test.ts
  git commit -m "docs: teach lesson two through editor practice"
  ```

## Task 6: Extend the v2 live evaluator

**Files:**
- Modify: `evals/workbook/lessons/01-evaluator/01-live-session/lesson.md`
- Create: `evals/workbook/lessons/01-evaluator/01-live-session/blocks/editor-practice.md`
- Modify: `evals/v2/driver.ts`
- Modify: `evals/v2/scenarios.ts`
- Modify: `evals/v2/types.ts`
- Modify: `evals/v2/session.ts`
- Test: `evals/v2/*.test.ts` or the existing evaluator deterministic test file

**Interfaces:**
- Adds scenario action `{ type: "editor"; blockId: string; text: string }`.
- Adds driver method `submitEditorDraft(blockId, text)`.
- Adds trace entries for public editor status/feedback only; private briefs never enter a trace.

- [ ] **Step 1: Write failing evaluator fixture and gate tests.**

  Add editor-practice between orientation and the existing terminal blocks. Its target must be a
  disposable `editor-artifacts/evaluator-editor.txt` target, which the artifact snapshot explicitly
  includes alongside `.tmp/`. Add one scenario that submits an insufficient draft and asserts
  feedback with no unlock, and one that submits a satisfactory draft and asserts an unlock event
  plus the promoted artifact. Update later common action sequences to pass through the successful
  editor scenario.

- [ ] **Step 2: Run evaluator deterministic checks and confirm failure.**

  Run: `npm run test:eval`

  Expected: FAIL because the driver cannot submit editor drafts and the fixture/type is unsupported.

- [ ] **Step 3: Implement driver, trace, and gates.**

  Add the driver request to `/api/workbook/editor`, record each resulting public state, and keep
  private-field assertions applied to editor state just as they are for terminal and reflection
  state. Extend `DEFAULT_ARTIFACT_ROOTS` with `editor-artifacts` so promotion is visible in the
  trace. Gate success on the unlock event and artifact contents; gate feedback on an active editor
  block and a public feedback message. Do not add deterministic stale-path tests here; those belong
  to Task 3.

- [ ] **Step 4: Run deterministic evaluator checks.**

  Run: `npm run test:eval`

  Expected: PASS. Do not run `npm run eval` unless credentials are available and the user has
  explicitly accepted the model cost; it remains the manual live verification command.

- [ ] **Step 5: Commit evaluator support.**

  ```bash
  git add evals/workbook evals/v2
  git commit -m "evals: exercise editor practice review"
  ```

## Task 7: Verify the integrated workbook

**Files:**
- Modify only if verification reveals a concrete defect.

- [ ] **Step 1: Run the full deterministic project suite.**

  Run:

  ```bash
  cd tutorial-engine
  npm run check
  npm run build
  npm run browser:smoke
  cd ..
  npm run check:eval
  npm run test:eval
  ```

  Expected: all deterministic checks, type checks, and bundles pass. Preserve any failure output
  and fix only the demonstrated defect before rerunning the affected command and then this full set.

- [ ] **Step 2: Manually start the workbook.**

  Run: `cd tutorial-engine && npm run dev:workbook -- --target ..`

  Expected: Lesson 002 presents two embedded editors, offers live reviewer status without Save/Review
  buttons, unlocks the next block only after approved drafts, and later runs the promoted script in
  the embedded terminal.

- [ ] **Step 3: Preserve a green verification result.**

  Do not create a verification-only commit when every command is green. If a demonstrated defect
  required a fix, commit that fix in the task where it was made, before rerunning this full suite.
