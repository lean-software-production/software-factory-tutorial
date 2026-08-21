# Disable Resolved Tutorial Choices Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve each choice in the web tutor transcript while making it non-interactive immediately
when the matching `choice-resolved` event is received, and show the learner's selected option.

**Architecture:** The browser already receives an append-only transcript containing `choice` and
`choice-resolved` events. Derive a choice-ID-to-selected-option map from that transcript in a small,
pure web helper. Pass the matching selection into each choice card; the card disables its buttons
and renders a compact selected-state message. The `ChoiceManager` and server event protocol remain
unchanged.

**Tech Stack:** TypeScript, React 19, Vite, Vitest, react-dom/server.

**Spec:** `docs/notes/2026-08-21.md`

## Global Constraints

- Do not remove or collapse past choice cards; the transcript remains an auditable record.
- Do not change `ChoiceManager`, `PiTutorialAdapter.choose()`, or the `choice` / `choice-resolved`
  protocol shapes.
- A locally clicked option must disable its card before the server response arrives.
- A streamed or restored `choice-resolved` event must disable its matching historic card even after
  a reload.
- Keep the existing “This was a choice from the saved session.” message for `historical` choices.
- Add deterministic unit tests; do not require a live Pi model or browser for the new coverage.

---

## File structure

| File | Responsibility |
| --- | --- |
| `tutorial-engine/web/src/choice-state.ts` | Derive resolved choice selections from transcript events without mutating the transcript. |
| `tutorial-engine/web/src/choice-card.tsx` | Render a choice card, disable resolved cards, and display the selected label. |
| `tutorial-engine/web/src/main.tsx` | Derive selections once per transcript update and pass each choice's selection to its card. |
| `tutorial-engine/test/choice-state.test.ts` | Verify derivation for unresolved, resolved, and unrelated events. |
| `tutorial-engine/test/choice-card.test.tsx` | Verify rendered enabled, locally selected, resolved, and restored-choice states. |

## Task 1: Derive immutable choice-resolution state

**Files:**
- Create: `tutorial-engine/web/src/choice-state.ts`
- Create: `tutorial-engine/test/choice-state.test.ts`

**Interfaces:**
- Produces `resolvedChoiceSelections(events: readonly TutorialEvent[]): ReadonlyMap<string, string>`.
- Consumes the existing `choice-resolved` event shape `{ type: "choice-resolved"; id: string; optionId: string }`.
- Produces a map used by the transcript renderer; an absent key means that choice is still pending.

- [ ] **Step 1: Write the failing state-derivation tests.**

  Create `tutorial-engine/test/choice-state.test.ts` with these cases:

  ```ts
  import { describe, expect, it } from "vitest";
  import { resolvedChoiceSelections } from "../web/src/choice-state.js";
  import type { TutorialEvent } from "../src/protocol/events.js";

  const choice: TutorialEvent = {
    type: "choice",
    id: "choice-1",
    question: "Continue?",
    options: [
      { id: "continue", label: "Continue", icon: "do" },
      { id: "pause", label: "Pause", icon: "pause" },
    ],
  };

  describe("resolvedChoiceSelections", () => {
    it("leaves an unresolved choice absent", () => {
      expect(resolvedChoiceSelections([choice]).has("choice-1")).toBe(false);
    });

    it("records the option selected for its matching choice", () => {
      expect(resolvedChoiceSelections([
        choice,
        { type: "choice-resolved", id: "choice-1", optionId: "continue" },
      ]).get("choice-1")).toBe("continue");
    });

    it("ignores resolutions for other choices", () => {
      expect(resolvedChoiceSelections([
        choice,
        { type: "choice-resolved", id: "choice-2", optionId: "pause" },
      ]).has("choice-1")).toBe(false);
    });
  });
  ```

- [ ] **Step 2: Run the focused test and confirm it fails.**

  Run:

  ```bash
  cd tutorial-engine && npm test -- choice-state.test.ts
  ```

  Expected: FAIL because `web/src/choice-state.ts` does not exist.

- [ ] **Step 3: Implement the pure derivation helper.**

  Create `tutorial-engine/web/src/choice-state.ts`:

  ```ts
  import type { TutorialEvent } from "../../src/protocol/events.js";

  export function resolvedChoiceSelections(events: readonly TutorialEvent[]): ReadonlyMap<string, string> {
    const selections = new Map<string, string>();
    for (const event of events) {
      if (event.type === "choice-resolved") selections.set(event.id, event.optionId);
    }
    return selections;
  }
  ```

  Do not modify event objects or add resolution state to the server protocol.

- [ ] **Step 4: Run the focused test and confirm it passes.**

  Run:

  ```bash
  cd tutorial-engine && npm test -- choice-state.test.ts
  ```

  Expected: PASS with all three assertions green.

- [ ] **Step 5: Commit the pure state helper and its tests.**

  ```bash
  git add tutorial-engine/web/src/choice-state.ts tutorial-engine/test/choice-state.test.ts
  git commit -m "feat: derive resolved tutorial choices"
  ```

## Task 2: Render resolved choice cards as completed

**Files:**
- Create: `tutorial-engine/web/src/choice-card.tsx`
- Create: `tutorial-engine/test/choice-card.test.tsx`
- Modify: `tutorial-engine/web/src/main.tsx:1-82`

**Interfaces:**
- Produces `ChoiceCard(props)` with `event`, `send`, `disabled`, and optional `selectedOptionId` props.
- Consumes a selected option ID from `resolvedChoiceSelections()`.
- Produces disabled buttons for local selection, saved-session history, and resolved transcript choices.
- Produces `Selected: <label>` only when the matching selected option is declared on the card.

- [ ] **Step 1: Write the failing card-rendering tests.**

  Create `tutorial-engine/test/choice-card.test.tsx`. Use `renderToStaticMarkup` from
  `react-dom/server`, a no-op `send`, and this event fixture:

  ```tsx
  const event = {
    type: "choice" as const,
    id: "choice-1",
    question: "Continue?",
    options: [
      { id: "continue", label: "Continue", icon: "do" as const },
      { id: "pause", label: "Pause", icon: "pause" as const },
    ],
  };
  ```

  Assert all of the following:

  ```tsx
  expect(renderToStaticMarkup(
    <ChoiceCard event={event} disabled={false} send={() => {}} />
  )).not.toContain("disabled=\"\"");

  const resolved = renderToStaticMarkup(
    <ChoiceCard event={event} selectedOptionId="continue" disabled={false} send={() => {}} />
  );
  expect(resolved.match(/disabled=\"\"/g)).toHaveLength(2);
  expect(resolved).toContain("Selected: Continue");

  const historical = renderToStaticMarkup(
    <ChoiceCard event={{ ...event, historical: true }} disabled={false} send={() => {}} />
  );
  expect(historical).toContain("This was a choice from the saved session.");
  expect(historical.match(/disabled=\"\"/g)).toHaveLength(2);
  ```

- [ ] **Step 2: Run the focused test and confirm it fails.**

  Run:

  ```bash
  cd tutorial-engine && npm test -- choice-card.test.tsx
  ```

  Expected: FAIL because `web/src/choice-card.tsx` does not exist.

- [ ] **Step 3: Extract and implement `ChoiceCard`.**

  Move the choice-card markup and its local `chosen` state from `web/src/main.tsx` into
  `web/src/choice-card.tsx`. Keep the existing button content and click behavior. Add:

  ```tsx
  type ChoiceCardProps = {
    event: Extract<TutorialEvent, { type: "choice" }>;
    send: (message: BrowserMessage) => void;
    disabled: boolean;
    selectedOptionId?: string;
  };

  const selected = event.options.find((option) => option.id === selectedOptionId);
  const resolved = selectedOptionId !== undefined;
  const unavailable = disabled || event.historical || resolved || Boolean(chosen);
  ```

  Apply `unavailable` to every option button. Render `<p className="muted">Selected: {selected.label}</p>`
  after the options only when `selected` exists. Keep the existing saved-session message unchanged.

  The extracted component may render the same `<article className="card choice">` structure directly;
  do not change CSS or button labels.

- [ ] **Step 4: Wire transcript-derived selections into the app.**

  In `tutorial-engine/web/src/main.tsx`:

  1. Import `resolvedChoiceSelections` and `ChoiceCard`.
  2. Add `const resolvedChoices = useMemo(() => resolvedChoiceSelections(events), [events]);` in `App`.
  3. Extend `TranscriptEvent` with `selectedOptionId?: string` and pass it to `ChoiceCard`.
  4. In the transcript `events.map`, pass `resolvedChoices.get(event.id)` only when
     `event.type === "choice"`; pass `undefined` for every other event.
  5. Remove the in-file `ChoiceCard` definition and no-longer-needed `ChoiceIcon` import.

  This makes the card re-render disabled when a streamed `choice-resolved` event is appended, while
  the existing local `chosen` state prevents a double click before that event arrives.

- [ ] **Step 5: Run focused tests and confirm they pass.**

  Run:

  ```bash
  cd tutorial-engine && npm test -- choice-state.test.ts choice-card.test.tsx
  ```

  Expected: PASS. The card test must prove that a resolved selection renders two disabled buttons
  and its selected label.

- [ ] **Step 6: Commit the transcript rendering change.**

  ```bash
  git add tutorial-engine/web/src/choice-card.tsx tutorial-engine/web/src/main.tsx \
    tutorial-engine/test/choice-card.test.tsx
  git commit -m "fix: disable resolved tutorial choices"
  ```

## Task 3: Verify the production web build and full test suite

**Files:**
- Modify: none expected.

**Interfaces:**
- Verifies the existing browser protocol and tutorial-engine test suite still consume the unchanged
  choice event protocol.

- [ ] **Step 1: Run the complete tutorial-engine check.**

  Run:

  ```bash
  cd tutorial-engine && npm run check
  ```

  Expected: PASS with TypeScript compilation successful and all Vitest tests green.

- [ ] **Step 2: Build the production tutor web bundle.**

  Run:

  ```bash
  cd tutorial-engine && npm run build:web
  ```

  Expected: PASS and emit the Vite web bundle without TypeScript or import errors.

- [ ] **Step 3: Manually verify the original failure mode.**

  In a disposable tutorial session, make a choice, wait until the next prompt appears, and inspect
  the completed card. Its option buttons must be disabled and it must show `Selected: <option>`.
  Click neither option: the disabled state is the prevention. Resume the session and confirm saved
  choices remain disabled and retain the existing saved-session message.

- [ ] **Step 4: Commit verification-only follow-up if it introduced a test correction.**

  If verification changed test files, commit only those changes:

  ```bash
  git add tutorial-engine/test/choice-state.test.ts tutorial-engine/test/choice-card.test.tsx
  git commit -m "test: cover resolved tutorial choices"
  ```

  If verification required no source change, make no additional commit.

## Plan self-review

- **Spec coverage:** Task 1 derives selection state without protocol changes; Task 2 disables completed
  cards immediately and on replay while preserving the full transcript; Task 3 verifies the build,
  full suite, and the reported browser flow.
- **Placeholder scan:** No TBDs or unspecified implementation steps remain.
- **Type consistency:** `resolvedChoiceSelections()` returns the optional `selectedOptionId` consumed
  by `ChoiceCard`; both use the existing event `id` and `optionId` names.
