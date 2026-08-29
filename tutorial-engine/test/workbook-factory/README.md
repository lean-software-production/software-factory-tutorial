# Workbook UX video factory

This directory contains the linear workbook UX factory. It never calls production providers during recording. The optional AI station runs only after deterministic checks pass and is advisory.

## Station graph

Input checked-out tutorial-engine version → copied fixture workbook → provider-free Playwright walkthrough → finalized WebM → deterministic decoded-WebM analyzer → optional `pi -p` advisory review → durable report.

1. **Input identity** — `input-metadata.json` records the exact Git SHA, dirty state, package pins, Playwright Chromium version, viewport, and web bundle freshness.
2. **Recording** — `recordWorkbookFactory()` copies `test/fixtures/journey-workbook/` into the ignored run workspace and starts the real workbook server with deterministic fakes:
   - `QueuedMainTutor` for editor feedback and acceptance;
   - `RecordingPracticeCoach` for terminal feedback;
   - a protocol-aware fake PTY that accepts xterm keystrokes, emits visible output and OSC-633 workbook markers, and never runs shell commands.
3. **Deterministic analysis** — the analyzer decodes the recorded WebM in Chromium, reads only the test marker embedded in the video, checks required scroll motion, and writes `analysis/motion.json`, selected evidence frames, and `analysis/contact-sheet.png`.
4. **Optional advisory AI** — `review-ai.ts` invokes `pi` with `execFile`, `-p -nt --no-session --thinking low`, and `@...` attachments for the contact sheet, decoded frames, provider-safe `ai-walkthrough-summary.json`, and `analysis/motion.json`. It asks only for UX/scroll glitch observations and requires `@needs-human` evidence citations. Missing/quota-limited/nonzero/timeout/empty/thrown AI output is reported as unavailable and never changes the exit code.
5. **Report** — `report.ts` always writes `report.md` and `factory-result.json`, even when recording or deterministic analysis throws. The report renders whatever metadata, screenshot, video, walkthrough, analyzer, and AI artifacts exist.

## Commands

From the repository root:

```bash
npm run --workspace=tutorial-engine test:video-analyser
npm run --workspace=tutorial-engine factory:workbook:record
npm run --workspace=tutorial-engine factory:workbook:deterministic
npm run --workspace=tutorial-engine factory:workbook
```

- `factory:workbook:record` records only and preserves the pre-existing command contract.
- `factory:workbook:deterministic` runs the linear factory without AI and exits nonzero only if recording semantics or deterministic analyzer findings fail.
- `factory:workbook` runs the full linear factory with `--ai`. AI findings or AI unavailability never gate exit.

Useful direct CLI options:

```bash
tsx test/workbook-factory/run.mts --no-ai --run-root=test/.tmp/workbook-factory/manual
tsx test/workbook-factory/run.mts --ai --headed
tsx test/workbook-factory/run.mts --ai --ai-command=/path/to/pi --ai-model='provider/model' --ai-timeout-ms=180000
```

## Artifact contract

Default run root: `tutorial-engine/test/.tmp/workbook-factory/latest/`.

Expected durable artifacts:

- `input-metadata.json` — Git SHA/dirty status, package/browser pins, viewport, bundle freshness;
- `walkthrough.json` — semantic checkpoints, typed editor/terminal input, geometry/scroll/feedback safe-region and occlusion telemetry, fake call counts;
- `walkthrough.webm` — finalized Playwright recording when Chromium produced one;
- `analysis/motion.json` — deterministic decoded-WebM report;
- `analysis/contact-sheet.png` and selected `analysis/*.png` evidence frames;
- `ai-walkthrough-summary.json`, `ai-review.md`, `ai-review.stderr.txt`, `ai-review.json` when AI was requested or attempted;
- `recording-error.json` and `recording-error.png` when recording or deterministic validation fails;
- `report.md` — human report with relative artifact links;
- `factory-result.json` — machine-readable station status, deterministic verdict, artifacts, and AI status.

## Authoritative vs advisory

The deterministic recorder/analyzer is authoritative. Its semantic failures and analyzer findings decide the command exit code. The AI review is deliberately limited to visual continuity and scroll/resize glitches, is marked advisory, and must prefix observations with `@needs-human`. It may help a human notice subtle bouncing, oscillation, clipping, occlusion, abrupt jumps, or awkward movement, but it cannot override a deterministic pass or fail.

## Periodic invocation example

Run the non-AI factory before cutting a tutorial-engine change, and optionally run the full advisory version during a weekly visual-health sweep:

```bash
npm run --workspace=tutorial-engine factory:workbook:deterministic
npm run --workspace=tutorial-engine factory:workbook || true  # inspect report.md if AI is quota-limited/unavailable
```

No scheduled CI job is installed yet.

## Synthetic analyzer contract

`npm run --workspace=tutorial-engine test:video-analyser` records a synthetic workbook-like page and verifies stable analyzer finding code/step pairs for deliberate failures. It uses pinned Playwright Chromium, the shared marker protocol, and no ffmpeg/ffprobe, sidecar motion telemetry, pixel-golden baseline, internet access, or AI calls. Leading/trailing invalid marker samples are counted but tolerated outside the valid marker envelope; invalid marker gaps inside the envelope fail closed.
