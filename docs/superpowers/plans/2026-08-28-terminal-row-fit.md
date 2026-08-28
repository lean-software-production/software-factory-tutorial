# Terminal row-fit plan

## Context

The scroll-linked embedded terminal uses xterm at a 16px font size. Its final
visible row is clipped because the terminal container reserves 18px below the
xterm canvas while xterm's fit calculation uses the full container height.

## Global constraints

- Do not change the scroll-linked activity band’s expansion geometry or its
  terminal font size.
- Keep a small, symmetric inset around the xterm canvas so the fitted final
  row remains entirely visible.
- Preserve the terminal's fixed outer height and feedback attachment.

## Task 1: Fit terminal rows inside its padded viewport

Update `tutorial-engine/test/workbook-conversation-layout.test.tsx` first to
assert that `.embedded-terminal` uses a uniform 6px padding, and run that test
to demonstrate it fails against the current 6px/6px/18px declaration.

Then change only `.embedded-terminal` in
`tutorial-engine/web-workbook/src/styles.css` to use `padding: 6px`. This makes
the xterm canvas's usable area match the symmetric visual inset, so its final
fitted row does not extend into a disproportionately large bottom inset. Keep
its height and overflow behaviour unchanged. Re-run the focused test and run
`npm run --workspace=tutorial-engine check` before committing.

## Update: coaching feedback presentation

After Task 1, the user identified the visual fault more precisely: the blue
coaching bar removes the terminal's lower rounded corners. The earlier
constraint to preserve the welded feedback attachment is superseded for the
next task.

## Task 2: Keep coaching feedback separate from the terminal

Update `tutorial-engine/test/workbook-conversation-layout.test.tsx` first so
its terminal-feedback test requires the terminal panel to retain its normal
bottom border and `9px` border radius when feedback exists. Require the blue
`.terminal-feedback-overlay` to be a separate, fully rounded card below the
terminal rather than a continuation with only lower corners. Run the focused
test and demonstrate it fails against the welded rules.

Then remove only the CSS overrides that flatten the terminal panel and make
the overlay's border radius uniform in
`tutorial-engine/web-workbook/src/styles.css`. Leave the terminal panel's
normal `12px` bottom margin in effect so the feedback starts after a readable
gap. Do not change the feedback copy, terminal dimensions, font, or
scroll-linked expansion. Re-run the focused test and
`npm run --workspace=tutorial-engine check` before committing.
