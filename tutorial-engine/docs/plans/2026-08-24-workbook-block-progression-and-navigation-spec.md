# Workbook block progression and navigation specification

## Status

Approved for implementation — 2026-08-24

## Purpose

The workbook currently treats the introduction as a special case. Its button writes an introduction
completion event directly, while a learner message to the tutor is only conversation. Part and lesson
preambles are timeline messages rather than navigation targets. Progression, reading location, and
tutor authority therefore use different models.

This specification makes every ordered unit a **block**. A block may be structural, implied by the
workbook structure, or declared by a lesson. Every revealed block has one identity, DOM anchor, and
place in the ordered workbook. One completion operation moves the learner forward; buttons, scroll
sentinels, and the tutor use that same operation.

## Goals

- Treat workbook, Part, and lesson preambles as blocks alongside lesson-declared blocks.
- Give every revealed block a stable, shareable anchor and one navigation path.
- Complete a block only through a validated, durable, idempotent server operation.
- Let a learner continue with a button, deliberate scroll, or the tutor.
- Keep the rail as the existing curriculum roadmap while blocks emerge as authored material.
- Keep normal tests deterministic and use the existing paid live-evaluation command for model behaviour.

## Non-goals

- Support sessions created before this development-stage change. Delete `.tutorial/.tmp` and start a
  new session instead.
- Rewind curriculum progress through Back, Forward, or sidebar navigation.
- Let the tutor bypass an evaluated block's evidence requirement.
- Make passive scrolling create browser-history entries.
- Specify phone layout or implement the eventual completion fireworks.

## Block model

A block is a bounded unit in the ordered workbook. Do not introduce a class hierarchy or a strategy
framework. Model blocks as a small discriminated TypeScript union and use pure policy functions for
eligibility, successor selection, and summarisation.

```ts
type Block = StructuralBlock | DeclaredBlock;

type StructuralBlock = {
  origin: "structural";
  kind: "workbook-introduction" | "part-preamble" | "lesson-preamble";
  id: BlockId;
};

type DeclaredBlock = {
  origin: "declared";
  kind: "narrative" | "terminal-practice" | "editor-practice" | "reflection" | "lesson-transition";
  id: BlockId;
  // Existing authored content and type-specific fields.
};
```

The loader derives structural blocks from the existing manifests; it does not create duplicate
curriculum files. Its ordered stream is:

```text
workbook introduction
→ each Part preamble
→ each lesson preamble in that Part
→ that lesson's declared blocks in order
→ next lesson or Part preamble
→ workbook complete
```

A declared lesson transition remains a normal declared block, before the next structural preamble.
The public projection exposes the current block, completed blocks, revealed authored material, and an
authoritative `canComplete` status for the current block. Continue visibility, sentinel arming, and tool
availability all use that server-projected status; clients never infer practice eligibility themselves.
The server decides what is current and what succeeds it.

## Block identity and anchors

One workbook-anchor module owns block identity, fragment construction, DOM IDs, and fragment lookup.
The loader, server, timeline, sidebar, and browser all use that module. They do not reimplement anchor
rules.

Block IDs and DOM IDs omit `#`; a URL fragment is `#` plus an anchor ID. `--` separates components, and
every source-ID component must be lowercase kebab case without `--` so IDs cannot collide:

```text
BlockId / DOM id                         URL fragment
workbook--introduction                   #workbook--introduction
part--validation-loop                    #part--validation-loop
lesson--001-run-an-agent-headlessly      #lesson--001-run-an-agent-headlessly
lesson--001-run-an-agent-headlessly--orientation
                                         #lesson--001-run-an-agent-headlessly--orientation
workbook--complete                       #workbook--complete
```

A Part or lesson ID identifies its implied preamble. A final component identifies a block declared inside
its lesson. `workbook--complete` is an anchor ID and navigation target, not a completable `BlockId`.
Renaming display prose does not change an ID or fragment.

## Completing a block

`completeBlock(blockId)` is the sole progression command. The caller supplies the exact block it saw;
the server never completes whatever happens to be current when it receives a request.

Within the serialized workbook transaction, the server confirms that `blockId` is current and eligible,
appends one generic block-completion workflow event, reveals the successor's authored material if needed,
and returns one of these results:

```ts
type CompleteBlockResult =
  | { outcome: "completed"; state: PublicState; navigationTarget: AnchorId }
  | { outcome: "already-completed"; state: PublicState }
  | { outcome: "rejected"; state: PublicState; reason: "unrevealed" | "not-current" | "ineligible" };
```

A repeated request for an already completed block is a silent no-op: it appends no event and causes no
navigation. A rejected request does not change state. The UI normally prevents a learner from making a
rejected request; it reconciles quietly if a stale client nevertheless receives one. For evaluated blocks,
only the server decides whether accepted evidence makes completion eligible.

Structural blocks never trigger model compaction. Their conversation remains durable in the learner
timeline and is carried unchanged in later tutor context. Declared blocks retain their existing
compaction policy.

## Completion inputs

Every eligible active block offers the same three ways forward.

### Continue

The active block region renders its Continue control only when the server would accept completion.
The workbook introduction keeps the learner-facing label **Ready to continue**. It is only a labelled
Continue control; it has no special event or route.

### Deliberate scroll

Every eligible active block has a systematic page-break after its region footer, followed by its end
sentinel. The spacer keeps the sentinel below the usable viewport after the block has been navigated to.
The observer arms only after the active block has reached the reading line. A short newly rendered block
therefore cannot cascade into completion: the learner must deliberately scroll down through its
page-break to reach the sentinel.

When the learner deliberately scrolls to the sentinel, the client calls `completeBlock(blockId)`. A
newly accepted practice or reflection block gains this same scroll path; before acceptance, its sentinel
is not armed. The button and tutor tool remain available alternatives.

### Tutor tool

The main tutor has a structured `completeBlock(blockId)` tool only for an eligible current block. Its
schema constrains `blockId` to that one block's ID. Its instruction permits the call only after explicit
learner intent to move on. The server remains the hard boundary: the tool cannot skip, reopen, or
prematurely complete work.

A successful tool call returns the ordinary completion result to the browser, which renders the successor
and navigates to it. The tool call is terminal for that tutor turn: discard generated text before or after
it, do not persist it as a message, and do not replay it into later tutor context. The next authored block
is the learner-visible response.

A message such as “Let’s go”, “carry on”, or “I’m ready to continue” is expected to select the tool.
“What’s next?” is a question: the tutor answers briefly but does not advance.

## The active-block region and work surfaces

The active block is one scroll region containing, in order:

1. its authored material;
2. its live terminal or editor, when present;
3. every learner and tutor message associated with that active block; and
4. its eligible Continue control, page-break, and sentinel.

New chat messages extend the region and move its Continue footer down. The composer and new messages
always remain at the bottom of the evolving workbook canvas; rereading an old block never retargets the
conversation there.

A terminal or editor begins inline beneath its authored instructions. It is the live work surface, not
the whole block, that becomes sticky. As the learner scrolls down to it, it grows modestly wider and
taller than the narrative column, then remains sticky within the active-block region while tutor
conversation scrolls nearby. It releases when the learner scrolls back above the work surface or when
the block completes. Reading-location tracking uses the block region's anchor and bounds, never the
sticky child surface.

The expanded surface is capped below the main-pane width and at roughly half the usable viewport height,
leaving room to read and message the tutor. Its terminal/editor content remains high-contrast and
substantially opaque. A surrounding card or border may be translucent to convey document motion; do not
use blur. Reduced-motion users receive the same final layout without the expansion animation.

When an editable active terminal or editor enters the usable reading area on a downward scroll, focus it
automatically once for that entry. Do not refocus it for layout changes, historical/frozen surfaces, or
repeated observer callbacks. Phone-specific behaviour is deferred.

## Conversation context

The fixed composer always addresses the active block, or the completion panel after the workbook ends.
It never retargets to a historical block merely because the learner is rereading it.

When a learner sends a message, snapshot the canonical block visible at the reading line as non-rendered
`blockInView` message metadata. Preserve it through restart and provide it to the tutor as context. It
does not change message routing, completion eligibility, progress, or tool authority.

## Navigation and history

`navigateToAnchor(anchorId, mode)` resolves a revealed DOM anchor, scrolls it to the reading position,
and applies the requested history mode after the target has rendered.

| Cause | Mode | Result |
| --- | --- | --- |
| Successful completion | `push` | Push successor fragment, then scroll to it |
| Sidebar selection | `push` | Push selected fragment, then scroll to it |
| Passive reading | `replace` | Replace current fragment with the reading block |
| Initial URL without a fragment | `replace` | Scroll to active work and replace with its fragment |
| Initial valid URL, Back, or Forward | `none` | Scroll only; do not write history |

The reading location is the last revealed block to cross a fixed line just below the usable viewport top.
Passive tracking waits briefly for scrolling to settle before calling `replaceState`. Replacing the current
entry after a learner scrolls back is intentional: the address bar names what they are reading, without
creating a history entry for ordinary scrolling.

Completion and sidebar clicks are deliberate navigation, so they use `pushState`. Back and Forward move
only the reading location. They never rewind progress, reactivate a completed block, or reveal future
material. While a programmatic or `popstate` scroll settles, suppress passive replacement so it does not
overwrite the selected history entry.

A malformed or unrevealed deep link opens a modal:

> The lesson you're linking to is not ready yet — you still have some work to do!

Its **OK** button leaves progress unchanged, scrolls to the active block, and replaces the URL with that
block's canonical fragment.

## Sidebar

Preserve the existing rail contract:

- It always shows the full curriculum, grouped by Part.
- Future lessons remain visible disabled roadmap entries; they have no rendered content or navigation
  target.
- A revealed Part entry targets its Part preamble anchor.
- A revealed lesson entry targets its lesson preamble anchor.
- Only the emerged lesson in view opens a local outline, and that outline contains only its emerged
  declared blocks. Future blocks do not appear veiled, disabled, or focusable.

The sidebar uses canonical anchor links and `navigateToAnchor(anchorId, "push")`; it is not a separate
navigation system. It visually highlights the reading location. It separately but quietly marks the
active work, without a clutter of explanatory labels or controls. Expose the same distinction
semantically: navigation location and progress must not be represented as the same current state.

For a sidebar click or explicit Continue, move keyboard focus to the new block heading. A
scroll-sentinel completion does not move focus. Tutor-triggered completion keeps focus in the composer
and announces the new authored block politely, unless an editable work surface later receives its
automatic focus on entry.

## Completion panel

The final instructional block completes the workbook and navigates to the terminal, non-completable
`#workbook--complete` panel. The workbook is complete before the tutor is asked for its congratulatory
summary. If that request fails, show a retryable failure in the panel; never reopen the final block.

The panel contains the eventual celebratory treatment and the tutor's summary of what the learner
achieved. It is also the terminal conversation region: post-completion learner and tutor messages append
there above the fixed composer. Fireworks are deliberately deferred.

## Failure recovery

A completion request can time out after the server writes its event. Before reporting an error, the
client re-fetches public state. If the requested block completed, it derives that block's successor from
the public ordered stream and navigates to its anchor. It shows a retryable error when state confirms
that completion did not occur. If the reconciliation fetch also fails, show a generic retryable connection
error without advancing the block.

## Tests and live evaluation

Deterministic projection, server, and browser tests cover:

- structural and declared ordered blocks, exact block IDs, eligibility, no-op duplicates, and the final
  completion target;
- button, sentinel, and fake structured tutor calls using the same completion command;
- anchors, sidebar navigation, reading-line selection, `pushState`/`replaceState`, Back/Forward, and
  blocked deep-link modal behaviour;
- active-block region ordering, continuation footer placement, a short-block/tall-viewport sentinel
  regression, sticky work-surface release/expansion, reading-line tracking around a sticky surface,
  focus, and reduced-motion layout; and
- `blockInView` persistence without any effect on progress or tool authority.

The existing live evaluator is the only model-costing test path. Add isolated evaluation-workbook
scenarios to `npm run eval`; never call a model from `npm run check`. Its deterministic trace gate checks
positive continuation language selects `completeBlock(blockId)` and counterexamples such as “What’s
next?” do not. The existing real tutor/judge process then evaluates the learner-facing quality. These
explicit eval runs retain their normal pass/fail behaviour.

## Acceptance scenarios

```gherkin
Feature: Workbook block progression and navigation

  Scenario: Button completes the workbook introduction
    Given the tutorial state is clean
    When I click "Ready to continue"
    Then the workbook introduction block is completed
    And the Part 1 preamble block is revealed and active
    And Part 1 is scrolled to the reading position
    And the address bar identifies the Part 1 block

  Scenario: Scroll completes an eligible block
    Given the current block is eligible to complete
    When I scroll to its continuation sentinel
    Then that block is completed
    And its successor is revealed and active
    And the successor is scrolled to the reading position

  Scenario: The tutor completes an eligible block
    Given the current block is eligible to complete
    When the tutor invokes completeBlock with that block's ID
    Then the block is completed
    And its successor is revealed without a tutor confirmation message

  Scenario: Sidebar navigation changes reading location but not progress
    Given Part 1 is revealed
    And I have progressed beyond the Part 1 preamble block
    When I select Part 1 in the sidebar
    Then Part 1 is scrolled to the reading position
    And the address bar identifies the Part 1 block
    And tutorial completion state is unchanged

  Scenario: An unavailable deep link returns to active work
    Given the tutorial state is clean
    When I open a link to an unrevealed lesson
    Then I see an explanation that the lesson is not ready
    When I acknowledge the explanation
    Then the active block is scrolled to the reading position
    And the address bar identifies the active block
```

## Implementation order

Each implementation step starts with focused deterministic tests and ends with them passing.

1. Replace introduction-specific progression with the structural-and-declared block stream, generic
   `completeBlock(blockId)`, typed completion results, and fresh-session-only event representation.
2. Add canonical block IDs, anchors, and one-at-a-time successor rendering.
3. Put the active authored content, work surface, chat, and continuation footer in one active-block
   region. Add the page-break and guarded scroll completion.
4. Add navigation, reading-location history, sidebar anchors, blocked-link modal, and focus behaviour.
5. Add the constrained tutor tool, `blockInView`, final completion panel, and failure recovery.
6. Add isolated live-evaluation scenarios, then run the tutorial-engine check, build, browser smoke, and
   selected paid eval command.
