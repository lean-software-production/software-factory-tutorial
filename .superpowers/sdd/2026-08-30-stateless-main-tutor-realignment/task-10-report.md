# Task 10 report — two canonical feedback composites

## Result

Task 10 is complete in two commits:

- `3e7fcb2 Combine canonical feedback visual matrices`
- `6e49226 Remove split feedback visual baselines`

## Composite coverage

The feedback gallery now produces exactly two approval images:

- `practice-feedback-desktop.approved.png`
- `practice-feedback-narrow.approved.png` at 390px viewport width

Each image contains one combined editor-and-terminal matrix with ten explicit cards:

- editor reviewing;
- editor retained feedback while updating;
- editor actionable feedback;
- editor fatal/disabled state with the canonical banner;
- editor success;
- terminal running;
- terminal checking;
- terminal actionable feedback;
- terminal fatal/disabled state with the canonical banner; and
- terminal success.

The removed temporary-failure/retryable-failure cards and retry button are no longer represented. The
four old per-surface desktop/narrow baselines were deleted.

## Geometry and masking

The combined gallery photographs every feedback bar and fatal banner directly. It asserts the complete
state set and count at both widths, a visible canonical fatal banner for both fatal cards, and unmasked
weld gap, width, and left-edge alignment for each applicable work surface. Existing xterm/CodeMirror
masks remain limited to the separate activity-band geometry approvals.

The first canonical run exposed a pre-existing layout defect: the decorative confetti canvas was a normal
child of the shell grid, which shifted the rail/main columns and broke all band geometry. The canvas is
now fixed to the viewport instead of participating in layout, with a focused CSS assertion. Existing band
baselines and all geometry checks then passed unchanged.

## Inspection and approval

Both received composites were opened and inspected after generation in the canonical OrbStack
devcontainer. Desktop uses a balanced two-column matrix; narrow uses a readable single-column matrix.
The fatal banner, retained feedback, welded edges, success treatment, text wrapping, and 390px alignment
were intentional. Only those two received images were approved.

## Verification

```text
Focused visual command tests: 29 passed
Focused confetti/fatal UI tests: 5 passed, 90 skipped
Production/test TypeScript: passed
npm run --workspace=tutorial-engine test:fast:
  lint/typechecks/check:eval passed
  55 files, 596 tests passed
  web build passed
  browser smoke passed
OrbStack canonical visual run after approval:
  reading-line promotion passed
  activity-band expansion passed
  composer auto-resize passed
  editor/terminal feedback composites passed
  no received images remain
```
