# Workbook UX video factory

This directory contains deterministic stations for workbook UX recordings. It does not call any AI reviewer yet.

## Station 1 — synthetic analyser contract

`npm run --workspace=tutorial-engine test:video-analyser`:

1. Uses pinned Playwright Chromium to record a synthetic workbook-like page to a finalized WebM.
2. Renders the shared test-only marker at top right: guard swatch, phase swatch (`settled`/`transition`), and binary step-id cells.
3. Runs `analyzeWorkbookVideo()` against the actual WebM. No ffmpeg/ffprobe, sidecar motion telemetry, pixel-golden baseline, internet access, or AI calls are used.
4. Writes `motion.json`, evidence PNGs, and `contact-sheet.png` below `test/.tmp/workbook-factory/analyser-contract/`.
5. Asserts stable finding code + step id pairs for deliberate synthetic failures.

Leading/trailing invalid marker samples are counted but tolerated outside the valid marker envelope. Invalid marker gaps inside the envelope fail closed.

## Station 2 — real workbook recorded journey

`npm run --workspace=tutorial-engine factory:workbook:record` records the real workbook journey only.

`npm run --workspace=tutorial-engine factory:workbook:deterministic` records the journey and then runs the deterministic video analyser.

Station 2 uses the sibling fixture in `test/fixtures/journey-workbook/`. The fixture is copied into the ignored run workspace `test/.tmp/workbook-factory/latest/input/` before the server starts, so neither authored tutorial content nor the fixture is mutated.

The recorder starts the real `startWorkbookServer()` with:

- `QueuedMainTutor` for deterministic editor feedback and acceptance;
- `RecordingPracticeCoach` for deterministic terminal feedback;
- a protocol-aware fake PTY that accepts xterm keystrokes, echoes visible output, emits OSC-633 `workbook-command`/`workbook-finished` markers on Enter, and never runs shell commands.

The Playwright run launches pinned Chromium at 1280×900, DPR 1, normal motion, with `recordVideo`. It injects the shared marker protocol outside React as early as practical. Each transition is marker-labelled before the learner action and is returned to `settled` only after the DOM/server outcome and scroll geometry have settled.

The recorded journey includes learner-like typing in both surfaces while the activity band is in all three geometry states:

- editor small, mid-scroll, and full-width feedback;
- terminal small, mid-scroll, and full-width Practice Coach feedback.

Artifacts are preserved on failure under `test/.tmp/workbook-factory/latest/`:

- `input-metadata.json` — Git SHA/dirty status, package and browser pins, viewport, bundle freshness;
- `walkthrough.json` — semantic checkpoints plus diagnostic geometry/scroll/feedback telemetry and fake call counts;
- `walkthrough.webm` — finalized recording;
- `analysis/motion.json`, evidence PNGs, and `analysis/contact-sheet.png` when analysis runs;
- `recording-error.json` and `recording-error.png` when recording or deterministic validation fails.

The analyzer phase source is the video marker only. `walkthrough.json` telemetry is diagnostic and is not fed into `analyzeWorkbookVideo()`.

## Future station boundary

Phase 3 may add independent `pi -p` AI review after deterministic analysis passes. That review is intentionally not implemented here.
