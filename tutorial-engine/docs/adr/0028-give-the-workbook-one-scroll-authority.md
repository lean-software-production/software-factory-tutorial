# 28. Give the workbook one scroll authority

Date: 2026-09-02

## Status

accepted

## Context

The 2026-09-01 play-test reported that typing made the page bounce, that manual scrolling could
lose the current content, that newly revealed steps often did not come into view, that the
scroll-driven widening of the editor and terminal was confusing, and that the page once overflowed
horizontally. Each had been patched before, in a stylesheet rule or an event handler, and each came
back.

A recorded journey with a scroll-ownership probe (`test/support/scroll-telemetry.ts`, driven by
`test/scroll-ownership.mts`) showed why. The window's scroll position had five owners:

- `navigateToAnchor` in `workbook-ui.tsx`, which scrolled smoothly, and which an effect keyed on
  every server state re-ran whenever the URL fragment was empty or invalid;
- `revealTutorReplyIfNeeded` in `timeline-thread.tsx`, which scrolled the page instantly whenever a
  new assistant record arrived, whether or not the learner was reading or typing elsewhere
  (measured: a 256px jump under a docked editor);
- CodeMirror's cursor reveal, which scrolls the window when the cursor is outside the viewport;
- the browser's scroll anchoring, which adjusts the scroll position whenever layout above the
  viewport changes height;
- the activity band, which set nine CSS variables from the scroll position on every scroll event,
  changing its own width, offset and height, and so changing the layout that the previous two
  owners answer to.

That last owner closed a loop: layout was a function of scroll, scroll was a function of layout.
The band's editor also had no height bound. In a 720px-tall window a thirty-line draft grew the
docked band past the viewport, and CodeMirror then scrolled the window on every keystroke to reach
a cursor inside a sticky surface that the window's scrolling could not move: 91 scroll events and
618px of drift while the learner typed. That is the typing bounce, and the reason manual scrolling
"lost" the current content.

Smooth scrolling made the landings unreliable on their own. `html { scroll-behavior: smooth }` made
every programmatic scroll a half-second promise about where the page would be, and any layout
change or learner input in that window broke it. The recorder measured a successor block 1190px
below the top of a 900px viewport immediately after Continue.

Layout measurement was also spread out: the band, the sidebar's viewed-lesson tracking, the passive
promotion of a ready successor, and the reply reveal each kept their own scroll listener and
measured the page independently.

## Decision

One module owns the scroll position: `web-workbook/src/scroll-authority.ts`. It is the only code
that calls `scrollIntoView`, `scrollTo` or `scrollBy` on the window, and it scrolls only in answer to
something the learner did: opening the page, following a link, pressing Continue, using Back, or
pressing the "new below" chip. All of its scrolls are instant. Content that arrives on its own — a
tutor reply, a learner's own message, a block the tutor advanced — is announced, never scrolled to:
if it landed below the reading area the authority shows a fixed chip, which clears when the content
scrolls into view or the learner presses it. A review is shown twice, welded to its practice
surface and appended to the conversation, so it is announced only when neither copy is in view.

Continue keeps the learner's position when the successor's start is already in the reading area,
and otherwise brings the successor to the top of it. The navigation is scheduled against the state
that makes the successor active and runs in a layout effect after that state commits, on the
layout the learner is about to see: a scroll issued before the commit lands on the old layout and
is then pushed out of place when the old band becomes history and the successor grows its own.
Passive promotion, when a ready successor crosses the reading line, changes the URL and never the
scroll position. The page is placed exactly once, when the first state arrives; no later state
moves it.

One module reads the viewport: `web-workbook/src/reading-line.ts`. The App subscribes once, and one
frame handler answers the sidebar, the URL fragment and passive promotion from one sweep of block
positions.

The activity band has fixed geometry, declared once in the stylesheet: sticky at the top, the
column's width, and an editor whose own box scrolls (`max-height` on the CodeMirror scroller) so a
docked band always fits above the composer and typing never needs to move the window. The band
reads nothing from the viewport and never takes keyboard focus on its own; focus arrives with the
navigation that brought the learner to the block, or with a click.

The page owns the column's width. The timeline is a grid whose single column is `minmax(0, 1fr)`,
so no block's content can widen the column past the viewport; an unbreakable line overflows its
own box, where the surfaces' own `overflow` rules clip or scroll it. The recorder found the
alternative directly: with an auto column, one long typed line made every block 1361px wide in a
1280px window, which is the play-test's horizontal overflow.

The workbook UX recorder asserts this contract on every run: every Continue landing is in view,
the page does not move while the learner types or while feedback lands at any band position, the
application makes no scroll calls of its own during those checkpoints, the docked band fits above
the composer, and the page never overflows horizontally. The scroll-ownership probe records who
moved the page in every checkpoint, so a regression names its owner.

## Consequences

Scroll defects now have one place to be wrong. A movement the learner did not ask for is either a
call outside the authority, which the probe will attribute, or a layout change the band's fixed
geometry rules out.

The scroll-linked widening of the activity band is gone, with its geometry maths, its nine CSS
variables, its transitions and its second stylesheet. The band is the same width at rest and when
docked, so the "at rest" and "expanded" visual approvals become one. Those screenshots must be
re-approved in the canonical devcontainer.

The reply auto-scroll is gone. A learner reading above a reply sees a pulsing "New reply below"
chip instead of the page moving under them. The same chip covers a tutor-driven block promotion.

Smooth scrolling is gone. If it returns it must live inside the authority, with cancellation, and
under a test that shows a landing survives layout change and input during the glide.

The recorder's three band placements are now `inflow`, `docked` and `away`, named for where the band
sits rather than how wide it is, and its journey reproduces the play-test conditions directly:
typing at each placement, feedback arriving at each, and a scroll away before feedback lands.
`test/scroll-ownership.mts` drives the wider set (a shorter window, a draft that outgrows the
editor, a reply below the fold, narrow viewports) as a diagnostic that prints the owner of every
movement.
