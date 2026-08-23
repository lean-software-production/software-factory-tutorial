# Role-Faithful Workbook Tutor History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the main tutor's bounded Pi context from the event log with faithful chat roles,
per-block summaries, and per-lesson summaries.

**Architecture:** The append-only workbook event log remains canonical. `pi-history.ts` derives a
main-tutor projection containing selected hidden summaries and the remaining visible conversation;
the browser continues to render its own safe projection of the full log. `tutor.ts` resolves the
Pi model before it creates the in-memory session, then reconstructs learner turns as native Pi user
messages and static authored/tutor turns as complete zero-usage Pi assistant messages.

**Tech Stack:** TypeScript, Pi AgentSession SDK, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-23-role-faithful-workbook-tutor-history-design.md`

## Global Constraints

- The workbook event log, not a Pi session file, remains the durable source of truth.
- The browser retains the complete learner-visible transcript after tutor-context compaction.
- Learner messages project as Pi user messages; authored material and tutor replies project as Pi
  assistant messages with complete, text-only, zero-valued provider usage.
- Internal block and lesson summaries are model-visible but never learner-visible.
- A block summary replaces that completed block's detail; a lesson summary replaces that lesson's
  block summaries.
- Active-block private guidance and attempt evidence remain hidden from the browser and retain their
  existing tutor-only handling.
- Preserve the current no-tools main-tutor boundary, resilient retry/log redaction, and generic
  public failure string: `The tutor is temporarily unavailable. Please retry.`

---

## File structure

- `tutorial-engine/src/workbook/pi-history.ts` — derives deterministic summary and conversation
  layers from ordered timeline records.
- `tutorial-engine/src/workbook/tutor.ts` — translates the typed projection to valid Pi messages and
  retains the active-block private context entry.
- `tutorial-engine/test/workbook-pi-history.test.ts` — specifies hierarchical compaction and replay
  ordering without a Pi runtime.
- `tutorial-engine/test/workbook-tutor.test.ts` — covers main-tutor recreation when the projection
  changes and preserves private active-context behaviour.
- `tutorial-engine/test/workbook-tutor-model.test.ts` — inspects the Pi session-manager calls made by
  the default adapter and verifies native message metadata.
- `tutorial-engine/test/workbook-server.test.ts` — characterizes that the public timeline remains a
  full, safe rendering even when its private log contains summaries.

### Task 1: Define the hierarchical event-log projection

**Files:**
- Modify: `tutorial-engine/src/workbook/pi-history.ts`
- Modify: `tutorial-engine/test/workbook-pi-history.test.ts`

**Interfaces:**
- Produces `PiHistorySummary` with `sourceEventId`, `scope`, `lessonId`, optional `blockId`, `text`,
  `coveredThroughId`, and `timestamp`.
- Produces `PiHistoryTurn` with `sourceEventId`, `role`, `text`, and `timestamp`.
- Changes `PiHistoryProjection` from an optional singular `summary` to ordered
  `summaries: PiHistorySummary[]` plus `turns: PiHistoryTurn[]`.
- Keeps `projectMainTutorHistory(records, activeContext?)` as the main-tutor entry point and retains
  its hidden `workbook-active-block` data for active private guidance and evidence.

- [ ] **Step 1: Write failing projection tests**

Replace the newest-summary test with a hierarchy fixture that has a completed first lesson, two
completed blocks in the second lesson, and an active third block. Assert that only the completed
lesson summary and the two completed-block summaries survive, followed by the active block turns:

```ts
expect(history.summaries).toEqual([
  {
    sourceEventId: "lesson-one-summary",
    scope: "lesson",
    lessonId: "lesson-one",
    text: "Lesson one summary.",
    coveredThroughId: "lesson-one-end",
    timestamp: Date.parse("2026-08-21T00:00:05.000Z")
  },
  {
    sourceEventId: "block-one-summary",
    scope: "block",
    lessonId: "lesson-two",
    blockId: "one",
    text: "Block one summary.",
    coveredThroughId: "block-one-end",
    timestamp: Date.parse("2026-08-21T00:00:08.000Z")
  },
  {
    sourceEventId: "block-two-summary",
    scope: "block",
    lessonId: "lesson-two",
    blockId: "two",
    text: "Block two summary.",
    coveredThroughId: "block-two-end",
    timestamp: Date.parse("2026-08-21T00:00:11.000Z")
  }
]);
expect(history.turns).toEqual([
  {
    sourceEventId: "active-authored",
    role: "assistant",
    text: "## Active block",
    timestamp: Date.parse("2026-08-21T00:00:12.000Z")
  },
  {
    sourceEventId: "active-learner",
    role: "user",
    text: "What should I try next?",
    timestamp: Date.parse("2026-08-21T00:00:13.000Z")
  }
]);
```

Add a second fixture where a `lesson_summarized` record follows two block summaries for the same
lesson. Assert that the lesson summary replaces both block summaries, while the earlier lesson
summary remains. Update authored-history assertions to include the deterministic timestamps.

- [ ] **Step 2: Run the focused tests to verify they fail**

Run:

```sh
npm run --workspace=tutorial-engine test -- workbook-pi-history.test.ts
```

Expected: FAIL because `PiHistoryProjection` has no `summaries` collection and still selects only
one newest summary.

- [ ] **Step 3: Implement deterministic summary selection**

In `pi-history.ts`:

1. Add the `PiHistorySummary` type and add a numeric timestamp to both projection record types.
2. Sort records by `sequence`, then build a lookup from event ID to sequence.
3. Select the newest summary per lesson and per `(lessonId, blockId)` key. A selected lesson summary
   removes every selected block summary for its lesson that occurred before the lesson-summary event.
4. Sort the remaining summaries by their event sequence. Find the largest covered-through sequence
   among them and project only `message` records after that boundary as detailed turns.
5. Map every selected summary and turn with `Date.parse(record.at)`. Reject an invalid event time
   with an explicit projection error rather than using `Date.now()`.
6. Keep the existing active-context source-event calculation, but compare it against the new turn
   IDs and return the active private context unchanged.

Do not include `block_tutor_briefed`, `block_tutor_readiness`, or `tutor_failed` records in either
collection.

- [ ] **Step 4: Run the focused tests to verify they pass**

Run:

```sh
npm run --workspace=tutorial-engine test -- workbook-pi-history.test.ts
```

Expected: PASS, including authored replay, hierarchical block/lesson replacement, timestamp, and
private active-context coverage.

- [ ] **Step 5: Commit Task 1**

```sh
git add tutorial-engine/src/workbook/pi-history.ts tutorial-engine/test/workbook-pi-history.test.ts
git commit -m "feat: project hierarchical workbook tutor history"
```

### Task 2: Reconstruct complete native Pi conversation messages

**Files:**
- Modify: `tutorial-engine/src/workbook/tutor.ts`
- Modify: `tutorial-engine/test/workbook-tutor-model.test.ts`

**Interfaces:**
- Consumes `MainTutorHistoryProjection` from Task 1 and the resolved tutor model.
- Produces valid Pi `UserMessage` and `AssistantMessage` objects through
  `SessionManager.appendMessage()`.
- Uses `appendCustomMessageEntry()` only for `workbook-context-block-summary`,
  `workbook-context-lesson-summary`, and the existing `workbook-active-block` internal context.

- [ ] **Step 1: Write failing Pi-adapter tests**

Extend the Pi module mock in `workbook-tutor-model.test.ts` so the mocked session manager records
calls:

```ts
const appendMessage = vi.fn();
const appendCustomMessageEntry = vi.fn();
SessionManager: { inMemory: vi.fn(() => ({ appendMessage, appendCustomMessageEntry })) }
```

Have `resolveCliModel` return a model with `api`, `provider`, and `id`. Create a tutor with an
authored assistant turn, a learner turn, a main-tutor turn, and one completed-block summary. After
`reply()`, assert the first three `appendMessage` calls are role-faithful and that assistant calls
contain the complete static usage object:

```ts
expect(appendMessage).toHaveBeenNthCalledWith(1, expect.objectContaining({
  role: "assistant",
  api: "openai-completions",
  provider: "provider",
  model: "main-model",
  stopReason: "stop",
  usage: {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  },
  timestamp: Date.parse("2026-08-22T00:00:01.000Z")
}));
expect(appendMessage).toHaveBeenNthCalledWith(2, expect.objectContaining({
  role: "user", timestamp: Date.parse("2026-08-22T00:00:02.000Z")
}));
expect(appendCustomMessageEntry).toHaveBeenCalledWith(
  "workbook-context-block-summary",
  expect.stringContaining("Block one summary"),
  false,
  expect.objectContaining({ sourceEventId: "block-one-summary", coveredThroughId: "block-one-end" })
);
```

Also assert no appended history object is created through `as never` or lacks `usage` when its role
is `assistant`.

- [ ] **Step 2: Run the focused model test to verify it fails**

Run:

```sh
npm run --workspace=tutorial-engine test -- workbook-tutor-model.test.ts
```

Expected: FAIL because the factory appends history before resolving the model, uses incomplete
assistant records, and has only the singular summary entry.

- [ ] **Step 3: Implement typed history-to-Pi translation**

In `createPiWorkbookTutorSession()`:

1. Create the resource loader and resolve `ModelRuntime`/`TutorModelChoice` before populating the
   in-memory `SessionManager`.
2. Append every `history.summaries` entry in order using a scope-specific custom type. Make its
   model-visible text self-identifying, for example `Completed block summary for lesson/block:\n...`.
   Preserve source ID, scope, lesson ID, block ID, covered-through ID, and timestamp in `details`.
3. Add a small typed helper that maps a projected user turn to `{ role: "user", content, timestamp }`
   and a projected assistant turn to a full Pi assistant message using `choice.model.api`,
   `choice.model.provider`, `choice.model.id`, `stopReason: "stop"`, and a fresh constant
   zero-usage object.
4. Append those typed messages in projection order. Remove the `as never` cast.
5. Append the existing active-block private context after the summaries and chat history. Leave its
   browser exclusion, author-guidance boundary, and attempt evidence unchanged.
6. Pass the already resolved model and thinking level to `createAgentSession()` exactly as before.

Do not persist a Pi JSONL session, change retry settings, or make summaries learner-visible.

- [ ] **Step 4: Run focused adapter and tutor tests to verify they pass**

Run:

```sh
npm run --workspace=tutorial-engine test -- workbook-tutor-model.test.ts workbook-tutor.test.ts
```

Expected: PASS. The model-selection assertion remains green, session recreation still works, and
all synthetic assistant turns satisfy Pi's metadata contract.

- [ ] **Step 5: Commit Task 2**

```sh
git add tutorial-engine/src/workbook/tutor.ts tutorial-engine/test/workbook-tutor-model.test.ts tutorial-engine/test/workbook-tutor.test.ts
git commit -m "fix: restore workbook tutor messages with Pi metadata"
```

### Task 3: Prove projection recovery and browser isolation

**Files:**
- Modify: `tutorial-engine/test/workbook-tutor.test.ts`
- Modify: `tutorial-engine/test/workbook-server.test.ts`

**Interfaces:**
- Consumes the hierarchical `MainTutorHistoryProjection` and the server's existing public timeline
  serializer.
- Produces regression coverage that a changed summary projection recreates the disposable Pi session,
  while the browser retains original messages and excludes internal summaries.

- [ ] **Step 1: Write failing lifecycle and public-projection tests**

In `workbook-tutor.test.ts`, add a fake-session-factory case that starts with detailed completed
block records, then calls `restore()` with the same records plus a `block_summarized` record. Assert
that the first fake session is disposed, a second factory request is made, and the second request
contains one block summary with no completed-block turns.

In `workbook-server.test.ts`, extend a completed-block fixture to inspect both stores after the
server writes `block_summarized`:

```ts
expect(privateRecords).toContainEqual(expect.objectContaining({
  type: "block_summarized", lessonId: "001-first", blockId: "edit-answer"
}));
expect(publicState.timeline).toEqual(expect.arrayContaining([
  expect.objectContaining({ type: "message", source: "authored", blockId: "edit-answer" }),
  expect.objectContaining({ type: "message", source: "main_tutor" })
]));
expect(publicState.timeline.some((record: any) => record.type === "block_summarized")).toBe(false);
```

Add the analogous assertion after `lesson_summarized`: the internal file contains it, the public
timeline retains its original messages, and no lesson summary is rendered.

- [ ] **Step 2: Run the focused tests to verify the new assertions protect the boundaries**

Run:

```sh
npm run --workspace=tutorial-engine test -- workbook-tutor.test.ts workbook-server.test.ts
```

Expected: PASS if the existing public serializer already filters summaries; otherwise FAIL until the
serializer is corrected to exclude `block_summarized` and `lesson_summarized` without filtering the
covered message records.

- [ ] **Step 3: Make only the necessary production correction**

If Step 2 exposes public summary records, modify the existing public timeline projection in
`tutorial-engine/src/workbook/server.ts` or `tutorial-engine/src/workbook/events.ts` so it excludes
only internal summary record types. Do not remove or reorder the original `message` events. If Step
2 passes, leave production server files unchanged and keep the characterization test.

- [ ] **Step 4: Run complete verification**

Run:

```sh
npm run --workspace=tutorial-engine check
```

Expected: PASS: TypeScript checking and the full Vitest suite, including Pi history, tutor model,
main tutor, and server regression tests.

- [ ] **Step 5: Commit Task 3**

```sh
git add tutorial-engine/test/workbook-tutor.test.ts tutorial-engine/test/workbook-server.test.ts \
  tutorial-engine/src/workbook/server.ts tutorial-engine/src/workbook/events.ts
git commit -m "test: preserve compact tutor context and full timeline"
```
