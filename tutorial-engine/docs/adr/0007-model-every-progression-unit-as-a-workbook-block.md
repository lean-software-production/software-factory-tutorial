# 7. Model every progression unit as a workbook block

Date: 2026-08-24

## Status

accepted

## Context

The workbook gives learners an ordered experience, but only lesson-declared instructional blocks
participate in the block lifecycle. The workbook introduction has a separate completion event and
route. Part and lesson preambles are authored timeline messages without block identity. Buttons,
scrolling, tutor conversation, sidebar links, and browser history therefore do not share a model for
progression or navigation.

A learner completing a preamble has nevertheless completed a bounded part of the workbook. The
mechanism may be reading, clicking Continue, deliberately scrolling to its end, or asking the tutor to
carry on; it does not make the preamble a lesser unit of progression.

## Decision

Model every ordered, completable workbook unit as a **block**. Blocks are either structural—implied by
the workbook, Part, and lesson manifests—or declared inside a lesson. The block sequence begins with
the workbook introduction, includes each Part and lesson preamble, then includes declared lesson
blocks in authored order.

Give every block one logical reference, stable DOM anchor, completion state, and successor. Replace
special introduction and narrative continuation paths with one server-owned, idempotent
`completeBlock(blockId)` operation. The caller names the block it saw; the server validates that exact
active block, records generic completion, selects the successor, and returns its canonical navigation
target. A repeated request for a completed block is a no-op.

Buttons, eligible end-of-block scroll sentinels, and a constrained tutor `completeBlock(blockId)` tool
invoke this operation. Evaluated blocks remain protected by their existing evidence requirements.

Treat anchors as reading locations, separate from progress. Completion and explicit sidebar navigation
create browser history entries; passive scroll tracking replaces the current entry. Back and Forward
scroll to a historical revealed block and never rewind progress. This development-stage change does
not support old session logs; a developer resets private workbook state before starting a new session.

## Consequences

The engine has one progression model for preambles and instructional work. The browser can give every
relevant item a stable, shareable URL and the sidebar can use those URLs without its own mapping.
Tutor authority is explicit and testable: a model can request completion, but the server enforces the
same eligibility rules as the ordinary UI.

The loader and projection need to synthesize structural blocks. Development sessions created before
this change are reset rather than replayed. The timeline needs anchors, guarded scroll sentinels, and a
distinction between the active progression block and the learner's historical reading location. Browser
tests must cover history and URL behaviour in addition to progression.
