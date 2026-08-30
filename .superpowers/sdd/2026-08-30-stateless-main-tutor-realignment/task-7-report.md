# Task 7 report — summaries precede progression

## Result

Task 7 is complete in commit `3db2285 Require summaries before progression`.

## Ordering

Before appending `block_completed`, the serialized completion command now determines whether the current
boundary requires:

1. an evaluated-block summary;
2. a lesson summary because the block is the lesson's last incomplete declared block; and
3. a workbook completion summary because the block is the stream's last incomplete block.

It generates and appends each required summary in that order, then appends `block_completed`. Each summary
covers the final existing event before the summary sequence, so ADR 0006 can replace the detailed history
through the accepted attempt while later progression facts remain ordered after the summary.

Existing successful summaries are reused after a process restart rather than duplicated. This matters when
a later summary at the same boundary failed after an earlier one had already been appended.

## Failure behavior

A missing/failed required summary latches the Task 6 process-local fatal state and the completion endpoint
returns 409. No dependent `block_completed` event is written, so the block, lesson, and workbook remain
incomplete. Summary logs contain public operation and block identity only; they omit provider errors and
request/event identifiers.

Closing or content-generation invalidation while a summary is pending still prevents both late summary
writes and completion.

## Verification

Deterministic tests now prove:

- block summary precedes evaluated-block completion;
- lesson and workbook summaries precede final-block completion;
- successful final progression includes all required summaries;
- block, lesson, and workbook summary failures each latch fatal state and leave the boundary incomplete;
- provider failure details do not enter public state;
- close-time stalled summaries cannot write late events.

```text
Focused summary/progression tests: 4 passed, 57 skipped
Production/test TypeScript: passed
npm run --workspace=tutorial-engine test:fast:
  lint/typechecks/check:eval passed
  56 files, 594 tests passed
  web build passed
  browser smoke passed
```
