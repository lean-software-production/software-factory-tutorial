# Unified Workbook Attempts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give editor, terminal, and reflection work one immutable attempt lifecycle, evaluated by one long-running restricted tutor session, with accepted-work checkpoints and celebration.

**Architecture:** The server persists immutable learner-evidence attempts and exposes only a public checkpoint projection. One server-owned Pi session serializes all reviews and compaction. Its only capability is a no-argument `accept_current_attempt()` tool whose invocation is bound internally to the reviewed attempt. Accepted work stays active and read-only until the learner continues.

**Tech Stack:** TypeScript, Node HTTP/WebSocket server, Pi coding-agent SDK, React 19, CodeMirror, xterm, Vitest, JSDOM.

**Spec:** `docs/superpowers/specs/2026-08-20-unified-workbook-attempts-design.md`

## Global Constraints

- Preserve durable learner state under `.tutorial/.tmp/`; never write it into curriculum files.
- Keep tutor guidance, attempt IDs, paths, versions, and superseded state out of public API/UI state.
- The workbook tutor exposes no filesystem, shell, network, workspace, built-in, extension, skill, context-file, or prompt-template capability.
- The only tutor tool is `accept_current_attempt()` with no parameters; the server binds it to one current attempt.
- A tutor decision may accept only the evidence snapshot it reviewed; newer evidence supersedes in-flight work.
- Accepted evaluated work shows a success checkpoint and requires the learner to Continue; narrative and lesson-transition Continue behavior remains unchanged.
- Confetti is decorative, `aria-hidden`, pointer-inert, one second long, and omitted for reduced motion.
- Run ADRgen from the devcontainer when an ADR status changes.

---

## File structure

| File | Responsibility |
| --- | --- |
| `tutorial-engine/src/workbook/attempts.ts` | Immutable attempt types, filesystem store, public checkpoint conversion, and current-attempt compare-and-swap operations. |
| `tutorial-engine/src/workbook/tutor.ts` | One restricted, serialized Pi session that reviews an attempt and compacts after continuation. |
| `tutorial-engine/src/workbook/events.ts` | Durable `attempt_accepted`/generic Continue events and compatibility projection of legacy events. |
| `tutorial-engine/src/workbook/editor.ts` | Safe target resolution and promotion of an accepted editor attempt only. |
| `tutorial-engine/src/workbook/terminal.ts` | Isolated terminal capture; delegates debounced transcript evaluation to the common attempt submission callback. |
| `tutorial-engine/src/workbook/reflection.ts` | Reflection conversation data helpers, with no independent model session. |
| `tutorial-engine/src/workbook/server.ts` | Attempt submission, tutor orchestration, generic accepted checkpoint Continue route, and restart recovery. |
| `tutorial-engine/web-workbook/src/workbook-ui.tsx` | Shared accepted checkpoint and one-shot confetti trigger. |
| `tutorial-engine/web-workbook/src/styles.css` | Pointer-inert one-second confetti animation and reduced-motion rule. |

## Task 1: Persist immutable attempts

**Files:**
- Create: `tutorial-engine/src/workbook/attempts.ts`
- Create: `tutorial-engine/test/workbook-attempts.test.ts`

**Interfaces:**

```ts
export type AttemptKind = "editor" | "terminal" | "reflection";
export type AttemptStatus = "working" | "reviewing" | "feedback" | "accepted" | "superseded";
export type AttemptEvidence =
  | { kind: "editor"; text: string }
  | { kind: "terminal"; transcript: string; terminalHtml: string }
  | { kind: "reflection"; response: string; conversation: ReflectionTurn[] };
export type Attempt = {
  id: string; lessonId: string; blockId: string; version: number;
  evidence: AttemptEvidence; status: AttemptStatus; feedback?: string; successMessage?: string;
};
export class AttemptStore {
  create(input: Omit<Attempt, "id" | "version" | "status">): Promise<Attempt>;
  current(lessonId: string, blockId: string): Promise<Attempt | undefined>;
  markReviewing(id: string): Promise<Attempt | undefined>;
  markFeedback(id: string, message: string): Promise<Attempt | undefined>;
  acceptCurrent(id: string, successMessage: string): Promise<Attempt | undefined>;
}
```

- [ ] **Step 1: Write failing attempt-store tests**

Create tests that make two editor attempts for one block and assert: versions are `1` then `2`; their
payloads remain distinct; the first becomes `superseded`; `acceptCurrent(first.id, "Nice")` returns
`undefined`; and `acceptCurrent(second.id, "Nice")` returns an accepted attempt. Add terminal and
reflection fixtures that round-trip their evidence without exposing private state.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run --workspace=tutorial-engine test -- workbook-attempts.test.ts`

Expected: FAIL because `attempts.ts` does not exist.

- [ ] **Step 3: Implement the minimal filesystem store**

Store immutable JSON records at
`.tutorial/.tmp/workbook/attempts/<encoded-lesson>/<encoded-block>/<version>-<uuid>.json` and one
`current.json` pointer per block. Validate IDs, versions, evidence sizes, and status transitions. Write a
new attempt record before atomically replacing the current pointer. On creation, rewrite only the previous
record's status to `superseded`; never change its evidence.

- [ ] **Step 4: Run focused tests**

Run: `npm run --workspace=tutorial-engine test -- workbook-attempts.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```sh
git add tutorial-engine/src/workbook/attempts.ts tutorial-engine/test/workbook-attempts.test.ts
git commit -m "feat: persist workbook attempts"
```

## Task 2: Project common attempt checkpoints

**Files:**
- Modify: `tutorial-engine/src/workbook/events.ts`
- Modify: `tutorial-engine/test/workbook-events.test.ts`

**Interfaces:**

```ts
type WorkbookEvent =
  | { type: "attempt_accepted"; at: string; lessonId: string; blockId: string;
      attemptId: string; version: number; kind: AttemptKind; summary: string }
  | { type: "block_continued"; at: string; lessonId: string; blockId: string };
type BlockProgress = { checkpoint?: { status: "accepted"; summary: string; kind: AttemptKind }; ... };
```

- [ ] **Step 1: Write failing projection tests**

Add a test that an `attempt_accepted` event on the active evaluated block leaves it active, exposes an
accepted checkpoint, and does not emerge the next block. Add `block_continued` and assert the next block
becomes active. Add stale/early acceptance events and assert they do not complete later blocks. Preserve
existing historical-event tests and add fixtures for legacy editor unlock, verified terminal completion,
and reflection completion so old event logs still project completed history.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run --workspace=tutorial-engine test -- workbook-events.test.ts`

Expected: FAIL because the projector does not understand `attempt_accepted`.

- [ ] **Step 3: Implement event and projection migration**

Add `attempt_accepted`. Let `block_continued` complete an accepted evaluated block as well as existing
narrative/transition blocks. Project an evaluated accepted checkpoint without exposing attempt IDs or
versions. Continue to recognize the old editor, terminal, and reflection completion event sequences as
completed history; do not rewrite `events.jsonl`.

- [ ] **Step 4: Run focused tests**

Run: `npm run --workspace=tutorial-engine test -- workbook-events.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```sh
git add tutorial-engine/src/workbook/events.ts tutorial-engine/test/workbook-events.test.ts
git commit -m "feat: project accepted workbook attempts"
```

## Task 3: Build the restricted long-running tutor

**Files:**
- Create: `tutorial-engine/src/workbook/tutor.ts`
- Create: `tutorial-engine/test/workbook-tutor.test.ts`

**Interfaces:**

```ts
export type TutorReview = { attempt: Attempt; privateGuidance: string };
export type TutorDecision = { accepted: boolean; feedback: string };
export interface WorkbookTutor {
  review(input: TutorReview): Promise<TutorDecision>;
  compactAfterBlock(): Promise<void>;
  dispose(): void;
}
```

- [ ] **Step 1: Write failing tutor tests**

Use a fake session factory. Assert it creates one session for two reviews, exposes exactly
`["accept_current_attempt"]` in the Pi allowlist, and defines a no-parameter tool. Assert a real tool call
sets `accepted: true`, while literal `<function_calls>` text does not. Queue a review, compaction, and a
second review; assert their prompt order is review, compaction, review. Assert a compaction rejection is
logged and does not reject the later review.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run --workspace=tutorial-engine test -- workbook-tutor.test.ts`

Expected: FAIL because `tutor.ts` does not exist.

- [ ] **Step 3: Implement the session owner**

Create a restricted Pi resource loader and one `AgentSession` with automatic compaction disabled. Define
`accept_current_attempt()` with `Type.Object({}, { additionalProperties: false })`; closure state makes it
valid only during the queued review turn. Make a promise-tail queue serialize `review` and
`compactAfterBlock`. Prompt with the private rubric and a labelled untrusted attempt. Return public text as
feedback, with a neutral fallback if text is empty. Call `session.compact()` with the factual-summary
instruction after continuation.

- [ ] **Step 4: Run focused tests**

Run: `npm run --workspace=tutorial-engine test -- workbook-tutor.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```sh
git add tutorial-engine/src/workbook/tutor.ts tutorial-engine/test/workbook-tutor.test.ts
git commit -m "feat: add restricted workbook tutor session"
```

## Task 4: Route editor, terminal, and reflection evidence into attempts

**Files:**
- Modify: `tutorial-engine/src/workbook/editor.ts`
- Modify: `tutorial-engine/src/workbook/terminal.ts`
- Modify: `tutorial-engine/src/workbook/reflection.ts`
- Modify: `tutorial-engine/test/workbook-editor.test.ts`
- Modify: `tutorial-engine/test/workbook-terminal.test.ts`
- Modify: `tutorial-engine/test/workbook-reflection.test.ts`

**Interfaces:**

```ts
export type SubmitAttempt = (input: {
  lessonId: string; blockId: string; evidence: AttemptEvidence; privateGuidance: string;
}) => Promise<void>;
```

- [ ] **Step 1: Write failing source-adapter tests**

Replace editor-review tests with a test that only an accepted current editor attempt is promoted and that a
superseded attempt cannot write its target. Replace terminal-observer tests with a test that a paused,
bounded transcript and frozen HTML are submitted as terminal evidence. Add reflection tests that each
learner message submits response plus existing conversation evidence and receives tutor feedback as the
next conversation turn.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run --workspace=tutorial-engine test -- workbook-editor.test.ts workbook-terminal.test.ts workbook-reflection.test.ts`

Expected: FAIL because the source adapters still use type-specific model adapters.

- [ ] **Step 3: Implement source adapters**

Keep `resolveEditorTarget()` unchanged. Replace draft storage/reviewer logic with attempt evidence and
promote only `AttemptEvidence.kind === "editor"` from an accepted current attempt. Change terminal
manager's debounced observer callback to submit its bounded transcript and frozen HTML. Remove
`PiTerminalObserver` and `PiReflectionConversationAdapter`; retain reflection turn/evidence types and let
the server append the tutor's returned feedback.

- [ ] **Step 4: Run focused tests**

Run: `npm run --workspace=tutorial-engine test -- workbook-editor.test.ts workbook-terminal.test.ts workbook-reflection.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```sh
git add tutorial-engine/src/workbook/editor.ts tutorial-engine/src/workbook/terminal.ts \
  tutorial-engine/src/workbook/reflection.ts tutorial-engine/test/workbook-editor.test.ts \
  tutorial-engine/test/workbook-terminal.test.ts tutorial-engine/test/workbook-reflection.test.ts
git commit -m "feat: submit all workbook evidence as attempts"
```

## Task 5: Orchestrate attempts and tutor decisions in the server

**Files:**
- Modify: `tutorial-engine/src/workbook/server.ts`
- Modify: `tutorial-engine/test/workbook-server.test.ts`
- Modify: `tutorial-engine/test/browser-smoke.mts`

**Interfaces:**

```ts
async function submitAttempt(input: {
  lessonId: string; blockId: string; evidence: AttemptEvidence; privateGuidance: string;
}): Promise<Attempt>;
async function continueAcceptedBlock(lessonId: string, blockId: string): Promise<PublicState>;
```

- [ ] **Step 1: Write failing server tests**

Add tests that editor POST, terminal callback, and reflection submit all create `reviewing` common
attempt state; private guidance is absent from returned state; accepted state remains active until generic
`continue`; unaccepted and inactive Continue requests return 409; a newer attempt makes an earlier tutor
acceptance harmless; and a restarted server reloads and requeues the active unaccepted attempt. Test that
accepted editor evidence promotes only after the tutor accepts it and that tutor review failures present a
neutral retry state.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run --workspace=tutorial-engine test -- workbook-server.test.ts`

Expected: FAIL because server state still contains editor overlays and type-specific completion routes.

- [ ] **Step 3: Refactor server orchestration**

Instantiate one `AttemptStore` and one `WorkbookTutor` per server. Replace editor progress maps, editor
review locks, reflection queue, and adapter-specific options with a common submission lock. Ensure each
submission marks an attempt reviewing, queues tutor review, checks current-active state after its turn,
then either stores feedback or appends `attempt_accepted`. Promote accepted editor evidence before the
acceptance event. Continue only accepted current evaluated blocks, append `block_continued`, return the
updated state, and queue tutor compaction without blocking the response. On close, clear timers and dispose
the tutor session. Derive public checkpoint state from the current attempt and event projection only.

- [ ] **Step 4: Run focused tests**

Run: `npm run --workspace=tutorial-engine test -- workbook-server.test.ts`

Expected: PASS.

- [ ] **Step 5: Update and run browser smoke**

Update its state fixtures to use the common checkpoint shape.

Run: `npm run --workspace=tutorial-engine browser:smoke`

Expected: PASS.

- [ ] **Step 6: Commit**

```sh
git add tutorial-engine/src/workbook/server.ts tutorial-engine/test/workbook-server.test.ts \
  tutorial-engine/test/browser-smoke.mts
git commit -m "feat: orchestrate workbook attempts centrally"
```

## Task 6: Render shared success checkpoints and confetti

**Files:**
- Modify: `tutorial-engine/web-workbook/src/workbook-ui.tsx`
- Modify: `tutorial-engine/web-workbook/src/styles.css`
- Modify: `tutorial-engine/test/workbook-ui.test.tsx`

**Interfaces:**

```ts
type PublicCheckpoint = {
  status: "working" | "reviewing" | "feedback" | "accepted";
  feedback?: string;
  successMessage?: string;
  evidence?: { kind: AttemptKind; text?: string; terminalHtml?: string; conversation?: ReflectionTurn[] };
};
function AcceptedCheckpoint(props: { block: Block; state: BlockProgress; refresh(state: State): void }): JSX.Element;
function AcceptanceConfetti(props: { acceptedKey: string | undefined }): JSX.Element | null;
```

- [ ] **Step 1: Write failing UI tests**

Add one accepted checkpoint fixture for each evidence kind. Assert each shows the tutor success message,
read-only evidence, and Continue; assert nonaccepted blocks have no checkpoint Continue. Focus an editor,
then refresh it into accepted state and assert the input is removed only after acceptance. Mock
`matchMedia` and fake timers: on a transition to accepted, assert an `aria-hidden` confetti layer appears,
has pointer-inert styling, disappears after 1,000 ms, does not reappear on a same-accepted rerender, and
is absent when reduced motion matches.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run --workspace=tutorial-engine test -- workbook-ui.test.tsx`

Expected: FAIL because checkpoints remain type-specific and no confetti component exists.

- [ ] **Step 3: Implement shared UI**

Replace editor-unlocked, terminal-verified, and reflection-complete controls with `AcceptedCheckpoint`.
Keep each input's status and feedback while its attempt is working/reviewing/feedback. Use generic
`post(block.id, { action: "continue" })` only from the checkpoint. Trigger a fixed full-screen
`AcceptanceConfetti` only on a client-side transition to a new accepted key. Render a finite collection of
CSS particles; make its root `aria-hidden="true"` and `pointer-events: none`. Add a one-second keyframe
and a `prefers-reduced-motion: reduce` rule that disables it.

- [ ] **Step 4: Run focused tests**

Run: `npm run --workspace=tutorial-engine test -- workbook-ui.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit**

```sh
git add tutorial-engine/web-workbook/src/workbook-ui.tsx tutorial-engine/web-workbook/src/styles.css \
  tutorial-engine/test/workbook-ui.test.tsx
git commit -m "feat: celebrate accepted workbook attempts"
```

## Task 7: Verify the integrated migration

**Files:**
- Modify only if integration failures require the smallest tested correction.

- [ ] **Step 1: Run TypeScript and all engine tests**

Run: `npm run --workspace=tutorial-engine check`

Expected: PASS.

- [ ] **Step 2: Build the complete project**

Run: `npm run check && npm run --workspace=tutorial-engine build && npm run --workspace=tutorial-engine browser:smoke`

Expected: all commands PASS.

- [ ] **Step 3: Verify ADR metadata in the devcontainer**

Run:

```sh
devcontainer exec --workspace-folder . bash -lc 'cd tutorial-engine && adrgen list'
```

Expected: ADR 0002 and ADR 0003 are listed as accepted.

- [ ] **Step 4: Inspect public-state boundary**

Run:

```sh
rg -n 'privateGuidance|attemptId|\.tutorial/.tmp/workbook/attempts' tutorial-engine/web-workbook \
  tutorial-engine/src/workbook/server.ts
```

Expected: no public UI/API serialization includes private guidance, internal attempt IDs, or store paths.

- [ ] **Step 5: Confirm the working tree contains no uncommitted implementation changes**

Run: `git status --short`

Expected: no source or test files are listed. Preserve unrelated user changes if any are present.
