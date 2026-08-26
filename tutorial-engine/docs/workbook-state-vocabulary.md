# Workbook state vocabulary

This is the maintainer reference for workbook progression. It describes projection and event
semantics, not authored tutorial content.

A block is **revealed** when it is active or completed. A **ready** successor is rendered below the
active block, but is not revealed: it cannot yet be a chat, work-surface, sidebar, or direct-link
target. Later blocks are unrevealed and unrendered.

## State transitions

Every block enters the same progression flow. `workAccepted` is a condition on the current block;
**ready** is a display state of its successor. The final block has no successor to prepare.

| Transition | Structural blocks | Narrative blocks | Evaluated blocks |
| --- | --- | --- | --- |
| Revealed and active | The workbook introduction, part preambles, and lesson preambles are synthesized into the stream and become the current block in order. | A declared `narrative` block becomes the current block in order. | A declared `terminal-practice`, `editor-practice`, or `reflection` block becomes the current block in order. |
| Work accepted | Recorded immediately on activation; no learner evidence is evaluated. | Recorded immediately on activation; no learner evidence is evaluated. | Recorded only after the main tutor accepts the current attempt's evidence. |
| Ready successor | Acceptance renders exactly the next block as ready, if one exists. | Same. | Same. |
| Learner continuation | Continue, crossing the ready successor's reading line, or the tutor's completion tool invokes `completeBlock` for the current block. | Same. | Same, but only after work acceptance. |
| Block completion | `completeBlock` records `block_completed`, ends the current block, and makes the prepared successor revealed and active. | Same. | Same. |

## Acceptance is not completion

Work acceptance says that the current block has met its work requirement. For structural and
narrative blocks, that requirement is empty; for evaluated blocks, it is accepted evidence.
Recording `work_accepted` prepares one successor, but leaves the accepted block active and
incomplete.

Completion says that the learner has continued past that active block. `completeBlock` records
`block_completed`, promotes its ready successor, and makes that successor the active interaction
target. It does not evaluate work. Therefore, an evaluated block may be accepted while it still
waits for learner continuation, and it cannot complete before its work is accepted.

## Attempts and tutor feedback

Attempts belong only to evaluated blocks. An attempt is a versioned evidence snapshot, separate
from the block's display/progression state. Its lifecycle is `working`, `reviewing`, `feedback`,
or `accepted`; a replacement attempt supersedes the prior current attempt.

Tutor feedback is an attempt outcome, not block completion or acceptance. Feedback leaves the
block active and does not prepare a successor. The main tutor accepts an attempt, which records the
accepted attempt and then the block's generic `work_accepted` event. Block-tutor hints and readiness
signals can help or route review, but they do not accept an attempt. The learner still continues
separately to complete the block.
