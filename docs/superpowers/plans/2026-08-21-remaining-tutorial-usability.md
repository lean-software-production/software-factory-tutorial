# Remaining Tutorial Usability Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the legacy browser tutor easier to recover in, easier to scan, and clearer about the
quality check's expected non-zero exit.

**Architecture:** Keep all behavior local to the existing legacy browser transcript and Lesson 002
content. An error card places a fixed learner-facing explanation before the unchanged technical
message, which remains available in a native disclosure. A pure transcript partitioner places all
events through the latest resolved choice in a collapsed “Earlier steps” section, leaving the
current interaction visible. No event protocol, tutor, server, or lesson mechanism changes.

**Tech Stack:** TypeScript, React 19, native HTML `<details>`, Vite, Vitest, react-dom/server,
Markdown lesson blocks.

**Spec:** `docs/notes/2026-08-21.md`

## Global Constraints

- Change the legacy tutor at `tutorial-engine/web/`; do not change `web-workbook/`.
- Do not change `TutorialEvent`, `ChoiceManager`, `PiTutorialAdapter`, the local server, or tutor
  prompts.
- Preserve every transcript event and the exact raw error message; technical detail must remain
  available without becoming the first learner-facing sentence.
- Use native `<details>` and `<summary>` for archived transcript and technical detail so keyboard
  and screen-reader users can reach it without custom interaction code.
- The active/current transcript region, not archived history, retains `aria-live="polite"`.
- Keep Lesson 002's quality command unchanged: `(cd calculator && node scripts/quality.mjs)`.
- Lesson prose wraps at 100 columns and must describe the actual non-zero-exit mechanism.
- Add deterministic unit tests for new TypeScript behavior; the content-only lesson clarification
  needs source review plus the project check, not a new runtime test.

---

## File structure

| File | Responsibility |
| --- | --- |
| `tutorial-engine/web/src/error-card.tsx` | Render learner-facing error guidance, retry advice, and disclosed raw technical detail. |
| `tutorial-engine/web/src/transcript-history.ts` | Partition transcript events into archived and current interaction segments. |
| `tutorial-engine/web/src/main.tsx` | Use the new error card and partition the legacy transcript into archived and current regions. |
| `tutorial-engine/web/src/styles.css` | Style native disclosures and make the active transcript region visually distinct. |
| `tutorial-engine/test/error-card.test.tsx` | Assert error-card ordering, disclosure, and retry guidance. |
| `tutorial-engine/test/transcript-history.test.ts` | Assert deterministic transcript partitioning around the latest resolved choice. |
| `lessons/01-the-validation-loop/02-build-a-doer/blocks/check-the-doer.md` | Tell learners why the manual quality command exits non-zero while findings remain. |
| `docs/notes/2026-08-21.md` | Link the usability report to this implementation plan. |

## Task 1: Make raw tutor errors secondary

**Files:**
- Create: `tutorial-engine/web/src/error-card.tsx`
- Create: `tutorial-engine/test/error-card.test.tsx`
- Modify: `tutorial-engine/web/src/main.tsx:1-105`
- Modify: `tutorial-engine/web/src/styles.css`

**Interfaces:**
- Produces `ErrorCard({ event })`, where `event` is
  `Extract<TutorialEvent, { type: "tool-error" | "error" }>`.
- Consumes the existing `message` and `retryable` fields without transforming or suppressing them.
- Produces a learner-facing summary, optional retry guidance, and a `<details>` element whose
  `<summary>` is `Technical details` and whose body contains the raw `event.message`.

- [ ] **Step 1: Write the failing error-card rendering test.**

  Create `tutorial-engine/test/error-card.test.tsx` using `renderToStaticMarkup` from
  `react-dom/server`:

  ```tsx
  import { renderToStaticMarkup } from "react-dom/server";
  import { describe, expect, it } from "vitest";
  import { ErrorCard } from "../web/src/error-card.js";

  const message = "ENOENT: no such file or directory, lstat '/workspace/factory/refactor.md'";

  describe("ErrorCard", () => {
    it("leads with learner guidance and discloses the raw retryable error", () => {
      const html = renderToStaticMarkup(
        <ErrorCard event={{ type: "tool-error", toolId: "read-1", message, retryable: true }} />
      );

      expect(html.indexOf("The tutor could not complete that check yet.")).toBeLessThan(
        html.indexOf(message)
      );
      expect(html).toContain("You can retry or tell the coach what happened.");
      expect(html).toContain("<summary>Technical details</summary>");
      expect(html).toContain(message);
    });

    it("keeps technical detail but omits retry advice for a non-retryable error", () => {
      const html = renderToStaticMarkup(
        <ErrorCard event={{ type: "error", message: "Choice cancelled.", retryable: false }} />
      );

      expect(html).toContain("The tutor could not complete that check yet.");
      expect(html).toContain("Choice cancelled.");
      expect(html).not.toContain("You can retry or tell the coach what happened.");
    });
  });
  ```

- [ ] **Step 2: Run the focused test and confirm it fails.**

  Run:

  ```bash
  cd tutorial-engine && npm test -- error-card.test.tsx
  ```

  Expected: FAIL because `web/src/error-card.tsx` does not exist.

- [ ] **Step 3: Implement the minimal error card.**

  Create `tutorial-engine/web/src/error-card.tsx`:

  ```tsx
  import type { TutorialEvent } from "../../src/protocol/events.js";

  type ErrorEvent = Extract<TutorialEvent, { type: "tool-error" | "error" }>;

  export function ErrorCard({ event }: { event: ErrorEvent }) {
    return <article className="card error">
      <h2>Something needs attention</h2>
      <p>The tutor could not complete that check yet.</p>
      {event.retryable && <p className="muted">You can retry or tell the coach what happened.</p>}
      <details>
        <summary>Technical details</summary>
        <pre>{event.message}</pre>
      </details>
    </article>;
  }
  ```

  In `main.tsx`, import `ErrorCard` and replace the existing inline `tool-error` / `error` case
  with `<ErrorCard event={event} />`. Do not alter error-event emission or the generic card title.

  Add focused disclosure styling in `styles.css`:

  ```css
  .card.error details { margin-top: .75rem; }
  .card.error summary { cursor: pointer; color: #727067; }
  .card.error pre { margin: .5rem 0 0; overflow-wrap: anywhere; white-space: pre-wrap; }
  ```

- [ ] **Step 4: Run the focused test and confirm it passes.**

  Run:

  ```bash
  cd tutorial-engine && npm test -- error-card.test.tsx
  ```

  Expected: PASS with both retryable and non-retryable cases green.

- [ ] **Step 5: Commit the error presentation.**

  ```bash
  git add tutorial-engine/web/src/error-card.tsx tutorial-engine/web/src/main.tsx \
    tutorial-engine/web/src/styles.css tutorial-engine/test/error-card.test.tsx
  git commit -m "fix: lead tutor errors with learner guidance"
  ```

## Task 2: Collapse completed transcript steps

**Files:**
- Create: `tutorial-engine/web/src/transcript-history.ts`
- Create: `tutorial-engine/test/transcript-history.test.ts`
- Modify: `tutorial-engine/web/src/main.tsx:100-180`
- Modify: `tutorial-engine/web/src/styles.css`

**Interfaces:**
- Produces `partitionTranscript(events: readonly TranscriptEntry[]): {
  earlier: readonly TranscriptEntry[]; current: readonly TranscriptEntry[]
  }`, where `TranscriptEntry` is `Exclude<TutorialEvent, { type: "snapshot" }>`.
- Consumes the existing append-only transcript and treats the latest `choice-resolved` event as the
  end of archived history.
- Produces an empty `earlier` array when no choice has resolved; preserves event order and puts the
  resolved choice itself in `earlier`.

- [ ] **Step 1: Write failing partition tests.**

  Create `tutorial-engine/test/transcript-history.test.ts`:

  ```ts
  import { describe, expect, it } from "vitest";
  import { partitionTranscript, type TranscriptEntry } from "../web/src/transcript-history.js";

  const choice = (id: string): TranscriptEntry => ({
    type: "choice", id, question: "Continue?", options: [
      { id: "continue", label: "Continue", icon: "do" },
      { id: "pause", label: "Pause", icon: "pause" },
    ],
  });

  describe("partitionTranscript", () => {
    it("keeps all events current before a learner resolves a choice", () => {
      const events: TranscriptEntry[] = [{ type: "assistant-message", messageId: "m1", markdown: "Start." }, choice("c1")];
      expect(partitionTranscript(events)).toEqual({ earlier: [], current: events });
    });

    it("archives through the latest resolved choice", () => {
      const events: TranscriptEntry[] = [
        { type: "assistant-message", messageId: "m1", markdown: "Start." },
        choice("c1"),
        { type: "choice-resolved", id: "c1", optionId: "continue" },
        { type: "assistant-message", messageId: "m2", markdown: "Next step." },
      ];
      const { earlier, current } = partitionTranscript(events);
      expect(earlier.map((event) => event.type)).toEqual(["assistant-message", "choice", "choice-resolved"]);
      expect(current).toEqual([{ type: "assistant-message", messageId: "m2", markdown: "Next step." }]);
    });

    it("archives earlier turns when several choices have resolved", () => {
      const events: TranscriptEntry[] = [
        choice("c1"),
        { type: "choice-resolved", id: "c1", optionId: "continue" },
        choice("c2"),
        { type: "choice-resolved", id: "c2", optionId: "pause" },
        { type: "assistant-message", messageId: "m3", markdown: "Paused." },
      ];
      expect(partitionTranscript(events).earlier).toEqual(events.slice(0, 4));
      expect(partitionTranscript(events).current).toEqual(events.slice(4));
    });
  });
  ```

- [ ] **Step 2: Run the focused test and confirm it fails.**

  Run:

  ```bash
  cd tutorial-engine && npm test -- transcript-history.test.ts
  ```

  Expected: FAIL because `web/src/transcript-history.ts` does not exist.

- [ ] **Step 3: Implement the pure partitioner.**

  Create `tutorial-engine/web/src/transcript-history.ts`:

  ```ts
  import type { TutorialEvent } from "../../src/protocol/events.js";

  export type TranscriptEntry = Exclude<TutorialEvent, { type: "snapshot" }>;

  export function partitionTranscript(events: readonly TranscriptEntry[]): {
    earlier: readonly TranscriptEntry[];
    current: readonly TranscriptEntry[];
  } {
    let latestResolution = -1;
    events.forEach((event, index) => {
      if (event.type === "choice-resolved") latestResolution = index;
    });
    return latestResolution < 0
      ? { earlier: [], current: events }
      : { earlier: events.slice(0, latestResolution + 1), current: events.slice(latestResolution + 1) };
  }
  ```

- [ ] **Step 4: Render archived history and the active current region.**

  In `main.tsx`:

  1. Import `partitionTranscript`.
  2. Derive `const { earlier, current } = useMemo(() => partitionTranscript(events), [events]);`.
  3. Move `aria-live="polite"` from the outer `.transcript` section to a new
     `<section className="transcript-current" aria-label="Current step" aria-live="polite">`.
  4. Render non-empty `earlier` inside a closed native disclosure before that section:

     ```tsx
     {earlier.length > 0 && <details className="transcript-history">
       <summary>Earlier steps</summary>
       {earlier.map((event, index) => <TranscriptEvent
         key={`${event.type}-${index}`}
         event={event}
         send={send}
         disabled={!serverConnected}
         selectedOptionId={event.type === "choice" ? resolvedChoices.get(event.id) : undefined}
       />)}
     </details>}
     ```

  5. Render `current` inside `.transcript-current`, retaining each event's original global index by
     using `index + earlier.length` in its key. Keep `SessionStartCard`, server-stopped notice, and
     the working spinner in the current region.

  Add CSS that makes the boundary easy to scan without lowering text contrast:

  ```css
  .transcript-history { margin-bottom: 1rem; }
  .transcript-history > summary { cursor: pointer; color: #727067; font-weight: 700; }
  .transcript-history[open] { padding: .75rem; border: 1px solid #d9d7cf; border-radius: .75rem; }
  .transcript-current { display: grid; gap: 1rem; }
  ```

- [ ] **Step 5: Run focused tests and confirm they pass.**

  Run:

  ```bash
  cd tutorial-engine && npm test -- transcript-history.test.ts error-card.test.tsx
  ```

  Expected: PASS. The partition tests must prove that the current interaction remains visible after
  the latest resolution and that no-resolution transcripts are not collapsed.

- [ ] **Step 6: Perform a browser accessibility check.**

  Start the legacy tutor with a disposable session. Make one choice and wait for the next prompt.
  Verify all of the following in Chromium:

  - `Earlier steps` is closed by default and can be opened with the keyboard.
  - The next prompt remains visible without opening history.
  - A screen reader's polite live region is the `Current step` section, not the archived disclosure.
  - Opening history reveals the complete earlier cards, including their disabled resolved choices.

- [ ] **Step 7: Commit transcript grouping.**

  ```bash
  git add tutorial-engine/web/src/transcript-history.ts tutorial-engine/web/src/main.tsx \
    tutorial-engine/web/src/styles.css tutorial-engine/test/transcript-history.test.ts
  git commit -m "fix: collapse completed tutor steps"
  ```

## Task 3: Explain the quality check's expected exit status

**Files:**
- Modify: `lessons/01-the-validation-loop/02-build-a-doer/blocks/check-the-doer.md:1-25`
- Modify: `docs/notes/2026-08-21.md`

**Interfaces:**
- Keeps the existing manual quality command unchanged.
- Produces one learner-facing sentence immediately after that command explaining that findings cause
  the non-zero exit and that this does not mean the command failed.

- [ ] **Step 1: Add the explicit exit-status explanation.**

  Immediately after the block containing `(cd calculator && node scripts/quality.mjs)`, add this
  paragraph, wrapped at 100 columns:

  ```markdown
  A non-zero exit is expected while findings remain; the exit status says findings exist, not that
  the command failed.
  ```

  Do not add `|| true` to this manual check. The learner needs to see that quality findings differ
  from a broken command.

- [ ] **Step 2: Link the usability note to this plan.**

  In `docs/notes/2026-08-21.md`, after the low-priority finding's recommendation, add:

  ```markdown
  Implementation plan: [remaining tutorial usability improvements](../superpowers/plans/2026-08-21-remaining-tutorial-usability.md).
  ```

- [ ] **Step 3: Verify the content and run the project check.**

  Run:

  ```bash
  rg -n -F "A non-zero exit is expected while findings remain" \
    lessons/01-the-validation-loop/02-build-a-doer/blocks/check-the-doer.md
  npm run check
  ```

  Expected: `rg` prints the new lesson line and `npm run check` exits 0.

- [ ] **Step 4: Commit the lesson clarification and report link.**

  ```bash
  git add lessons/01-the-validation-loop/02-build-a-doer/blocks/check-the-doer.md \
    docs/notes/2026-08-21.md
  git commit -m "docs: clarify quality findings exit status"
  ```

## Task 4: Verify the complete learner flow

**Files:**
- Modify: none expected.

**Interfaces:**
- Verifies the legacy web build consumes the unchanged event protocol and serves all three usability
  improvements together.

- [ ] **Step 1: Run focused browser-UI tests.**

  Run:

  ```bash
  cd tutorial-engine && npm test -- error-card.test.tsx transcript-history.test.ts \
    choice-card.test.tsx choice-state.test.ts
  ```

  Expected: PASS. This includes prior resolved-choice coverage so the new transcript grouping does
  not regress the completed-choice behavior.

- [ ] **Step 2: Run the full project check and production web build.**

  Run:

  ```bash
  npm run check
  cd tutorial-engine && npm run build:web
  ```

  Expected: both commands exit 0. The existing Vite chunk-size warning is informational unless the
  build exits non-zero.

- [ ] **Step 3: Run an exploratory browser confirmation.**

  In a disposable legacy tutor session:

  1. Choose an option, then verify its completed turn moves under closed `Earlier steps` while the
     next instruction remains visible.
  2. Open `Earlier steps` and verify the selected option is shown and its buttons remain disabled.
  3. Trigger a safe retryable error by reporting `factory/refactor.md` complete before creating it.
     Verify the primary card contains learner guidance and retry advice; expand `Technical details`
     and verify the raw `ENOENT` text is present.
  4. Follow Lesson 002 through the manual quality command and verify the expected non-zero exit is
     explained immediately beside that command.

- [ ] **Step 4: Commit only an evidence correction, if one was required.**

  If verification reveals and corrects a test or documentation mistake, commit those exact files:

  ```bash
  git add tutorial-engine/test/error-card.test.tsx \
    tutorial-engine/test/transcript-history.test.ts \
    docs/notes/2026-08-21.md \
    lessons/01-the-validation-loop/02-build-a-doer/blocks/check-the-doer.md
  git commit -m "test: verify tutor usability improvements"
  ```

  If no correction was needed, make no additional commit.

## Plan self-review

- **Spec coverage:** Task 1 turns raw technical errors into secondary detail; Task 2 makes completed
  history collapsible while preserving its audit trail and an accessible active region; Task 3
  clarifies the manual quality command's exit mechanism; Task 4 checks their combined learner flow.
- **Placeholder scan:** The plan specifies every new API, string, command, test case, and file path.
- **Type consistency:** `ErrorCard` consumes existing error-event fields without protocol changes;
  `partitionTranscript()` consumes `TutorialEvent[]` and produces the two arrays `main.tsx` renders.
