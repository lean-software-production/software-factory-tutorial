# Scroll ownership: evidence and redesign

Follow-up to [the 2026-09-01 play-test findings](2026-09-01-playtest-engine.md), section "Scroll
state and progression navigation are unstable". The decision is recorded as
[ADR 0028](../../tutorial-engine/docs/adr/0028-give-the-workbook-one-scroll-authority.md); this
note keeps the evidence and the ownership map that led to it.

## How the evidence was gathered

Two real-browser instruments, both against the engine's journey fixture with fake tutor and PTY:

- `npm run --workspace=tutorial-engine test:workbook-ux:record` — the workbook UX recorder. Its
  WebM was decoded to frames and its `walkthrough.json` telemetry read per checkpoint.
- `npx tsx tutorial-engine/test/scroll-ownership.mts` — a new diagnostic that wraps every entry
  point that moves the window (`scrollIntoView`, `scrollTo`, `scrollBy`, `focus`), logs every
  scroll event with its cause, and drives the play-test situations: Continue with a trackpad nudge
  mid-scroll, keyboard paging after the band auto-focused, typing at each band position, a draft
  that outgrows the editor, a 720px-tall window, a tutor reply arriving below the fold, and
  1024px and 390px viewports. The probe lives in `tutorial-engine/test/support/scroll-telemetry.ts`
  and the recorder now carries it too, so every recording says who moved the page.

Before any code change the diagnostic held 21 of 23 scenarios; the recorder's own twelve
checkpoints passed, because its journey never typed past the fold and its own positioning masked
each Continue landing.

## What reproduced, and who owned it

| Play-test symptom | Reproduction | Owner found |
| --- | --- | --- |
| Typing bounced the page | 1280×720 window, docked editor, 30-line draft: 91 scroll events, 618px drift while typing | The band's editor had no height bound; once the sticky band was taller than the window, CodeMirror's cursor reveal scrolled the window on every keystroke to reach a cursor the window could not move |
| Manual scrolling lost the current content | Same mechanism: the page under the docked band scrolled away unseen | As above, plus the tutor-reply scroll below |
| Newly revealed steps did not come into view | Recorder measured the terminal band at y=1190 in a 900px viewport immediately after Continue; the diagnostic's Continue landings took ~520ms to arrive | `html { scroll-behavior: smooth }` made every navigation a half-second promise, and the band's scroll-linked geometry changed layout during the glide |
| Reply arrival moved the page | Tutor reply below the fold: instant 256px jump under a docked editor | `revealTutorReplyIfNeeded` in `timeline-thread.tsx`, a second scroll owner |
| Scroll-linked widening felt fragile | Every scroll event set nine CSS variables on the band; its width, offset and height followed the scroll position | `activity-band.tsx` geometry: layout as a function of scroll, closing a loop with the two scrollers above and the browser's scroll anchoring |
| Horizontal overflow | Recorder (after the redesign's first pass): one 105-character typed line made every timeline block 1361px wide in a 1280px window; the terminal block's content made them 1316px | `.timeline-thread` was a grid with an auto column, which grows to its widest item's minimum content |

Not reproduced: a trackpad nudge during the smooth scroll (Chromium via Playwright did not cancel
the programmatic glide), and focus theft on keyboard paging (the band's auto-focus fired once per
block and had already fired at the Continue landing). Both mechanisms are removed regardless: the
scroll is instant, and the band no longer focuses on scroll.

## Ownership before

Scroll position: `navigateToAnchor` (Continue, rail links, Back, and an effect keyed on every
server state whenever the fragment was empty or invalid), `revealTutorReplyIfNeeded` (every new
assistant record), CodeMirror's cursor reveal, the browser's scroll anchoring, and the recorder's
own positioning in tests.

Layout measurement: the activity band (main and inline rects plus an `offsetTop` chain on every
scroll, resize and size change), the App's sidebar tracking (every revealed block's rect on every
scroll and every state), the ready-successor observer (its rect on every scroll and resize), the
reply reveal (rects in a layout effect), and the terminal's fit observer.

Progression focus: the server (active block); the browser's Continue path (complete, then
navigate and focus the heading), passive crossing (complete, then replace the URL), tutor-driven
promotion (navigate), the band's intersection observer (focus the editor on downward scroll), and
the sidebar's viewed lesson (from scroll).

Activity-surface geometry: the band's JavaScript (nine CSS variables from scroll), `styles.css`
(sticky, min-heights, mobile overrides), `activity-band.css` (transition off for terminals),
CodeMirror's content-driven height, and xterm's fixed height with fit-driven columns.

## Ownership after

- **Scroll position** — `web-workbook/src/scroll-authority.ts`, only. Instant scrolls, only for
  learner-initiated navigation (initial load, link, Continue, Back, the chip). Everything else is
  announced: a "new below" chip when content lands below the fold. Continue keeps the learner's
  place when the successor's start is already readable, and its scroll runs in the layout effect of
  the commit that activates the successor: the diagnostic caught the alternative once, a successor
  landing 78px above the viewport when the scroll ran an animation frame before React committed
  the state that reshaped the blocks above it.
- **Layout measurement** — `web-workbook/src/reading-line.ts`: one subscription, one frame
  handler, one sweep answering the sidebar, the URL and passive promotion.
- **Progression focus** — the server decides the active block; the authority moves focus only with
  a navigation (into the block's editor if it has one, never into a terminal).
- **Activity-surface geometry** — the stylesheet, once: sticky, the column's width, a bounded
  editor that scrolls in its own box, and a timeline column of `minmax(0, 1fr)` so content cannot
  widen the page.

## After the redesign

The diagnostic holds 23 of 23 scenarios. The recorder's twelve checkpoints hold the page still
while typing and while feedback lands at every band position, land every Continue in view, and see
no application scroll calls; the recorder now fails on any of those, on a docked band that does
not fit above the composer, on horizontal overflow (naming the widest element), and on the "new
below" chip showing for feedback the learner can already see. (A review of the active block is
rendered only as the bar welded to its surface — the server projects it into the conversation
later, as history — so a review that lands while the learner has scrolled away is not announced.
Whether it should be is a product question left open here.)

Two calibrations of the recorder's own camera work were needed for the video analyzer, which
measures translation by correlating frames: its band placement is measured once per surface
outside any transition (the measurement scrolls, and inside a transition read as oscillation), the
"away" move is paced like the others (a 300ms move read as a teleport at 11 Hz sampling), and the
editor's away scroll starts from the in-flow position rather than the docked one and follows a
ten-line draft, because a white editor over the notebook grid gives the correlation too little to
track. The analyzer's region also stops above the fixed chip and composer, so only scrolling
content is measured, and its per-sample search is bounded to twice the recorder's fastest move
(`REAL_JOURNEY_MAX_SAMPLE_SHIFT_PX`): the estimator under-measures a scroll while the editor fills
the frame and then reports a "catch-up" of several hundred pixels, which the jump detector read
as a teleport. Application scrolls are caught by the ownership probe, not by the video.

## Left for a human

- The visual approvals under `tutorial-engine/test/visual/` must be regenerated in the canonical
  devcontainer: the two `*-band-expanded` shots are gone and `*-band-docked` replace them, and the
  at-rest shots may differ by the band's margins.
- `evals/test/v2-judge-trace.test.ts` ("wraps malformed judge JSON") failed twice under the full
  vitest run and passed alone; the judge script exits before its stdin is written, which reaches
  the command-failure path first under load. It is unrelated to this change.
