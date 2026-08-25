# Workbook Conversational Timeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the workbook event log the durable tutor conversation, render it as a chat-like thread, and keep the active exercise pinned above that thread.

**Architecture:** A new workbook timeline owns ordered, durable conversation, workflow, and summary records. The server projects that log into the browser and a disposable restricted Pi session; immutable attempts remain separate evidence. The UI renders the timeline while an activity band owns the one live terminal, editor, or reflection surface.

**Tech Stack:** TypeScript, Node JSONL persistence, Pi coding-agent SDK, React 19, CodeMirror 6, xterm.js, Vite, Vitest, JSDOM.

**Spec:** `docs/superpowers/specs/2026-08-21-workbook-conversational-timeline-design.md`

## Global Constraints

- Implement the workbook only. Do not change `tutorial-engine/src/server/`, `tutorial-engine/src/agent/`, or `tutorial-engine/web/`.
- Keep learner state under `.tutorial/.tmp/`; keep curriculum markdown and private `tutor` block guidance out of public API payloads and public timeline records.
- The restricted tutor keeps no filesystem, shell, network, workspace, built-in, or extension tools. `accept_current_attempt()` remains its sole custom tool and is bound only during an attempt review.
- Persist a timeline record before publishing it to the browser or treating it as durable Pi context.
- Keep raw terminal/editor/reflection evidence in `AttemptStore`; do not insert it wholesale into general Pi conversation history.
- Generated block and lesson summaries are internal timeline records, never browser chat messages.
- Run the listed focused tests before each task commit. Finish with `npm run check` from the repository root and `npm run --workspace=tutorial-engine build`.

---

## File structure

| File | Responsibility |
| --- | --- |
| `tutorial-engine/src/workbook/timeline.ts` | Ordered JSONL records, legacy-log compatibility, serialized durable append, subscribers, and public record types. |
| `tutorial-engine/src/workbook/events.ts` | Pure workflow projection from timeline records; no file I/O or conversation storage. |
| `tutorial-engine/src/workbook/pi-history.ts` | Pure selection of the latest summary plus later conversation turns, and conversion into Pi session-manager entries. |
| `tutorial-engine/src/workbook/tutor.ts` | Restores Pi context, replies to learner chat, reviews the bound attempt, and creates scoped summaries. |
| `tutorial-engine/src/workbook/server.ts` | Owns the one timeline transaction queue, records presentation and tutor results, exposes state/SSE/message APIs, and coordinates recovery. |
| `tutorial-engine/web-workbook/src/workbook-types.ts` | Shared browser contract for state, timeline records, and activity-band input. |
| `tutorial-engine/web-workbook/src/timeline-thread.tsx` | Renders authored cards, tutor/review cards, learner bubbles, retryable error cards, and chat input. |
| `tutorial-engine/web-workbook/src/activity-band.tsx` | Hosts the current terminal, editor, or reflection input and keeps it sticky until block progression. |
| `tutorial-engine/web-workbook/src/workbook-ui.tsx` | Loads state, subscribes to SSE, retains lesson rail/page shell, and composes the thread and activity band. |
| `tutorial-engine/web-workbook/src/styles.css` | Timeline alignment and sticky activity-band presentation, including narrow-screen behaviour. |
| `tutorial-engine/test/workbook-timeline.test.ts` | Timeline persistence, ordering, publication, migration, and workflow projection tests. |
| `tutorial-engine/test/workbook-pi-history.test.ts` | Role-order and block/lesson summary boundary tests. |
| `tutorial-engine/test/workbook-tutor.test.ts` | Restored-history, chat, summary, and restricted-review behaviour. |
| `tutorial-engine/test/workbook-server.test.ts` | HTTP-level presentation, recovery, ordering, retries, and privacy tests. |
| `tutorial-engine/test/workbook-ui.test.tsx` | Timeline semantics, activity-band placement, aligned bubbles, and client event handling. |

## Record and interface contracts

All new timeline records carry a monotonically increasing `sequence`, a stable `id`, and an ISO `at`
timestamp. Existing rows without these fields remain readable as deterministic legacy records with
`sequence` equal to their one-based line number and `id` equal to `legacy:<line-number>`; newly appended
rows use the next sequence and a generated UUID.

```ts
// src/workbook/timeline.ts
export type TimelineMessage = {
  type: "message";
  id: string;
  sequence: number;
  at: string;
  lessonId: string;
  blockId: string;
  role: "assistant" | "user";
  source: "authored" | "learner" | "tutor";
  presentation: "course" | "chat" | "review";
  text: string;
  inReplyTo?: string;
};

export type BlockSummary = {
  type: "block_summarized";
  id: string;
  sequence: number;
  at: string;
  lessonId: string;
  blockId: string;
  text: string;
  coveredThroughId: string;
};

export type LessonSummary = {
  type: "lesson_summarized";
  id: string;
  sequence: number;
  at: string;
  lessonId: string;
  text: string;
  coveredThroughId: string;
};

export type TutorFailure = {
  type: "tutor_failed";
  id: string;
  sequence: number;
  at: string;
  lessonId: string;
  blockId: string;
  requestId: string;
  operation: "reply" | "review" | "restore" | "block_summary" | "lesson_summary";
  publicMessage: string;
};

export type WorkbookTimelineRecord =
  | TimelineMessage | BlockSummary | LessonSummary | TutorFailure | WorkbookWorkflowEvent;

export type TimelineAppendInput =
  | Omit<TimelineMessage, "id" | "sequence" | "at">
  | Omit<BlockSummary, "id" | "sequence" | "at">
  | Omit<LessonSummary, "id" | "sequence" | "at">
  | Omit<TutorFailure, "id" | "sequence" | "at">
  | Omit<WorkbookWorkflowEvent, "id" | "sequence" | "at">;

export class WorkbookTimeline {
  constructor(workspace: string);
  read(): Promise<WorkbookTimelineRecord[]>;
  append(input: TimelineAppendInput): Promise<WorkbookTimelineRecord>;
  subscribe(listener: (record: WorkbookTimelineRecord) => void): () => void;
  run<T>(operation: () => Promise<T>): Promise<T>;
}
```

`WorkbookWorkflowEvent` is the existing progression union, augmented with `id`, `sequence`, and `at`.
The pure `project()` function ignores message, summary, and failure records.

```ts
// src/workbook/pi-history.ts
export type PiHistoryTurn = {
  sourceEventId: string;
  role: "assistant" | "user";
  text: string;
};

export type PiHistoryProjection = {
  summary?: { sourceEventId: string; text: string; coveredThroughId: string };
  turns: PiHistoryTurn[];
};

export function projectPiHistory(records: readonly WorkbookTimelineRecord[]): PiHistoryProjection;
export function authoredBlockText(block: WorkbookBlock): string;
```

The projection selects the summary with the greatest covered sequence, then emits only message records
strictly after that boundary in sequence order. A later lesson summary therefore replaces earlier block
summaries for Pi context without changing the browser record.

---

### Task 1: Introduce the canonical workbook timeline

**Files:**
- Create: `tutorial-engine/src/workbook/timeline.ts`
- Modify: `tutorial-engine/src/workbook/events.ts`
- Modify: `tutorial-engine/src/workbook/server.ts`
- Create: `tutorial-engine/test/workbook-timeline.test.ts`
- Modify: `tutorial-engine/test/workbook-events.test.ts`

**Interfaces:**
- Produces: `WorkbookTimeline`, `WorkbookTimelineRecord`, `TimelineMessage`, `BlockSummary`,
  `LessonSummary`, `TutorFailure`, and `WorkbookWorkflowEvent` for Tasks 2–4.
- Consumes: `tutorialStatePath()` and the existing workflow-event cases in `events.ts`.

- [ ] **Step 1: Write the failing timeline tests.**

  Add tests that create a temporary workspace and assert all of the following:

  ```ts
  const timeline = new WorkbookTimeline(dir);
  const received: string[] = [];
  timeline.subscribe((record) => received.push(record.id));

  const first = await timeline.append({ type: "session_started" });
  const second = await timeline.append({
    type: "message", lessonId: LESSON_ID, blockId: "narrate",
    role: "assistant", source: "authored", presentation: "course", text: "## Narrate\n\nBody"
  });

  expect([first.sequence, second.sequence]).toEqual([1, 2]);
  expect(received).toEqual([first.id, second.id]);
  expect(await timeline.read()).toEqual([first, second]);
  ```

  Add a write-order test that holds the first `append()` behind a promise, starts a second append, and
  proves that the second record is neither published nor written until the first finishes. Add a legacy
  JSONL fixture with two current `WorkbookEvent` rows and assert `read()` returns IDs `legacy:1` and
  `legacy:2`, sequences `1` and `2`, and lets the next appended row use sequence `3`.

- [ ] **Step 2: Run the new test file and verify it fails.**

  Run: `npm run --workspace=tutorial-engine test -- test/workbook-timeline.test.ts`

  Expected: FAIL because `WorkbookTimeline` and timeline record types do not exist.

- [ ] **Step 3: Implement `WorkbookTimeline`.**

  Move JSONL path resolution and parsing out of `WorkbookEventStore` into `timeline.ts`, retaining the
  existing path `.tutorial/.tmp/workbook/events.jsonl`. Define `WorkbookWorkflowEvent` by moving the
  current workflow union from `events.ts` and add the metadata fields on newly written rows. Use one
  private promise tail in `run()`; make `append()` call `run()`, read the current highest sequence inside
  that critical section, append exactly one JSONL line, then notify subscribers. Do not use the old
  `writeProjection()` cache as recovery authority.

  Keep `events.ts` as the pure `introductionCompleted()` and `project()` module. Change both to accept
  `readonly WorkbookTimelineRecord[]`, and use a type guard to process only workflow records. Preserve all
  current progression rules and the existing `WorkbookProjection` output.

- [ ] **Step 4: Update existing workflow tests.**

  Replace direct `nowEvent()` construction in `workbook-events.test.ts` with a small test helper that
  supplies `id`, incrementing `sequence`, and `at`. Add this regression assertion:

  ```ts
  expect(project([
    workflow("block_continued", { lessonId: LESSON_ID, blockId: "narrate" }),
    message({ lessonId: LESSON_ID, blockId: "narrate", role: "assistant", source: "authored", text: "Body" }),
    summary({ type: "block_summarized", lessonId: LESSON_ID, blockId: "narrate", text: "Narrated.", coveredThroughId: "2" }),
  ], lesson).activeBlockId).toBe("edit-answer");
  ```

  This proves non-workflow timeline records cannot advance a block.

- [ ] **Step 5: Run focused tests and commit.**

  Run:

  ```sh
  npm run --workspace=tutorial-engine test -- test/workbook-timeline.test.ts test/workbook-events.test.ts
  git add tutorial-engine/src/workbook/timeline.ts tutorial-engine/src/workbook/events.ts tutorial-engine/src/workbook/server.ts tutorial-engine/test/workbook-timeline.test.ts tutorial-engine/test/workbook-events.test.ts
  git commit -m "feat: add canonical workbook timeline"
  ```

### Task 2: Project durable history into the restricted tutor

**Files:**
- Create: `tutorial-engine/src/workbook/pi-history.ts`
- Modify: `tutorial-engine/src/workbook/tutor.ts`
- Create: `tutorial-engine/test/workbook-pi-history.test.ts`
- Modify: `tutorial-engine/test/workbook-tutor.test.ts`

**Interfaces:**
- Consumes: `WorkbookTimelineRecord`, `TimelineMessage`, and summaries from Task 1.
- Produces: `projectPiHistory()`, `authoredBlockText()`, and the expanded `WorkbookTutor` contract used by
  Task 3.

```ts
export interface WorkbookTutor {
  restore(records: readonly WorkbookTimelineRecord[]): Promise<void>;
  reply(input: { lessonId: string; blockId: string; learnerMessage: TimelineMessage }): Promise<string>;
  review(input: TutorReview): Promise<TutorDecision>;
  summarizeBlock(input: { lessonId: string; blockId: string; coveredThroughId: string }): Promise<string>;
  summarizeLesson(input: { lessonId: string; coveredThroughId: string }): Promise<string>;
  dispose(): void;
}
```

- [ ] **Step 1: Write failing pure-projection tests.**

  Add a history fixture with an authored assistant message, a learner message, and a tutor reply. Assert
  exact role and text ordering:

  ```ts
  expect(projectPiHistory(records).turns).toEqual([
    { sourceEventId: "2", role: "assistant", text: "## Course note\n\nWrite the script." },
    { sourceEventId: "3", role: "user", text: "I am stuck." },
    { sourceEventId: "4", role: "assistant", text: "Check the output path first." },
  ]);
  ```

  Add one fixture with two block summaries and a later lesson summary. Assert that the projection selects
  the lesson summary and returns only messages after its `coveredThroughId`. Add an authored-text test:

  ```ts
  expect(authoredBlockText({ id: "write", type: "narrative", title: "Write it", markdown: "Use `.tmp`." }))
    .toBe("## Write it\n\nUse `.tmp`.");
  ```

- [ ] **Step 2: Run the projection tests and verify they fail.**

  Run: `npm run --workspace=tutorial-engine test -- test/workbook-pi-history.test.ts`

  Expected: FAIL because `pi-history.ts` does not exist.

- [ ] **Step 3: Implement history projection and Pi restoration.**

  Implement the pure projector first. In `tutor.ts`, retain a reference to the `SessionManager` passed to
  `createAgentSession()`. Before creating the session, append the projected assistant and user messages to
  that manager in order. When the projection has a summary, append it through Pi's compaction-entry API;
  do not present it as a browser assistant message. Use the real manager supplied to `createAgentSession`,
  rather than mutating `AgentSession.state` directly.

  Replace `compactAfterBlock()` with `summarizeBlock()` and `summarizeLesson()`. Each calls
  `session.compact()` with an instruction that limits the scope and asks for factual teaching context:

  ```text
  Summarize only the completed block through the supplied coverage boundary. Retain its goal, displayed course idea,
  accepted evidence in concise form, and any learner misconception or corrective feedback. Do not claim
  filesystem, shell, network, or workspace observations.
  ```

  Return `CompactionResult.summary`; let the server decide whether the summary is durable. Add a similar
  lesson instruction that summarizes only the completed lesson. `reply()` must use the existing restricted
  session and return its completed assistant text. `review()` keeps the current attempt-bound tool logic;
  outside `review()` the tool has no active attempt and cannot accept anything.

- [ ] **Step 4: Expand tutor tests with a fake restored session.**

  Extend `WorkbookTutorSession` and its fake so tests can capture the restored history and compaction
  instructions. Test that `restore()` runs before the first reply or review, `reply()` preserves a single
  session, and `summarizeBlock()`/`summarizeLesson()` return text without calling
  `accept_current_attempt()`. Keep the existing test that rejects literal tool-call-looking text and the
  test that only a real no-argument tool call accepts an attempt.

- [ ] **Step 5: Run focused tests and commit.**

  Run:

  ```sh
  npm run --workspace=tutorial-engine test -- test/workbook-pi-history.test.ts test/workbook-tutor.test.ts
  git add tutorial-engine/src/workbook/pi-history.ts tutorial-engine/src/workbook/tutor.ts tutorial-engine/test/workbook-pi-history.test.ts tutorial-engine/test/workbook-tutor.test.ts
  git commit -m "feat: restore workbook tutor history from timeline"
  ```

### Task 3: Make server operations durable, ordered, and recoverable

**Files:**
- Modify: `tutorial-engine/src/workbook/server.ts`
- Modify: `tutorial-engine/src/workbook/reflection.ts`
- Modify: `tutorial-engine/test/workbook-server.test.ts`

**Interfaces:**
- Consumes: `WorkbookTimeline`, `authoredBlockText()`, and the expanded `WorkbookTutor` from Tasks 1–2.
- Produces: public state with `timeline: PublicTimelineRecord[]`; `POST /api/workbook/messages`;
  `POST /api/workbook/retry`; and `GET /api/workbook/timeline` SSE.

- [ ] **Step 1: Write failing server tests for authored history and restart.**

  Add a `FakeTutor` implementation for every new tutor method. It must record calls to `restore`, `reply`,
  `summarizeBlock`, and `summarizeLesson` in addition to `review`.

  Add an HTTP test which completes the introduction, then asserts the first active authored block appears
  exactly once in state:

  ```ts
  expect(opened.timeline).toContainEqual(expect.objectContaining({
    type: "message", role: "assistant", source: "authored", presentation: "course",
    blockId: "orientation", text: expect.stringContaining("## Orientation")
  }));
  ```

  Restart the server against the same fixture directory and assert the timeline is byte-for-byte equivalent
  and the second fake tutor received those records in `restore()`. Assert a state GET does not append a
  second authored message.

- [ ] **Step 2: Write failing server tests for chat, failures, summaries, and ordering.**

  Add tests for these sequences:

  ```ts
  // Learner chat is recorded before the tutor response, and tutor text follows it.
  await postMessage(server.url, { blockId: "edit-answer", text: "Which path should I use?" });
  expect((await state(server.url)).timeline.filter(isMessage).slice(-2).map(({ role, source }) => [role, source]))
    .toEqual([["user", "learner"], ["assistant", "tutor"]]);

  // A failed reply is a retryable public failure record, not fake tutor feedback.
  expect((await state(server.url)).timeline.at(-1)).toMatchObject({ type: "tutor_failed", operation: "reply" });

  // Continuing a completed block writes a block summary before presenting the next block.
  expect(timelineTypesAfterContinue).toEqual(["block_continued", "block_summarized", "message"]);
  ```

  Drive the fixture through its transition block and assert exactly one `lesson_summarized` record occurs
  after the final block summary and before the second lesson's first authored message. Add a deferred
  reply/review/summary test proving operations submitted in quick succession remain sequence ordered.

- [ ] **Step 3: Run server tests and verify they fail.**

  Run: `npm run --workspace=tutorial-engine test -- test/workbook-server.test.ts`

  Expected: FAIL because state has no timeline, `/messages` and `/timeline` do not exist, and the fake tutor
  does not implement the new calls.

- [ ] **Step 4: Replace the store cache with one timeline transaction queue.**

  Construct `WorkbookTimeline` in `startWorkbookServer()` and load its records once. Replace the separate
  `submissionTail` and `reviewFinalizers` ordering boundary with `timeline.run()`. Every sequence that
  changes tutor-visible state runs in this order: validate current active block; append the workflow or
  learner-message record; update immutable attempt state when applicable; call the tutor; append the
  resulting tutor, summary, or failure record; derive public state.

  On first introduction completion and every successful block transition, append an authored course message
  for the newly active block if no authored message for that lesson/block already exists. The exact text is
  `authoredBlockText(block)`. Do this inside the transaction before returning a state that exposes the
  block. Keep `GET /state` side-effect free.

  Before requeueing an unaccepted attempt at startup, call `await tutor.restore(records)`. If restoration
  fails, append one `tutor_failed` record with `operation: "restore"`, return the restored timeline and a
  retryable tutor-unavailable state, and do not fabricate feedback. A later browser retry starts a fresh
  restore attempt.

- [ ] **Step 5: Implement message, SSE, review, and summary endpoints.**

  Add `POST /api/workbook/messages` accepting `{ blockId, text }`. Reject blank text, text over 4,000 UTF-8
  bytes, unknown blocks, inactive blocks, and requests before the introduction is complete. Append a
  `source: "learner"` user message; call `tutor.reply()`; append a `source: "tutor"`, `presentation:
  "chat"` assistant message. A review's decision feedback is appended as `source: "tutor"`,
  `presentation: "review"`, even when the attempt is accepted.

  Keep reflection attempt snapshots and private guidance in `AttemptStore`; change `reflection.ts` to use
  the timeline conversation rather than the old reflection-specific event pair when rebuilding its public
  thread.

  Add `POST /api/workbook/retry` accepting `{ failureId }`. It reads the referenced public
  `tutor_failed` record inside the timeline queue. For a reply failure, it reruns the preceding learner
  message. For review failure, it requeues the current active attempt. For restore failure, it retries
  `tutor.restore()` before requeueing work. It returns the same public state shape and never accepts an
  attempt without a new tutor decision.

  Add `GET /api/workbook/timeline` as an SSE endpoint. On connection write the complete public timeline;
  subscribe to `timeline.subscribe()` for later persisted records; remove the listener on request close.
  Do not stream private guidance, attempt IDs, raw terminal transcript, or summary text.

  After every `block_continued`, generate and append one `block_summarized` record for the block just left.
  After the completed lesson's transition block is summarized, generate and append one `lesson_summarized`
  record before appending the next lesson's authored message. If a summary call fails, append a
  `tutor_failed` record with the appropriate operation, leave the original records available, and progress
  normally. Preserve current editor promotion-before-acceptance and stale-attempt checks.

- [ ] **Step 6: Run server tests and commit.**

  Run:

  ```sh
  npm run --workspace=tutorial-engine test -- test/workbook-server.test.ts test/workbook-events.test.ts test/workbook-tutor.test.ts
  git add tutorial-engine/src/workbook/server.ts tutorial-engine/src/workbook/reflection.ts tutorial-engine/test/workbook-server.test.ts
  git commit -m "feat: drive workbook tutor from durable timeline"
  ```

### Task 4: Render the threaded workbook and sticky current activity

**Files:**
- Create: `tutorial-engine/web-workbook/src/workbook-types.ts`
- Create: `tutorial-engine/web-workbook/src/timeline-thread.tsx`
- Create: `tutorial-engine/web-workbook/src/activity-band.tsx`
- Modify: `tutorial-engine/web-workbook/src/workbook-ui.tsx`
- Modify: `tutorial-engine/web-workbook/src/styles.css`
- Modify: `tutorial-engine/test/workbook-ui.test.tsx`

**Interfaces:**
- Consumes: public timeline records and active block/progress data supplied by Task 3.
- Produces:

```ts
export type PublicTimelineRecord =
  | { type: "message"; id: string; sequence: number; at: string; lessonId: string; blockId: string;
      role: "assistant" | "user"; source: "authored" | "learner" | "tutor";
      presentation: "course" | "chat" | "review"; text: string; inReplyTo?: string }
  | { type: "tutor_failed"; id: string; sequence: number; at: string; lessonId: string; blockId: string;
      requestId: string; operation: "reply" | "review" | "restore" | "block_summary" | "lesson_summary";
      publicMessage: string };

export function TimelineThread(props: {
  records: readonly PublicTimelineRecord[];
  activeBlockId: string;
  onSend(text: string): Promise<void>;
  onRetry(failureId: string): Promise<void>;
}): React.ReactElement;

export function ActivityBand(props: {
  lesson: Lesson;
  activeBlock: Block;
  progress: BlockProgress;
  refresh(state: State): void;
}): React.ReactElement | null;
```

- [ ] **Step 1: Write failing UI tests for thread semantics.**

  Add a timeline fixture with authored, tutor-chat, learner, and tutor-review records. Render
  `TimelineThread` and assert:

  ```ts
  expect(markup).toContain('class="timeline-message authored"');
  expect(markup).toContain('class="timeline-message tutor"');
  expect(markup).toContain('class="timeline-message learner"');
  expect(markup).toContain('class="timeline-message tutor review"');
  expect(markup.indexOf("Course note")).toBeLessThan(markup.indexOf("Which path should I use?"));
  ```

  Assert authored content uses `Markdown`, tutor and learner messages have accessible “Tutor” and “You”
  labels, and a `tutor_failed` card provides a retry button without exposing a provider exception.

- [ ] **Step 2: Write failing UI tests for the floating activity band.**

  Render an active terminal and an active editor through `ActivityBand`. Assert the live xterm/CodeMirror
  surface is inside `.current-activity-band`, the timeline thread is rendered after the band in DOM order,
  and accepted/reviewing/feedback state still keeps the band present. Render the next active narrative block
  and assert the previous terminal/editor surface is absent. Retain existing focus and editor-debounce tests
  by moving their imports from `BlockView` to the component that now owns the editor.

- [ ] **Step 3: Run UI tests and verify they fail.**

  Run: `npm run --workspace=tutorial-engine test -- test/workbook-ui.test.tsx`

  Expected: FAIL because the thread, activity band, public timeline type, and classes do not exist.

- [ ] **Step 4: Extract public client types and presentational components.**

  Move the current browser-only `Block`, `Progress`, `State`, `PublicCheckpoint`, and timeline public-record
  types into `workbook-types.ts`. Move `EmbeddedTerminal`, editor practice, and reflection-input logic into
  `activity-band.tsx`, preserving endpoint paths, editor debounce, terminal WebSocket lifecycle, accepted
  checkpoint display, and focus behaviour.

  Implement `TimelineThread` in `timeline-thread.tsx`. Render `presentation: "course"` assistant records
  as authored course cards, `presentation: "review"` tutor records as review cards, ordinary tutor records
  as left bubbles, and learner records as right bubbles. The input posts to `/api/workbook/messages` for the
  active block. Do not render internal summary records or raw attempt evidence as thread messages.

- [ ] **Step 5: Compose the new page and subscribe to persisted events.**

  In `workbook-ui.tsx`, retain `WorkbookIntroduction`, `LessonRail`, chapter headings, and lesson metadata,
  but stop rendering every emerged block through the old sequential `BlockView` path. Render the canonical
  `TimelineThread` and exactly one `ActivityBand` for `progress.activeBlockId`. Connect an `EventSource` to
  `/api/workbook/timeline`; replace/merge client state only from server-provided records and fall back to a
  state refetch after a reconnect. Keep the existing state fetch as bootstrap and retain editor polling only
  for an in-flight review.

  Add CSS for `.current-activity-band { position: sticky; top: 0; z-index: 2; }`, set an opaque background
  and bottom shadow so chat scrolls visibly beneath it, and make `.timeline-message.learner` right-aligned
  while tutor and review cards remain left-aligned. At `max-width: 840px`, place the band below the sticky
  rail with its `top` offset matching the rail height, constrain its height, and keep the terminal/editor
  internally scrollable. Respect existing reduced-motion rules.

- [ ] **Step 6: Run UI tests, build the workbook, and commit.**

  Run:

  ```sh
  npm run --workspace=tutorial-engine test -- test/workbook-ui.test.tsx
  npm run --workspace=tutorial-engine build:web:workbook
  git add tutorial-engine/web-workbook/src/workbook-types.ts tutorial-engine/web-workbook/src/timeline-thread.tsx tutorial-engine/web-workbook/src/activity-band.tsx tutorial-engine/web-workbook/src/workbook-ui.tsx tutorial-engine/web-workbook/src/styles.css tutorial-engine/test/workbook-ui.test.tsx
  git commit -m "feat: show workbook tutor conversation beside active work"
  ```

### Task 5: Verify the full vertical slice

**Files:**
- Modify only if a focused test exposes a real defect in Tasks 1–4.

**Interfaces:**
- Consumes: all completed task interfaces.
- Produces: verified workbook timeline/recovery behaviour and a rebuilt manual-testable application.

- [ ] **Step 1: Run the complete tutorial-engine test suite.**

  Run: `npm run --workspace=tutorial-engine test`

  Expected: PASS. Resolve failures by changing the responsible implementation and its focused test; do not
  weaken privacy, recovery, or attempt-authority assertions.

- [ ] **Step 2: Run static checks and production builds.**

  Run:

  ```sh
  npm run --workspace=tutorial-engine build
  npm run check
  ```

  Expected: both commands exit 0. The second command runs the repository’s tutorial-engine checks as well
  as the existing root checks.

- [ ] **Step 3: Perform a manual workbook smoke test.**

  Run: `npm start`

  In the browser, begin the workbook, continue into a terminal or editor practice block, send a chat
  message, and verify: the authored course note occurs once; tutor messages are left-aligned; learner
  messages are right-aligned; the current terminal/editor remains sticky above the thread; and a page reload
  retains the same sequence. Stop the server after the check.
