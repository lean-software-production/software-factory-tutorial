# Compact Workbook Terminal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the active terminal a compact work surface that leaves the learning timeline visible, while moving the deterministic command-insertion action into its authored timeline entry.

**Architecture:** The activity band remains the owner of the live terminal WebSocket and its ephemeral observer state. It publishes a temporary command-insertion callback to `App`; the active authored timeline entry invokes that callback without executing the command. The terminal band renders only the terminal, an accessible blue/red connection indicator, and a single replace-in-place feedback region.

**Tech Stack:** React 19, TypeScript, xterm.js, Vitest, CSS.

**Spec:** `docs/superpowers/specs/2026-08-21-workbook-conversational-timeline-design.md` plus the chat-approved bounded design of 2026-08-24.

## Global Constraints

- Remove “Get a hint”; learners ask durable questions through the fixed tutor composer.
- Remove terminal-practice headings, explanatory security/transcript copy, terminal status sentences, and the embedded-terminal header.
- The active desktop terminal is 180px high; its only persistent connection UI is a blue dot when connected and a red dot when disconnected, with an accessible label.
- Show one transient block-tutor feedback panel beneath the terminal only when there is an observer status, advice, error, or persisted checkpoint feedback; the newest value replaces the old value and is not a timeline record.
- The authored timeline entry for the active terminal block exposes “Do it for me” whenever the block has an eligible shell command. The action inserts its existing deterministic, single-line command into the connected terminal and never sends Enter.
- Ordinary composer messages and tutor replies remain durable timeline records.
- Preserve existing accepted/frozen terminal evidence and terminal error behaviour.

---

## File structure

- `tutorial-engine/web-workbook/src/workbook-ui.tsx` owns terminal connection state, compact terminal rendering, feedback precedence, and the callback bridge from the activity band to `App` and the timeline.
- `tutorial-engine/web-workbook/src/activity-band.tsx` removes hint state/UI and forwards the active terminal command callback.
- `tutorial-engine/web-workbook/src/timeline-thread.tsx` renders the active authored block’s persistent “Do it for me” action and its inserted confirmation.
- `tutorial-engine/web-workbook/src/styles.css` defines the compact band, 180px terminal, dot-only status affordance, transient feedback region, and timeline action styling.
- `tutorial-engine/test/workbook-ui.test.tsx` verifies static markup and mounted action semantics.
- `tutorial-engine/test/workbook-conversation-layout.test.tsx` verifies the sticky activity/timeline contract without a hint control.
- `tutorial-engine/test/browser-smoke.mts` updates only selectors made obsolete by removed terminal headings.

### Task 1: Compact terminal band and authored command action

**Files:**
- Modify: `tutorial-engine/web-workbook/src/workbook-ui.tsx:93-167, 246-260, 553-559`
- Modify: `tutorial-engine/web-workbook/src/activity-band.tsx:1-32`
- Modify: `tutorial-engine/web-workbook/src/timeline-thread.tsx:25-93`
- Modify: `tutorial-engine/web-workbook/src/styles.css:18-20, 24`
- Modify: `tutorial-engine/test/workbook-ui.test.tsx:500-525, 755-772, 1142-1187`
- Modify: `tutorial-engine/test/workbook-conversation-layout.test.tsx:29-51`
- Modify: `tutorial-engine/test/browser-smoke.mts:111-116`

**Interfaces:**
- Consumes: `shellCommandFrom(markdown): string | undefined` and `commandForInsertion(command): string` in `workbook-ui.tsx`; `EmbeddedTerminal` remains the sole component that writes terminal input bytes.
- Produces: an optional active-terminal insertion callback from `ActivityBand` to `App`, and an optional `onDoItForMe` callback from `App` to `TimelineThread`.
- Rule: the callback sends `commandForInsertion(command)` only when the terminal WebSocket is open. It must not append `\r` or `\n`.

- [ ] **Step 1: Write failing static-render tests for the new contract**

  In `workbook-conversation-layout.test.tsx`, replace the hint expectation with assertions that the activity band has no `Get a hint` text and that the composer remains present. In `workbook-ui.test.tsx`, replace expectations for `Embedded terminal`, its explanatory text, and `Get a hint` with assertions for:

  ```ts
  expect(markup).toContain('class="terminal-connection-status connected"');
  expect(markup).toContain('aria-label="Terminal connected"');
  expect(markup).not.toContain("Terminal practice");
  expect(markup).not.toContain("Run this in the embedded terminal");
  expect(markup).not.toContain("Observed by the tutor");
  expect(markup).not.toContain("Get a hint");
  ```

  Add a `TimelineThread` test whose active authored terminal record receives `onDoItForMe={vi.fn()}` and asserts exactly one `Do it for me` button. Assert a non-active authored record and a thread without that callback do not render the action.

- [ ] **Step 2: Run the focused tests and verify they fail**

  Run:

  ```bash
  cd tutorial-engine && npm run test -- test/workbook-ui.test.tsx test/workbook-conversation-layout.test.tsx
  ```

  Expected: failures identify the obsolete terminal chrome and missing timeline action.

- [ ] **Step 3: Make the terminal band compact and publish its insertion action**

  Remove `onHint`, its pending state, and `activity-assist` rendering from `ActivityBand`. Add an optional callback registration prop that receives the active terminal’s insertion function or `undefined` on cleanup/block change.

  In `EmbeddedTerminal`, replace the textual terminal header with one status element:

  ```tsx
  <span
    className={`terminal-connection-status${connected ? " connected" : ""}`}
    aria-label={connected ? "Terminal connected" : "Terminal disconnected"}
  />
  ```

  Register `insertCommand` only while the command exists and the WebSocket is connected. Keep `insertCommand`’s current use of `commandForInsertion`; do not change the WebSocket message type or append an Enter key. Remove its in-terminal button and note.

  In `TerminalBlock`, remove the `.mode`, `.mode-head`, tag, title, and explanatory paragraph for active and static terminal rendering. Consolidate observer status, advice, error, and nonaccepted checkpoint feedback into one `live-block-feedback` element. Render it only when a value exists; use the newest observer advice/error first, then observer status, then persisted checkpoint feedback. Do not create a timeline record from this state.

  In `App`, retain the currently registered terminal insertion callback in React state and pass it to `TimelineThread`. Clear it when the active activity unregisters or changes.

- [ ] **Step 4: Render the persistent authored-timeline action**

  Add optional `onDoItForMe?: () => void` to `TimelineThread`. For the active authored course record only, render:

  ```tsx
  <button className="button primary timeline-do-it" onClick={onDoItForMe}>
    Do it for me
  </button>
  ```

  Keep the button in the authored timeline entry, not the sticky terminal band. Track a local confirmation state and replace the label with `Inserted — press Enter` after invocation; reset it when the active lesson or block changes. Do not render the button if there is no active insertion callback.

- [ ] **Step 5: Apply the compact visual layout**

  Replace the terminal header/action-row rules with a dot positioned in the terminal panel’s top-right corner. Use blue (`var(--blue)`) for `.terminal-connection-status.connected` and red (`var(--red)`) otherwise. Set `.embedded-terminal { height: 180px; }` on desktop. Give `.current-activity-band` smaller vertical padding and preserve its sticky background/shadow. Style `.live-block-feedback` as the sole short panel below the terminal; it must disappear entirely when there is no message. Keep the existing mobile minimum-height override usable and remove CSS used only by `.activity-assist`, `.get-hint`, `.embedded-terminal-head`, `.status`, and `.terminal-note`.

- [ ] **Step 6: Add an interaction test for insertion without Enter**

  In the existing mounted terminal tests in `workbook-ui.test.tsx`, provide a fake open WebSocket, click `Do it for me`, and assert the sent terminal input has the command’s newline continuations flattened but does not contain `\r` or `\n`. Assert the button text becomes `Inserted — press Enter`. Assert the action is unavailable after the WebSocket closes.

- [ ] **Step 7: Update the browser smoke selector and run verification**

  Change the smoke test’s terminal heading wait from the removed `Embedded terminal` text to `[aria-label="Terminal disconnected"]` or `[aria-label="Terminal connected"]`, whichever its mocked connection makes deterministic. Then run:

  ```bash
  cd tutorial-engine && npm run test -- test/workbook-ui.test.tsx test/workbook-conversation-layout.test.tsx
  npm run check
  npm run build
  ```

  Expected: all commands exit 0.

- [ ] **Step 8: Self-review and commit**

  Inspect the staged diff for any residual `Get a hint`, removed header copy, or terminal-local insert action in the active terminal path. Commit:

  ```bash
  git add tutorial-engine/web-workbook/src/activity-band.tsx tutorial-engine/web-workbook/src/timeline-thread.tsx tutorial-engine/web-workbook/src/workbook-ui.tsx tutorial-engine/web-workbook/src/styles.css tutorial-engine/test/workbook-ui.test.tsx tutorial-engine/test/workbook-conversation-layout.test.tsx tutorial-engine/test/browser-smoke.mts
  git commit -m "feat: compact workbook terminal activity"
  ```
