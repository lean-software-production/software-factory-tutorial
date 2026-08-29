import { rm, mkdir, rename, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { analyzeWorkbookVideo, type AnalyzerReport, type FindingCode } from './analyzer.js';
import { MARKER_COLOURS, markerCss, markerHtml, markerCellColours, rgbCss, type MarkerPhase } from './marker-protocol.js';

const ROOT = join(process.cwd(), 'test/.tmp/workbook-factory/analyser-contract');
const VIDEO_DIR = join(ROOT, 'video');
const ANALYSIS_DIR = join(ROOT, 'analysis');
const ABSENT_REQUIRED_DIR = join(ROOT, 'absent-required-analysis');
const VIEWPORT = { width: 800, height: 600 };

interface SyntheticPhase {
  phase: MarkerPhase;
  stepId: number;
  durationMs: number;
  offsetAt(progress: number): number;
}

const phases: SyntheticPhase[] = [
  { phase: 'settled', stepId: 0, durationMs: 250, offsetAt: () => 0 },
  { phase: 'transition', stepId: 1, durationMs: 1200, offsetAt: (progress) => -185 * easeInOut(progress) },
  { phase: 'settled', stepId: 1, durationMs: 250, offsetAt: () => -185 },
  {
    phase: 'transition',
    stepId: 2,
    durationMs: 1500,
    offsetAt: (progress) => interpolateStops(progress, [
      [0, -185],
      [0.22, -40],
      [0.48, -265],
      [0.72, -70],
      [1, -245],
    ]),
  },
  { phase: 'settled', stepId: 2, durationMs: 250, offsetAt: () => -245 },
  {
    phase: 'transition',
    stepId: 3,
    durationMs: 900,
    offsetAt: (progress) => {
      if (progress < 0.42) {
        return -245;
      }
      if (progress < 0.5) {
        return -385;
      }
      return -385 - (progress - 0.5) * 30;
    },
  },
  { phase: 'settled', stepId: 3, durationMs: 250, offsetAt: () => -400 },
  { phase: 'transition', stepId: 4, durationMs: 900, offsetAt: () => -400 },
  { phase: 'settled', stepId: 4, durationMs: 300, offsetAt: () => -400 },
];

await rm(ROOT, { recursive: true, force: true });
await mkdir(VIDEO_DIR, { recursive: true });
await mkdir(ANALYSIS_DIR, { recursive: true });
await mkdir(ABSENT_REQUIRED_DIR, { recursive: true });

const startedAt = performance.now();
const videoPath = await recordSyntheticVideo();
const recordedAt = performance.now();
const report = await analyzeWorkbookVideo({
  videoPath,
  outputDir: ANALYSIS_DIR,
  requiredMotionStepIds: [1, 2, 3, 4],
  sampleHz: 10,
});
const analysedAt = performance.now();
assertContractFindings(report);

const absentRequired = await analyzeWorkbookVideo({
  videoPath,
  outputDir: ABSENT_REQUIRED_DIR,
  requiredMotionStepIds: [99],
  sampleHz: 1,
});
assertHasFinding(absentRequired, 'missing-required-step', 99);
const completedAt = performance.now();

const evidence = await readdir(ANALYSIS_DIR);
console.log(JSON.stringify({
  ok: true,
  videoPath,
  motionJson: join(ANALYSIS_DIR, 'motion.json'),
  evidenceSample: evidence.filter((name) => name.endsWith('.png')).slice(0, 6),
  findings: report.findings.map((finding) => ({ code: finding.code, stepId: finding.stepId })),
  absentRequiredFinding: absentRequired.findings.map((finding) => ({ code: finding.code, stepId: finding.stepId })),
  performanceMs: {
    record: Math.round(recordedAt - startedAt),
    analyse: Math.round(analysedAt - recordedAt),
    total: Math.round(completedAt - startedAt),
  },
}, null, 2));

async function recordSyntheticVideo(): Promise<string> {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: VIEWPORT,
    recordVideo: { dir: VIDEO_DIR, size: VIEWPORT },
  });
  try {
    const page = await context.newPage();
    await page.setContent(syntheticHtml(), { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => (window as Window & { __workbookFactoryDone?: boolean }).__workbookFactoryDone === true, undefined, {
      timeout: totalDurationMs() + 10000,
    });
    const video = page.video();
    assert(video, 'Playwright did not create a video handle');
    await context.close();
    const rawPath = await video.path();
    const finalPath = join(ROOT, 'synthetic-workbook-factory.webm');
    await rename(rawPath, finalPath);
    return finalPath;
  } finally {
    await browser.close();
  }
}

function syntheticHtml(): string {
  const phaseData = JSON.stringify(phases.map((phase) => ({ phase: phase.phase, stepId: phase.stepId, durationMs: phase.durationMs })));
  const offsets = JSON.stringify(sampleOffsetsForBrowser());
  const markerColours = JSON.stringify({
    settled: rgbCss(MARKER_COLOURS.phase.settled),
    transition: rgbCss(MARKER_COLOURS.phase.transition),
    guard: rgbCss(MARKER_COLOURS.guard),
    zero: rgbCss(MARKER_COLOURS.bit.zero),
    one: rgbCss(MARKER_COLOURS.bit.one),
    cells: phases.reduce<Record<string, string[]>>((acc, phase) => {
      acc[`${phase.phase}:${phase.stepId}`] = markerCellColours({ phase: phase.phase, stepId: phase.stepId }).map(rgbCss);
      return acc;
    }, {}),
  });

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    ${markerCss()}
    html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; background: #16202a; }
    body { font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .chrome { position: fixed; inset: 0 0 auto 0; height: 58px; background: linear-gradient(90deg, #172033, #25344f); color: white; z-index: 2; display: flex; align-items: center; padding-left: 28px; box-shadow: 0 3px 18px rgba(0,0,0,0.35); }
    .chrome strong { letter-spacing: 0.08em; text-transform: uppercase; font-size: 13px; color: #a9d8ff; }
    .viewport { position: absolute; inset: 58px 0 0 0; overflow: hidden; background: #e9edf3; }
    .content { position: absolute; left: 0; right: 0; top: 0; will-change: transform; }
    .row { height: 54px; display: grid; grid-template-columns: 70px 1fr 150px; gap: 16px; align-items: center; padding: 0 36px; border-bottom: 1px solid rgba(20,30,50,0.18); color: #162033; }
    .row:nth-child(4n) { background: linear-gradient(90deg, rgba(255,255,255,0.72), rgba(196,220,255,0.4)); }
    .row:nth-child(4n+1) { background: linear-gradient(90deg, rgba(236,255,233,0.72), rgba(255,255,255,0.45)); }
    .row:nth-child(4n+2) { background: linear-gradient(90deg, rgba(255,244,214,0.72), rgba(255,255,255,0.45)); }
    .row:nth-child(4n+3) { background: linear-gradient(90deg, rgba(246,228,255,0.72), rgba(255,255,255,0.45)); }
    .num { font-variant-numeric: tabular-nums; font-weight: 800; font-size: 22px; color: #294c77; }
    .copy { font-size: 17px; font-weight: 650; }
    .micro { height: 18px; background-image: repeating-linear-gradient(90deg, #203858 0 5px, #f8fbff 5px 9px, #83a6ce 9px 13px); border-radius: 99px; box-shadow: inset 0 0 0 1px rgba(0,0,0,0.16); }
  </style>
</head>
<body>
  <div class="chrome"><strong>Workbook factory synthetic contract</strong></div>
  <div class="viewport"><div class="content" id="content">${syntheticRows()}</div></div>
  ${markerHtml({ phase: 'settled', stepId: 0 })}
  <script>
    const phases = ${phaseData};
    const offsets = ${offsets};
    const markerColours = ${markerColours};
    const totalDuration = ${totalDurationMs()};
    const content = document.getElementById('content');
    const marker = document.querySelector('.wf-marker');
    const cells = Array.from(document.querySelectorAll('.wf-marker-cell'));
    let start = undefined;
    function offsetFor(phaseIndex, progress) {
      const stops = offsets[String(phaseIndex)];
      if (!stops || stops.length === 0) return 0;
      for (let i = 1; i < stops.length; i++) {
        const prev = stops[i - 1];
        const next = stops[i];
        if (progress <= next[0]) {
          const span = Math.max(0.0001, next[0] - prev[0]);
          const local = (progress - prev[0]) / span;
          return prev[1] + (next[1] - prev[1]) * local;
        }
      }
      return stops[stops.length - 1][1];
    }
    function setMarker(phase) {
      marker.dataset.markerStep = String(phase.stepId);
      marker.dataset.markerPhase = phase.phase;
      const colours = markerColours.cells[phase.phase + ':' + phase.stepId];
      for (let i = 0; i < cells.length; i++) cells[i].style.background = colours[i];
    }
    function tick(now) {
      if (start === undefined) start = now;
      const elapsed = now - start;
      let cursor = 0;
      let phaseIndex = phases.length - 1;
      let localElapsed = phases[phaseIndex].durationMs;
      for (let i = 0; i < phases.length; i++) {
        if (elapsed < cursor + phases[i].durationMs) {
          phaseIndex = i;
          localElapsed = elapsed - cursor;
          break;
        }
        cursor += phases[i].durationMs;
      }
      const phase = phases[phaseIndex];
      const progress = Math.max(0, Math.min(1, localElapsed / phase.durationMs));
      content.style.transform = 'translate3d(0, ' + offsetFor(phaseIndex, progress) + 'px, 0)';
      setMarker(phase);
      if (elapsed >= totalDuration) {
        window.__workbookFactoryDone = true;
        return;
      }
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  </script>
</body>
</html>`;
}

function syntheticRows(): string {
  return Array.from({ length: 58 }, (_, index) => {
    const words = ['validation loop', 'red green refactor', 'approval gate', 'workbook station', 'deterministic pixels', 'scroll invariant'];
    return `<div class="row"><div class="num">${String(index + 1).padStart(2, '0')}</div><div class="copy">${words[index % words.length]} — textured row ${index * 37 % 101}</div><div class="micro"></div></div>`;
  }).join('');
}

function sampleOffsetsForBrowser(): Record<string, Array<[number, number]>> {
  return phases.reduce<Record<string, Array<[number, number]>>>((acc, phase, index) => {
    if (phase.stepId === 2 && phase.phase === 'transition') {
      acc[String(index)] = [[0, -185], [0.22, -40], [0.48, -265], [0.72, -70], [1, -245]];
    } else if (phase.stepId === 3 && phase.phase === 'transition') {
      acc[String(index)] = [[0, -245], [0.41, -245], [0.43, -385], [1, -400]];
    } else {
      acc[String(index)] = [[0, phase.offsetAt(0)], [1, phase.offsetAt(1)]];
    }
    return acc;
  }, {});
}

function assertContractFindings(report: AnalyzerReport): void {
  assert.equal(report.video.width, VIEWPORT.width);
  assert.equal(report.video.height, VIEWPORT.height);
  assert.ok(report.video.frameCount >= 50, `expected enough decoded samples, got ${report.video.frameCount}`);
  assertHasFinding(report, 'oscillation', 2);
  assertHasFinding(report, 'jump', 3);
  assertHasFinding(report, 'no-motion', 4);
  assertNoFinding(report, 'oscillation', 1);
  assertNoFinding(report, 'jump', 1);
  assertNoFinding(report, 'no-motion', 1);
  assertNoFinding(report, 'marker-absent');
  assertNoFinding(report, 'marker-ambiguous');
  assertNoFinding(report, 'missing-required-step');
  const contactSheet = report.evidence.contactSheet;
  assert.ok(contactSheet, 'expected contact sheet evidence');
  assert.ok(report.evidence.frames.length >= 3, 'expected selected evidence frames');
}

function assertHasFinding(report: AnalyzerReport, code: FindingCode, stepId?: number): void {
  assert.ok(
    report.findings.some((finding) => finding.code === code && (stepId === undefined || finding.stepId === stepId)),
    `expected finding ${code}${stepId === undefined ? '' : ` for step ${stepId}`}; got ${JSON.stringify(report.findings.map((finding) => ({ code: finding.code, stepId: finding.stepId })))}`,
  );
}

function assertNoFinding(report: AnalyzerReport, code: FindingCode, stepId?: number): void {
  assert.ok(
    !report.findings.some((finding) => finding.code === code && (stepId === undefined || finding.stepId === stepId)),
    `did not expect finding ${code}${stepId === undefined ? '' : ` for step ${stepId}`}`,
  );
}

function totalDurationMs(): number {
  return phases.reduce((sum, phase) => sum + phase.durationMs, 0);
}

function easeInOut(progress: number): number {
  return progress < 0.5 ? 2 * progress * progress : 1 - ((-2 * progress + 2) ** 2) / 2;
}

function interpolateStops(progress: number, stops: Array<[number, number]>): number {
  for (let index = 1; index < stops.length; index += 1) {
    const previous = stops[index - 1];
    const next = stops[index];
    if (!previous || !next) {
      continue;
    }
    if (progress <= next[0]) {
      const local = (progress - previous[0]) / (next[0] - previous[0]);
      return previous[1] + (next[1] - previous[1]) * local;
    }
  }
  return stops.at(-1)?.[1] ?? 0;
}
