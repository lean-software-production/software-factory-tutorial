# Workbook UX video factory — phase 1

This directory contains the deterministic pre-AI video analyser for workbook UX recordings.

Phase 1 deliberately stops at the station boundary: it does **not** record the real workbook walkthrough and it does **not** call any model/provider. Later `record.mts` and `run.mts` scripts can reuse the marker protocol and analyser module here.

## Contract

`npm run --workspace=tutorial-engine test:video-analyser`:

1. Uses pinned Playwright Chromium to record a synthetic workbook-like page to a finalized WebM.
2. The page renders a fixed test-only marker at top right: guard swatch, phase swatch (`settled`/`transition`), and binary step-id cells.
3. Runs the production analyser against the actual WebM. No ffmpeg/ffprobe, sidecar motion telemetry, pixel-golden baseline, internet access, or AI calls are used.
4. The analyser serves the WebM from a tokenized loopback HTTP server with byte-range support, seeks frames in Chromium at about 10–12 Hz, draws real decoded pixels to canvas, decodes the marker, segments transition steps inside the first-to-last valid marker envelope, estimates vertical translation inside a motion ROI, and writes:
   - `motion.json`
   - selected evidence PNGs
   - `contact-sheet.png`
5. The synthetic recording contains a leading unmarked paint interval, passing monotonic movement, a fast-but-smooth viewport-sized monotonic scroll, and deliberate `oscillation`, teleport-style `jump`, and `no-motion` failures. The contract asserts stable finding code + step id pairs, not exact timestamps or frame counts.

Temporary artifacts are written only below `test/.tmp/workbook-factory/analyser-contract/`.

Leading/trailing invalid marker samples are counted but tolerated outside the valid marker envelope, because real Playwright WebMs can contain unpainted edges. Invalid marker gaps inside the envelope still fail closed and receive PNG evidence when a decoded frame exists. Motion pathologies are reported only when the sampled translation has enough deterministic confidence; otherwise the analyser reports `insufficient-motion-confidence` rather than turning weak measurements into definite scroll defects.

## Planned station boundary

A later video factory station should supply a finalized real workbook WebM and the required-motion step ids to `analyzeWorkbookVideo()`. AI review, if added, should consume `motion.json` and evidence after this deterministic analyser has passed. The marker constants in `marker-protocol.ts` are shared so the later recorder can render the same protocol that the analyser decodes from video pixels.
