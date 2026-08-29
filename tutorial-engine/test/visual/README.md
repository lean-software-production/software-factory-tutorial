# Approved screenshots

These are approval tests. Each `.approved.png` is the blessed rendering; a failing run leaves a
`.received.png` beside it, and `npm run approve:visual` renames one over the other.

## Approve from the devcontainer, not your host

**Devcontainer image/environment approved 2026-08-28: the image built from `.devcontainer/Dockerfile`.**

The previous set was approved from an unrecorded environment, and nothing else could reproduce it —
every screenshot failed by 1.5–5.3% against a 0.5% budget, on any commit, including the one they
were approved at. The cause was fonts: the workbook asked for Georgia and SF Mono, which exist on
macOS and not in the container, where generic `serif` and `sans-serif` both resolved to WenQuanYi
Zen Hei, a Chinese sans.

The workbook now carries its own faces — Spectral, Archivo and JetBrains Mono, self-hosted in
`web-workbook/src/fonts/` — so the typeface no longer depends on the machine. What remains is
text rasterisation, which still differs between macOS and Linux even with identical font files. So
regenerate here, from the container, and commit the result with the change that caused it.

If you approve from a Mac, expect these to fail for everyone else.

## What they pin

Layout, not typography as a learner sees it. The workbook server runs in the container but the
learner's browser runs on their own machine, so what a learner sees depends on their OS. These
shots exist to catch the band geometry regressing — at rest versus expanded, the composer capping
at its maximum height, the feedback strip welded to the terminal's bottom edge.

The band approvals pin only the visible `main` canvas, from its left edge to the viewport right.
They deliberately exclude the sticky lesson rail, which is not part of the band affordance, and they
neutralize `main`'s decorative notebook grid so unrelated document height changes cannot move the
grid phase and fail an otherwise unchanged band.

`.embedded-terminal` and `.cm-editor` are masked magenta: xterm's canvas and CodeMirror's caret do
not reproduce deterministically.
