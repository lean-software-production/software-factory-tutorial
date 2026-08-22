# Main and Block Workbook Tutors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a durable main workbook tutor, fast active-block hint tutor, and usable threaded workbook UI without losing compacted history or workflow controls.

**Architecture:** The append-only workbook timeline remains canonical. A main tutor reconstructs its conversation from timeline history plus complete active-block evidence and is the only actor that accepts attempts. A short-lived fast block tutor receives a precomputed private briefing, current evidence, and read-only workspace tools to give direct hints beside active terminal/editor work.

**Tech Stack:** TypeScript, React 19, Vite, Vitest, Pi SDK (`@earendil-works/pi-coding-agent`), TypeBox, Node filesystem APIs.

**Spec:** `docs/superpowers/specs/2026-08-22-main-and-block-workbook-tutors-design.md`

## Global Constraints

- The workbook event log remains the canonical learner-session record.
- The main tutor alone accepts attempts; a block tutor only advises or gives explicit hints.
- The main tutor receives complete active-block context; completed blocks become internal summaries.
- Block tutors run only for active terminal/editor blocks and use a fast model.
- Block tutor tools are read-only, workspace-confined `read`, `grep`, `find`, and `ls`; no shell, write, network, or mutating tools.
- Private `tutor` frontmatter, prepared briefings, readiness observations, and raw attempt evidence never appear in public state or browser timeline messages.
- Both main-tutor replies and block-tutor hints are durable assistant messages in the learner timeline.
- Do not implement completed-block delegation, a supervisor protocol, or revision-summary chat messages.
- Follow TDD: write and run the focused failing test before each production change.

---

## File structure

| File | Responsibility |
| --- | --- |
| `tutorial-engine/src/workbook/timeline.ts` | Add internal briefing/readiness records and distinguish main/block tutor message sources. |
| `tutorial-engine/src/workbook/attempts.ts` | Read all immutable attempts for one active block in version order. |
| `tutorial-engine/src/workbook/pi-history.ts` | Project learner-visible turns plus an internal active-block context into main-tutor session reconstruction. |
| `tutorial-engine/src/workbook/tutor.ts` | Replace the review-only session wrapper with the main tutor: general chat, private briefing, structured review, compaction, and recovery. |
| `tutorial-engine/src/workbook/block-tutor.ts` | Create ephemeral fast block-tutor sessions, safe read-only tools, hint generation, and readiness observations. |
| `tutorial-engine/src/workbook/server.ts` | Orchestrate briefing preparation, chat, hints, automatic review, recovery, and public-state filtering. |
| `tutorial-engine/web-workbook/src/workbook-ui.tsx` | Route the fixed composer; place workflow controls in the timeline; wire reflection through main-tutor chat. |
| `tutorial-engine/web-workbook/src/activity-band.tsx` | Render the active terminal/editor hint button in the sticky band. |
| `tutorial-engine/web-workbook/src/timeline-thread.tsx` | Render main/block tutor messages, an inline continuation slot, and a fixed composer. |
| `tutorial-engine/web-workbook/src/styles.css` | Reserve thread bottom space and pin the composer without hiding controls. |
| `tutorial-engine/test/*.test.ts` | Cover records, context projection, tutor contracts, block tools, server recovery, and UI behavior. |
| `README.md`, `scripts/setup.mjs` | Document and report the optional fast block-tutor model selection. |

## Task 1: Persist active-block support records and project active context

**Files:**
- Modify: `tutorial-engine/src/workbook/timeline.ts`
- Modify: `tutorial-engine/src/workbook/attempts.ts`
- Modify: `tutorial-engine/src/workbook/pi-history.ts`
- Modify: `tutorial-engine/test/workbook-timeline.test.ts`
- Modify: `tutorial-engine/test/workbook-pi-history.test.ts`
- Create: `tutorial-engine/test/workbook-attempts.test.ts` if no existing attempt-store test covers version history

**Interfaces:**
- Produces `BlockTutorBriefing`, `BlockTutorReadiness`, `MainTutorSource`, `TutorPresentation`, and `ActiveBlockContext` for Tasks 2–4.
- Produces `AttemptStore.list(lessonId: string, blockId: string): Promise<Attempt[]>`, ordered by `version` ascending.
- Produces `projectMainTutorHistory(records, activeContext): MainTutorHistoryProjection`, where `MainTutorHistoryProjection` extends `PiHistoryProjection` with one server-only active-context entry.

- [ ] **Step 1: Write failing timeline and attempt-history tests**

Add a timeline test that appends one `block_tutor_briefed` and one `block_tutor_readiness` record, then verifies IDs, sequence ordering, and JSONL round-trip. Add an attempt-store test that creates three editor attempts, checks that the first two become `superseded`, and expects `list()` to return all three in versions `1, 2, 3`.

```ts
expect(await attempts.list("lesson", "editor")).toMatchObject([
  { version: 1, status: "superseded", evidence: { kind: "editor", text: "first" } },
  { version: 2, status: "superseded", evidence: { kind: "editor", text: "second" } },
  { version: 3, status: "working", evidence: { kind: "editor", text: "third" } },
]);
```

Add a Pi-history test with a completed-block summary, a later active authored block, a block-tutor hint, and an `ActiveBlockContext`. Expect the projected turns to contain only the summary boundary’s later learner-visible messages and expect the active context to retain all current-block attempts.

- [ ] **Step 2: Run focused tests and confirm they fail**

Run:

```sh
npm run --workspace=tutorial-engine test -- test/workbook-timeline.test.ts test/workbook-pi-history.test.ts test/workbook-attempts.test.ts
```

Expected: failures for missing record types, `AttemptStore.list`, and active-context projection.

- [ ] **Step 3: Add the durable types and read-only history access**

In `timeline.ts`, replace the ambiguous tutor source with explicit learner-visible sources:

```ts
export type TimelineMessageSource = "authored" | "learner" | "main_tutor" | "block_tutor";
export type TimelinePresentation = "course" | "chat" | "hint" | "review";
```

Add server-only records:

```ts
export type BlockTutorBriefing = TimelineMetadata & {
  type: "block_tutor_briefed";
  lessonId: string;
  blockId: string;
  text: string;
  coveredThroughId: string;
};

export type BlockTutorReadiness = TimelineMetadata & {
  type: "block_tutor_readiness";
  lessonId: string;
  blockId: string;
  attemptId: string;
  readiness: "likely_ready" | "still_working";
  text: string;
};
```

Include both in `WorkbookTimelineRecord` and `TimelineAppendInput`, but do not add them to `publicTimeline()` in Task 4.

In `attempts.ts`, enumerate only version-attempt JSON files in a block directory, read them through the existing validation path, and sort numerically by `version`. Do not use `current.json` as an attempt.

In `pi-history.ts`, define:

```ts
export type ActiveBlockContext = {
  lessonId: string;
  blockId: string;
  title: string;
  markdown: string;
  authorGuidance: string;
  attempts: Attempt[];
};
```

Keep `projectPiHistory()` as the pure learner-visible projection. Add:

```ts
export type MainTutorHistoryProjection = PiHistoryProjection & {
  activeContext?: { name: "workbook-active-block"; text: string; sourceEventIds: string[] };
};
```

`projectMainTutorHistory()` returns that type with a serialized active-context custom-message payload. The payload is not a user or assistant turn.

- [ ] **Step 4: Run focused tests and confirm they pass**

Run the command from Step 2. Expected: all focused tests pass and no public-history test contains `authorGuidance`.

- [ ] **Step 5: Commit the persistence foundation**

```sh
git add tutorial-engine/src/workbook/timeline.ts tutorial-engine/src/workbook/attempts.ts tutorial-engine/src/workbook/pi-history.ts tutorial-engine/test/workbook-timeline.test.ts tutorial-engine/test/workbook-pi-history.test.ts tutorial-engine/test/workbook-attempts.test.ts
git commit -m "feat: persist workbook block tutor context"
```

## Task 2: Make the main tutor conversational and authoritative

**Files:**
- Modify: `tutorial-engine/src/workbook/tutor.ts`
- Modify: `tutorial-engine/test/workbook-tutor.test.ts`
- Modify: `tutorial-engine/src/agent/pi-adapter.ts` only if model-resolution helpers need a shared export

**Interfaces:**
- Consumes `ActiveBlockContext`, `BlockTutorReadiness`, and timeline records from Task 1.
- Produces this `MainWorkbookTutor` contract for Task 4:

```ts
export type MainTutorContext = {
  records: readonly WorkbookTimelineRecord[];
  activeContext?: ActiveBlockContext;
};

export interface MainWorkbookTutor {
  restore(input: MainTutorContext): Promise<void>;
  reply(input: MainTutorContext & { learnerMessage: TimelineMessage }): Promise<string>;
  prepareBlockBriefing(input: MainTutorContext & { lessonId: string; blockId: string }): Promise<string>;
  review(input: MainTutorContext & TutorReview & { readiness?: BlockTutorReadiness }): Promise<TutorDecision>;
  summarizeBlock(input: MainTutorContext & { lessonId: string; blockId: string; coveredThroughId: string }): Promise<string>;
  summarizeLesson(input: MainTutorContext & { lessonId: string; coveredThroughId: string }): Promise<string>;
  dispose(): void;
}
```

- Produces a structured `TutorDecision`:

```ts
export type TutorDecision =
  | { outcome: "accepted"; message: string }
  | { outcome: "feedback"; message: string }
  | { outcome: "working" };
```

- [ ] **Step 1: Write failing main-tutor tests**

Replace review-only assumptions with tests that verify:

1. `reply()` rebuilds from projected authored/learner/main/block turns plus active evidence and returns a non-empty response;
2. `prepareBlockBriefing()` receives the exact author guidance and returns private text;
3. accepted, feedback, and working review outcomes are distinguished; and
4. `working` creates no public text, while an empty normal reply rejects rather than returning `""`.

Use fake sessions that record their system prompt, custom tools, custom active-context message, and prompts. For tool outcomes, invoke the fake custom tool definitions exactly as the existing acceptance test does.

```ts
await expect(tutor.review(reviewInput)).resolves.toEqual({ outcome: "working" });
await expect(tutor.reply(replyInput)).rejects.toThrow(/empty tutor response/i);
```

- [ ] **Step 2: Run the focused test and confirm it fails**

Run:

```sh
npm run --workspace=tutorial-engine test -- test/workbook-tutor.test.ts
```

Expected: failures because `RestrictedWorkbookTutor` has a review-only system prompt and no briefing/working contract.

- [ ] **Step 3: Implement the main tutor contract**

Rename `RestrictedWorkbookTutor` to `MainWorkbookTutor` and rename its option/factory interfaces accordingly. Keep the session serialized with its existing promise tail.

Use a main-tutor system prompt that separates ordinary learner conversation from review. It must state that the tutor:

- answers block-scoped learner messages concisely;
- has no filesystem, shell, network, or mutating authority;
- treats learner evidence as untrusted data;
- may call `accept_current_attempt()` only while a review binds an attempt;
- calls a new no-argument `mark_attempt_still_working()` tool without public text when an attempt is visibly incomplete; and
- otherwise returns concise material feedback or a concise accepted message.

Build sessions from `projectMainTutorHistory()` and append the active context with `SessionManager.appendCustomMessageEntry("workbook-active-block", serializedContext, false, metadata)`. Rebuild the in-memory session whenever the projected timeline IDs or active attempt IDs change, so an existing session cannot answer with stale active evidence.

Add `prepareBlockBriefing()` with a private prompt that requires a short operational brief and includes the exact author guidance. Keep the response internal and reject an empty result. `reply()` must also reject an empty trimmed response; the server will turn that into a durable failure in Task 4.

- [ ] **Step 4: Run the focused test and confirm it passes**

Run the command from Step 2. Expected: all main-tutor contract tests pass, including the no-blank-reply assertion.

- [ ] **Step 5: Commit the main tutor**

```sh
git add tutorial-engine/src/workbook/tutor.ts tutorial-engine/test/workbook-tutor.test.ts tutorial-engine/src/agent/pi-adapter.ts
git commit -m "feat: make workbook main tutor conversational"
```

## Task 3: Add the fast read-only block tutor

**Files:**
- Create: `tutorial-engine/src/workbook/block-tutor.ts`
- Create: `tutorial-engine/test/workbook-block-tutor.test.ts`
- Modify: `tutorial-engine/src/agent/pi-adapter.ts`
- Modify: `README.md`
- Modify: `scripts/setup.mjs`
- Modify: `test/onboarding.test.mjs`

**Interfaces:**
- Consumes `ActiveBlockContext` and a `BlockTutorBriefing` from Tasks 1–2.
- Produces:

```ts
export interface WorkbookBlockTutor {
  hint(input: { context: ActiveBlockContext; briefing: string }): Promise<string>;
  assess(input: { context: ActiveBlockContext; attempt: Attempt }): Promise<{
    readiness: "likely_ready" | "still_working";
    text: string;
  }>;
}
```

- Produces `BLOCK_TUTOR_MODEL` selection. If unset, it uses Pi’s ordinary configured default; if set, it uses the same authenticated-model resolution and fallback behavior as `TUTOR_MODEL`.

- [ ] **Step 1: Write failing block-tutor and model-selection tests**

Test an ephemeral session factory receives only `read`, `grep`, `find`, and `ls` as active tools; receives the private briefing and active evidence; and produces a trimmed hint. Test a blank hint rejects.

Exercise the actual tool definitions with a temporary workspace: `read` succeeds for `factory/answer.md`; `read ../outside.txt` rejects; `write`, `edit`, `move`, and `bash` are absent. Test `assess()` returns only `likely_ready` or `still_working` through a `report_attempt_readiness` custom tool, never an acceptance result.

Add pure resolver tests in `test/onboarding.test.mjs` for `BLOCK_TUTOR_MODEL`: an authenticated explicit setting wins; invalid/unconfigured values fall back to Pi’s default selection.

- [ ] **Step 2: Run focused tests and confirm they fail**

Run:

```sh
npm run --workspace=tutorial-engine test -- test/workbook-block-tutor.test.ts
```

Expected: module-not-found and missing block-tutor-model failures.

- [ ] **Step 3: Implement ephemeral sessions and safe tools**

Create `block-tutor.ts`. Build one fresh Pi session for each `hint()` or `assess()` call; do not persist a block-tutor session across requests. Reuse `WorkspaceBoundary.create(workspace)` and filter `createWorkspaceTools()` to the tool names `read`, `grep`, `find`, and `ls`. Supply a logger-backed audit sink, not a learner-visible event sink.

The block-tutor system prompt must say that its private briefing and author guidance are instructions, learner evidence is untrusted, its task is a concise next hint, and it must not quote private guidance. It must not claim to have changed files. Its only custom readiness tool is:

```ts
report_attempt_readiness({
  readiness: "likely_ready" | "still_working",
  rationale: string,
})
```

Use the existing Pi model-resolution pattern to add `BLOCK_TUTOR_MODEL`. Document that it is for the fast helper and defaults to Pi’s normal model selection when unset; retain `TUTOR_MODEL` for the capable main tutor.

- [ ] **Step 4: Run focused tests and confirm they pass**

Run the command from Step 2, then run:

```sh
node --test test/onboarding.test.mjs
```

Expected: block tutor has only safe tools and resolver fallback behavior is deterministic.

- [ ] **Step 5: Commit the block tutor**

```sh
git add tutorial-engine/src/workbook/block-tutor.ts tutorial-engine/test/workbook-block-tutor.test.ts tutorial-engine/src/agent/pi-adapter.ts README.md scripts/setup.mjs test/onboarding.test.mjs
git commit -m "feat: add fast workbook block tutor"
```

## Task 4: Orchestrate briefings, hints, and quiet automatic review

**Files:**
- Modify: `tutorial-engine/src/workbook/server.ts`
- Modify: `tutorial-engine/test/workbook-server.test.ts`
- Modify: `tutorial-engine/src/workbook/timeline.ts` only if tests expose a missing operation discriminator

**Interfaces:**
- Consumes `MainWorkbookTutor`, `WorkbookBlockTutor`, `AttemptStore.list()`, and private internal timeline records from Tasks 1–3.
- Produces `POST /api/workbook/hints` for the active terminal/editor block and public timeline records with `source: "main_tutor" | "block_tutor"`.
- Extends `WorkbookServerOptions` with injectable `mainTutor` and `blockTutor` fakes for deterministic tests.

- [ ] **Step 1: Write failing server tests for the complete flow**

Add focused tests that:

1. introduce the workbook, continue into the editor, and expect a private `block_tutor_briefed` record before the response exposes the active editor;
2. post `POST /hints` for the active editor and expect the fake block tutor to receive the stored briefing and latest evidence, while public state shows only one `block_tutor` hint message;
3. reject a hint request for a narrative/reflection/inactive block with `409`;
4. submit a clearly incomplete attempt and expect the fake main tutor’s `{ outcome: "working" }` to leave no review message but expose the normal working status;
5. accept or feed back only from the main tutor, even if the block tutor says `likely_ready`;
6. verify a blank main reply and a blank block hint create public retryable failure records rather than blank messages; and
7. restart with existing messages, briefing, and active attempts, then verify the fakes receive restored records/context and the hint endpoint reuses the briefing.

Assert every public state serialization excludes the author rubric, briefing text, readiness rationale, and private raw-attempt records.

- [ ] **Step 2: Run the focused server test and confirm it fails**

Run:

```sh
npm run --workspace=tutorial-engine test -- test/workbook-server.test.ts
```

Expected: failures for missing `blockTutor`, `/hints`, briefing records, and `working` review outcome.

- [ ] **Step 3: Implement serialized server orchestration**

Replace the single `workbookTutor` dependency with injectable `mainTutor` and `blockTutor` dependencies. Update the server test fakes to implement these two contracts; do not retain a compatibility adapter or the old option name.

Create `activeBlockContext()` in `server.ts`: resolve the active lesson/block, include the block title/markdown/private `tutor` frontmatter, and call `attempts.list()` for all attempts in the active block. Never return this object from `publicState()`.

When `ensureAuthoredActiveBlock()` activates a terminal/editor block, prepare the main-tutor briefing within the serialized timeline operation, append `block_tutor_briefed`, then expose the new active state. On a meaningful main reply or review feedback, schedule a serialized refresh; retain the last successful briefing if refresh fails.

Implement `POST /api/workbook/hints` with no request text. Validate that the requested `blockId` is the currently active terminal/editor, find its newest briefing, call `blockTutor.hint()`, require non-empty text, append an assistant message with `source: "block_tutor"` and `presentation: "hint"`, then return public state.

For automatic attempt submission, call `blockTutor.assess()` and append its internal readiness record. Pass that advice, current attempt, full active context, and author guidance to `mainTutor.review()`. Map results exactly:

```ts
accepted -> attempts.acceptCurrent(), visible review message, attempt_accepted
feedback -> attempts.markFeedback(), visible review message
working  -> leave the attempt in working/reviewing state, no timeline message
```

Use `source: "main_tutor"` for chat and review messages. Reject empty main/block model text before appending. Extend failure operations and retry routing so main reply, hint, briefing, readiness, review, restoration, and summaries remain retryable without exposing provider errors.

At startup, restore the main tutor with the timeline plus active context, retain the newest internal briefing, and requeue any unaccepted active attempt.

- [ ] **Step 4: Run focused server tests and confirm they pass**

Run the command from Step 2. Expected: all existing server behavior still passes, and new tests prove privacy, recovery, quiet working state, main-only acceptance, and prepared hint reuse.

- [ ] **Step 5: Commit the orchestration layer**

```sh
git add tutorial-engine/src/workbook/server.ts tutorial-engine/src/workbook/timeline.ts tutorial-engine/test/workbook-server.test.ts
git commit -m "feat: orchestrate workbook main and block tutors"
```

## Task 5: Restore workflow controls and add the hint/composer UI

**Files:**
- Modify: `tutorial-engine/web-workbook/src/workbook-ui.tsx`
- Modify: `tutorial-engine/web-workbook/src/activity-band.tsx`
- Modify: `tutorial-engine/web-workbook/src/timeline-thread.tsx`
- Modify: `tutorial-engine/web-workbook/src/styles.css`
- Modify: `tutorial-engine/test/workbook-ui.test.tsx`
- Modify: `tutorial-engine/test/timeline-thread.test.tsx`
- Create: `tutorial-engine/test/workbook-conversation-layout.test.tsx` if the existing layout test does not cover fixed composer and sticky hint placement

**Interfaces:**
- Consumes public `main_tutor` and `block_tutor` timeline messages and `POST /hints` from Task 4.
- Produces one-click `postBlockHint(blockId): Promise<State>` and a `TimelineThread` continuation slot for active narrative/transition blocks.

- [ ] **Step 1: Write failing UI tests**

Add a mounted `App` test with timeline state whose active block is the first narrative. Expect the authored Orientation note followed by a **Continue** button before the composer; click Continue and assert the events API receives `{ blockId: "orientation", action: "continue" }`.

Add a terminal/editor activity-band test that expects one **Get a hint** button, posts only `{ blockId }` to `/api/workbook/hints`, disables while pending, and refreshes state with the returned block-tutor message.

Add a reflection-state test that expects no Get a hint control and routes the fixed generic composer through the reflection-submit/follow-up event path. Add markup/layout assertions for a fixed composer class, bottom thread padding, and both `main_tutor` and `block_tutor` messages rendered as left-aligned “Tutor” bubbles.

- [ ] **Step 2: Run focused UI tests and confirm they fail**

Run:

```sh
npm run --workspace=tutorial-engine test -- test/workbook-ui.test.tsx test/timeline-thread.test.tsx test/workbook-conversation-layout.test.tsx
```

Expected: failures because the timeline currently suppresses narrative controls, has no hint route, and leaves the composer in normal document flow.

- [ ] **Step 3: Implement the learner interaction model**

Extract the continuation control from `NarrativeBlock`/`TransitionBlock` into an exported component or callback that `TimelineThread` can render immediately after the active authored record. Pass active block/progress/refresh from `App`. Do not auto-continue merely because the composer is visible.

Add `postBlockHint()` to `workbook-ui.tsx`. Restrict `ActivityBand` itself to active `terminal-practice` and `editor-practice` blocks; reflection is no longer a sticky work surface. Pass an `onHint` callback through `ActivityBand` and render the one-click button there. Do not render it for narratives, transitions, or reflections.

Keep the global composer inside `TimelineThread`, but give it a fixed-position CSS class and reserve matching bottom padding on the scrollable thread/page. Route composer sends by active block type: ordinary active blocks call `POST /messages`; an active reflection calls the existing reflection submit/follow-up endpoint. Remove the reflection block’s inline textarea and submit button. Keep the visible composer label exactly **Message the tutor**.

Update public timeline TypeScript unions to accept `main_tutor`/`block_tutor` and `hint`. Render both assistant sources as “Tutor”; preserve course and review styling. Do not render internal briefing/readiness records.

- [ ] **Step 4: Run focused UI tests and confirm they pass**

Run the command from Step 2. Expected: Continue is available at Orientation, hint placement is terminal/editor-only, reflection remains chat, and the fixed composer does not hide controls.

- [ ] **Step 5: Build the workbook web bundle and commit**

Run:

```sh
npm run --workspace=tutorial-engine build:web:workbook
```

Expected: Vite build succeeds.

```sh
git add tutorial-engine/web-workbook/src/workbook-ui.tsx tutorial-engine/web-workbook/src/activity-band.tsx tutorial-engine/web-workbook/src/timeline-thread.tsx tutorial-engine/web-workbook/src/styles.css tutorial-engine/test/workbook-ui.test.tsx tutorial-engine/test/timeline-thread.test.tsx tutorial-engine/test/workbook-conversation-layout.test.tsx
git commit -m "feat: add workbook hints and fixed tutor chat"
```

## Task 6: Run regression, recovery, and manual workflow verification

**Files:**
- Modify only if a failing verification reveals a focused defect: corresponding source and test files from Tasks 1–5.

**Interfaces:**
- Verifies the complete behavior produced by Tasks 1–5.

- [ ] **Step 1: Run the full tutorial-engine check**

Run:

```sh
npm run --workspace=tutorial-engine check
npm run --workspace=tutorial-engine build
```

Expected: TypeScript, all Vitest suites, server build, both web bundles, and workbook web bundle pass.

- [ ] **Step 2: Run repository checks**

Run:

```sh
npm run check
git diff --check
git status --short
```

Expected: repository checks pass, diff check reports no whitespace errors, and status is clean after commits.

- [ ] **Step 3: Manually smoke-test a fresh workbook session**

Run the workbook against a disposable tutorial workspace, remove its `.tutorial/` state, and verify in a browser:

1. Orientation renders **Continue** and advances;
2. terminal/editor activity has a sticky **Get a hint** button;
3. the bottom composer remains visible without hiding Continue or the latest message;
4. a hint appears as a left-aligned Tutor message;
5. a partial attempt only shows quiet working status;
6. the main tutor alone signs off accepted work; and
7. refresh/restart retains the messages and active workflow.

Record any discrepancy as a focused failing test before changing production code.

- [ ] **Step 4: Commit verification-only fixes if needed**

For each defect found in Step 3, add its regression test, implement the smallest fix, rerun Steps 1–2, and commit with a focused message such as:

```sh
git commit -m "fix: preserve workbook continuation controls"
```

## Task 3 round-2 fix report

- Added regression coverage for exact private briefing and author-guidance leaks shorter than eight
  characters.
- Expanded block-tutor readiness acceptance-claim coverage to reject accepted, passing, reject,
  rejected, fail, and failed wording.
- Updated the stale devcontainer model-role comment so it describes the main tutor, fast block helper,
  and doer roles separately.

Focused verification:

```sh
npm run --workspace=tutorial-engine test -- test/workbook-block-tutor.test.ts
node --test test/onboarding.test.mjs
```

## Task 4 review finding fix report

- Added a server regression for review-failure paths proving raw private attempt IDs stay out of
  public `/state` payloads and `/timeline` SSE snapshots.
- Projected `tutor_failed` records through a public shape that omits private `requestId` and exposes
  `failureId` for retry routing.
- Updated the workbook timeline UI type and retry button to use `failureId` rather than the timeline
  record ID.

Focused verification:

```sh
npm run --workspace=tutorial-engine test -- test/workbook-server.test.ts
npm run --workspace=tutorial-engine build:web:workbook
```
