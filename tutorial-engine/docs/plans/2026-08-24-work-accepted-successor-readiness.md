# Work acceptance and successor readiness

## Status

Approved for implementation — 2026-08-24

## Supersedes

This compact decision supersedes the `canComplete`, end-sentinel, and page-break rules in
`2026-08-24-workbook-block-progression-and-navigation-spec.md`. The remaining block identity,
history, sidebar, tutor, and completion-panel decisions remain in force.

## Model

Every block has a uniform `workAccepted` state.

- A block with no evaluated learner work sets `workAccepted` immediately when it becomes active.
- An evaluated block sets `workAccepted` when its evidence is accepted.

The event is generic and durable:

```ts
{ type: "work_accepted", blockId }
```

Block display/progression has four states:

```text
unready → ready → active → completed
```

`workAccepted` is not a fifth display state. It is the condition that prepares a successor.

When the current block's `workAccepted` event is recorded:

1. the server appends the next block's authored content to the timeline;
2. that successor becomes **ready**; and
3. the successor remains inactive: it has no live work surface, composer target, sidebar link, or
   direct-link access.

A ready block is rendered beneath the current block so the learner can see and scroll toward it. It is
not yet part of the navigable workbook history.

## Completing by reaching the successor

The ready successor, not an invisible end sentinel, is the scroll continuation target.

The current block's region ends with its chat and any explicit Continue control, followed by a
page-break. The ready successor is rendered after that break, with an unobtrusive scroll runway after it
so even a short bottom-of-document successor can genuinely cross the fixed line through ordinary
scrolling. When the ready successor crosses the fixed reading line, the browser requests:

```ts
completeBlock(currentBlockId)
```

The server records `block_completed` for the current block and promotes the ready successor to active.
The browser updates the fragment for this scroll completion with `replaceState` only. It does not add a
history entry and does not run a fragment-navigation scroll after the state update.

An explicit Continue control and the tutor's completion tool use the same server operation. They promote
the ready successor and navigate to its already-rendered anchor with `pushState`.

## Boundaries

- Only one successor may be ready at a time.
- A ready successor is not a valid sidebar, direct-link, chat, terminal, editor, or tutor-tool target.
- The rail shows the current lesson's complete authored block outline immediately. Completed and active
  entries remain normal links. Ready and later entries are visible but disabled, preserving the same
  ready-boundary rule as direct links.
- Reaching the ready successor must be idempotent. Duplicate observer callbacks cannot skip a block.
- The server validates that the requested current block has `workAccepted`; the browser never decides
  acceptance.
- Back/Forward and passive reading still navigate only active or completed blocks. A deep link to a
  ready successor remains unavailable and uses the existing explanatory modal.

## Tests

Add deterministic coverage for:

1. immediate `workAccepted` on a no-work active block and ready successor rendering;
2. accepted evidence producing `workAccepted` and exactly one ready successor;
3. crossing the ready successor's reading line completing only its predecessor and activating it,
   including the below-line-then-scroll browser sequence and no viewport jump;
4. a short bottom successor having enough scroll runway to cross the line without a fallback;
5. button and tutor completion promoting that same ready successor with destination-specific labels;
6. the current lesson rail outline showing all blocks while disabling ready and future entries;
7. duplicate crossings, a sidebar click, and a direct link never treating a ready block as active; and
8. a restart reconstructing the same active, accepted, ready, and completed state from events.
