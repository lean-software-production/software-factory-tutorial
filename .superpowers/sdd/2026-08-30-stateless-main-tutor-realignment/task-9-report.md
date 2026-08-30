# Task 9 report — one fatal workbook UI

## Result

Task 9 is complete in commit `620b89a Render one disabled fatal workbook state`.

## Fatal banner

The browser renders exactly one non-dismissable `role="alert"` banner from the server's fatal state. Its
prominent fixed treatment says “Workbook paused” and “Tutor unavailable,” then displays the canonical safe
message telling the learner to fix or reconnect the provider and restart the workbook. There is no retry
button or client recovery action.

## Disabled mutation surfaces

Fatal state now disables every browser mutation path without hiding the learner's current work:

- chat/reflection textarea and send button are disabled and the send handler is guarded;
- automatic scroll progression is suspended;
- explicit continuation remains visible but disabled;
- terminal command insertion is removed;
- the active terminal stays visible with xterm input disabled/inert;
- the active editor stays visible with its current draft, but CodeMirror is non-editable and pending
  debounce work is cancelled;
- no fatal-state editor or terminal busy spinner suggests that review is still running.

The active activity surface remains in place and is marked `aria-disabled`. Existing actionable editor
feedback remains welded below the read-only editor; the banner is the only fatal/restart message, so the
practice feedback bar does not duplicate infrastructure state.

All Tutor retry requests, handlers, props, buttons, timeline cards, and terminal retry IDs remain absent.

## Verification

Focused UI tests prove:

- exactly one accessible fatal alert with reconnect/restart guidance and no retry control;
- the active editor remains visible, shows its current draft and retained feedback, is non-editable, and
  cannot issue a POST;
- the active terminal remains visible, inert, stdin-disabled, without insertion or stale checking status;
- chat and continuation controls are disabled and cannot issue a POST;
- normal welded feedback/retained-feedback behavior remains green.

```text
Focused fatal/feedback UI: 5 passed, 90 skipped
Production/test TypeScript: passed
Web lint: passed
npm run --workspace=tutorial-engine test:fast:
  lint/typechecks/check:eval passed
  55 files, 596 tests passed
  web build passed
  browser smoke passed
```
