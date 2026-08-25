# Tutor Transport Resilience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recover brief model-provider transport failures automatically and retain their diagnostic cause in the workbook tutor log.

**Architecture:** A focused shared adapter wraps Pi `AgentSession` objects at the provider boundary. It collects an assistant terminal message, converts an empty or errored terminal result into a typed failure, logs each failed attempt without prompt contents, and retries the same provider prompt with two short exponential delays. Main and block tutor session factories wrap their Pi sessions with this adapter; their public tutor and server contracts remain unchanged.

**Tech Stack:** TypeScript, Pi AgentSession SDK, Vitest.

**Spec:** Approved chat design: shared provider-session adapter for the main workbook tutor and fast block tutor; three attempts total; provider/model/attempt/error in logs; safe generic browser failure remains unchanged.

## Global Constraints

- Retry each provider prompt at most three times total: initial attempt plus two retries.
- Wait 250 ms before the second attempt and 500 ms before the third attempt.
- Log the provider, model, attempt number, and terminal error with `TutorialLogger.error`; never log learner prompt text.
- Treat an assistant terminal message without non-whitespace text, an assistant `errorMessage`, or a rejected `session.prompt()` as a retryable provider failure.
- The final failure must reject with the detailed reason so existing server code records its unchanged generic public message.
- Do not change learner-facing timeline strings or public API shapes.

---

### Task 1: Shared resilient Pi tutor-session adapter

**Files:**
- Create: `tutorial-engine/src/workbook/pi-tutor-session.ts`
- Create: `tutorial-engine/test/workbook-pi-tutor-session.test.ts`

**Interfaces:**
- Produces `createResilientTutorSession(session, log, label, options?)`, returning `{ prompt(prompt: string): Promise<string>; dispose(): void }`.
- Consumes a narrow structural Pi session dependency with `state.model`, `subscribe`, `prompt`, and `dispose`, so tests can supply deterministic terminal events without an external provider.
- `options` supports test-only injected waiting; production uses `setTimeout`.

- [ ] **Step 1: Write failing adapter tests**

Create deterministic fake session events. Add tests for the observable contracts:

```ts
test("retries an assistant terminal provider error twice, then returns its next text response", async () => {
  const session = fakeSession([
    assistantError("fetch failed"),
    assistantError("fetch failed"),
    assistantText("Recovered reply")
  ]);
  const waits: number[] = [];

  await expect(createResilientTutorSession(session, logger, "Workbook tutor", {
    wait: async (milliseconds) => { waits.push(milliseconds); }
  }).prompt("private learner prompt")).resolves.toBe("Recovered reply");

  expect(session.prompts).toEqual(["private learner prompt", "private learner prompt", "private learner prompt"]);
  expect(waits).toEqual([250, 500]);
  expect(logger.errors).toContain("Workbook tutor prompt failed (attempt 1/3; anthropic/claude): fetch failed");
  expect(logger.errors.join("\n")).not.toContain("private learner prompt");
});

test("rejects with the terminal error after the third failed attempt", async () => {
  const session = fakeSession([assistantError("fetch failed"), assistantError("fetch failed"), assistantError("fetch failed")]);

  await expect(createResilientTutorSession(session, logger, "Workbook tutor", { wait: async () => {} }).prompt("message"))
    .rejects.toThrow("fetch failed");
  expect(session.prompts).toHaveLength(3);
});

test("retries an empty assistant terminal message and identifies it in the log", async () => {
  const session = fakeSession([assistantText("   "), assistantText("Useful reply")]);

  await expect(createResilientTutorSession(session, logger, "Workbook tutor", { wait: async () => {} }).prompt("message"))
    .resolves.toBe("Useful reply");
  expect(logger.errors[0]).toContain("assistant returned no text");
});
```

- [ ] **Step 2: Run the new test file to verify it fails**

Run: `npm run --workspace=tutorial-engine test -- workbook-pi-tutor-session.test.ts`

Expected: FAIL because `pi-tutor-session.ts` and `createResilientTutorSession` do not exist.

- [ ] **Step 3: Implement the minimal adapter**

Add `pi-tutor-session.ts`. Subscribe only for the lifetime of each prompt attempt; on an assistant `message_end`, gather text content and read its `errorMessage`. Resolve only non-whitespace assistant text. Otherwise throw the error message or `assistant returned no text`. Retry this failure up to three attempts, call the injected/default wait function with 250 then 500 milliseconds between attempts, and call `log.error` once per failed attempt with the label, attempt, `session.state.model.provider/id`, and reason. Keep the prompt itself out of the log. Delegate `dispose()` to the wrapped session.

- [ ] **Step 4: Run the adapter test to verify it passes**

Run: `npm run --workspace=tutorial-engine test -- workbook-pi-tutor-session.test.ts`

Expected: PASS, three tests.

- [ ] **Step 5: Commit Task 1**

```bash
git add tutorial-engine/src/workbook/pi-tutor-session.ts tutorial-engine/test/workbook-pi-tutor-session.test.ts
git commit -m "feat: retry failed Pi tutor prompts"
```

### Task 2: Delegate main and block provider prompts to the shared adapter

**Files:**
- Modify: `tutorial-engine/src/workbook/tutor.ts`
- Modify: `tutorial-engine/src/workbook/block-tutor.ts`
- Modify: `tutorial-engine/test/workbook-tutor.test.ts`
- Modify: `tutorial-engine/test/workbook-block-tutor.test.ts`

**Interfaces:**
- Consumes `createResilientTutorSession` from Task 1.
- Produces unchanged `WorkbookTutorSession` and `WorkbookBlockTutorSession` public interfaces; callers still receive `prompt()` and `dispose()`.

- [ ] **Step 1: Write the failing delegation tests**

Add a small import-level test seam or use a fake Pi session factory to prove both factory paths use the shared adapter’s behavior without external model calls. The main-tutor test must show that a first terminal provider error does not reach `MainWorkbookTutor.reply()` when a subsequent attempt supplies text. The block-tutor test must show the same recovery for `FastWorkbookBlockTutor.hint()`. Use injected deterministic wait where necessary; do not wait in tests.

- [ ] **Step 2: Run the focused tutor tests to verify they fail**

Run: `npm run --workspace=tutorial-engine test -- workbook-tutor.test.ts workbook-block-tutor.test.ts`

Expected: FAIL because neither factory delegates its Pi session through the resilient adapter.

- [ ] **Step 3: Delegate both factories**

Remove the duplicated local `collectAssistantText` implementations in `tutor.ts` and `block-tutor.ts`. After each factory creates its Pi session, return the shared adapter with labels `Workbook tutor` and `Workbook block tutor`, respectively. Preserve all existing history/session lifecycle and the existing server public fallback.

- [ ] **Step 4: Run focused tests to verify they pass**

Run: `npm run --workspace=tutorial-engine test -- workbook-pi-tutor-session.test.ts workbook-tutor.test.ts workbook-block-tutor.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit Task 2**

```bash
git add tutorial-engine/src/workbook/tutor.ts tutorial-engine/src/workbook/block-tutor.ts tutorial-engine/test/workbook-tutor.test.ts tutorial-engine/test/workbook-block-tutor.test.ts
git commit -m "refactor: share resilient workbook tutor session"
```

### Task 3: Verify server failure behavior remains safe

**Files:**
- Modify: `tutorial-engine/test/workbook-server.test.ts` only if the existing failure fixture needs an assertion extension.

**Interfaces:**
- Consumes the unchanged server contract: model failures become a `tutor_failed` record with `TUTOR_UNAVAILABLE` and no private request identifier in the public timeline.
- Produces regression evidence that retries do not alter the learner-facing fallback.

- [ ] **Step 1: Write a focused failing regression assertion**

Extend the existing reply-failure test with an assertion that an exhausted tutor error still produces exactly the existing public message:

```ts
expect(failed.publicMessage).toBe("The tutor is temporarily unavailable. Please retry.");
expect(publicTimelineFailure).not.toHaveProperty("requestId");
```

The named break is a regression that exposes provider diagnostics to the learner or changes the safe fallback after the adapter is introduced.

- [ ] **Step 2: Run it to verify the assertion protects the public contract**

Run: `npm run --workspace=tutorial-engine test -- workbook-server.test.ts`

Expected: PASS if existing coverage already proves the contract; if it is green immediately, record it as characterization coverage and do not alter production code for this step.

- [ ] **Step 3: Run the complete tutorial-engine verification**

Run: `npm run --workspace=tutorial-engine check`

Expected: PASS: TypeScript check and all Vitest tests.

- [ ] **Step 4: Commit Task 3 only if it changed a test**

```bash
git add tutorial-engine/test/workbook-server.test.ts
git commit -m "test: preserve safe tutor failure response"
```
