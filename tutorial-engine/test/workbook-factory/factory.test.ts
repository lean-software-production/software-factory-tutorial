import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AnalyzerReport } from './analyzer.js';
import { writeFactoryReport, type FactoryStationResult } from './report.js';
import { runWorkbookFactory } from './run.mjs';
import { buildPiArgs, runAiReview, type AiReviewResult, type ExecFileRunner } from './review-ai.js';
import type { WorkbookFactoryRecorderResult, WorkbookFactoryWalkthrough } from './record.mjs';

const now = '2026-01-02T03:04:05.000Z';

describe('workbook factory report', () => {
  it('writes pass reports with authoritative deterministic verdict', async () => {
    const runRoot = await fixtureRunRoot({ motionOk: true });
    const stationResults = [station('record-and-deterministic-analysis', 'passed')];
    const { result, reportPath, resultPath } = await writeFactoryReport({
      runRoot,
      startedAt: now,
      finishedAt: now,
      stations: stationResults,
      deterministicPassed: true,
      aiRequested: false,
      ai: { requested: false, status: 'skipped', reason: 'test' },
    });

    expect(reportPath).toBe(resolve(runRoot, 'report.md'));
    expect(resultPath).toBe(resolve(runRoot, 'factory-result.json'));
    expect(result.exitCode).toBe(0);
    expect(result.deterministicVerdict).toBe('passed');
  });

  it('writes failure reports from partial artifacts without crashing', async () => {
    const runRoot = await fixtureRunRoot({ motionOk: false, semanticFailures: ['feedback is occluded'] });
    const { result } = await writeFactoryReport({
      runRoot,
      startedAt: now,
      finishedAt: now,
      stations: [station('record-and-deterministic-analysis', 'failed')],
      deterministicPassed: false,
      deterministicError: { message: 'deterministic failed' },
      aiRequested: false,
      ai: { requested: false, status: 'skipped', reason: 'deterministic failed' },
    });

    expect(result.exitCode).toBe(1);
    expect(result.deterministic.semanticFailures).toContain('feedback is occluded');
    expect(result.deterministic.findings).toMatchObject([{ code: 'jump', stepId: 3 }]);
  });

  it('records unavailable AI as advisory without failing deterministic pass', async () => {
    const runRoot = await fixtureRunRoot({ motionOk: true });
    const ai: AiReviewResult = aiUnavailable(runRoot, 'quota limited');
    const { result } = await writeFactoryReport({
      runRoot,
      startedAt: now,
      finishedAt: now,
      stations: [station('record-and-deterministic-analysis', 'passed'), station('advisory-ai-review', 'unavailable')],
      deterministicPassed: true,
      aiRequested: true,
      ai,
    });

    expect(result.exitCode).toBe(0);
    expect(result.aiStatus).toBe('unavailable');
    expect(result.deterministicVerdict).toBe('passed');
  });

  it.each([
    ['missing walkthrough', 'walkthrough.json'],
    ['missing video', 'walkthrough.webm'],
    ['missing contact sheet', 'analysis/contact-sheet.png'],
  ])('fails closed when deterministicPassed=true but %s is absent', async (_label, artifact) => {
    const runRoot = await fixtureRunRoot({ motionOk: true });
    await rm(resolve(runRoot, artifact), { force: true });

    const { result } = await writeFactoryReport({
      runRoot,
      startedAt: now,
      finishedAt: now,
      stations: [station('record-and-deterministic-analysis', 'passed')],
      deterministicPassed: true,
      aiRequested: false,
      ai: { requested: false, status: 'skipped', reason: 'test' },
    });

    expect(result.exitCode).toBe(1);
    expect(result.deterministicVerdict).toBe('failed');
    expect(result.deterministic.semanticFailures.join('\n')).toMatch(/Required deterministic artifact missing/);
    expect(result.artifacts[artifact === 'walkthrough.webm' ? 'video' : artifact === 'walkthrough.json' ? 'walkthrough' : 'contactSheet']).toBeUndefined();
  });

  it('fails closed when deterministicPassed=true but motion is missing', async () => {
    const runRoot = await fixtureRunRoot({ motionOk: true });
    await rm(resolve(runRoot, 'analysis/motion.json'), { force: true });

    const { result } = await writeFactoryReport({
      runRoot,
      startedAt: now,
      finishedAt: now,
      stations: [station('record-and-deterministic-analysis', 'passed')],
      deterministicPassed: true,
      aiRequested: false,
      ai: { requested: false, status: 'skipped', reason: 'test' },
    });

    expect(result.exitCode).toBe(1);
    expect(result.deterministic.semanticFailures).toContain('Required deterministic artifact missing: analysis/motion.json.');
    expect(result.artifacts.motion).toBeUndefined();
  });

  it('fails closed when deterministicPassed=true but motion is corrupt', async () => {
    const runRoot = await fixtureRunRoot({ motionOk: true });
    await writeFile(resolve(runRoot, 'analysis/motion.json'), '{not json');

    const { result } = await writeFactoryReport({
      runRoot,
      startedAt: now,
      finishedAt: now,
      stations: [station('record-and-deterministic-analysis', 'passed')],
      deterministicPassed: true,
      aiRequested: false,
      ai: { requested: false, status: 'skipped', reason: 'test' },
    });

    expect(result.exitCode).toBe(1);
    expect(result.deterministic.semanticFailures.join('\n')).toContain('Required deterministic artifact is corrupt: analysis/motion.json');
    expect(result.artifacts.motion).toBe('analysis/motion.json');
  });
});

describe('workbook factory AI review', () => {
  it('builds pi args with no tools/session and evidence attachments', () => {
    const args = buildPiArgs({ attachments: ['analysis/contact-sheet.png', 'ai-walkthrough-summary.json', 'analysis/motion.json', 'analysis/frame.png'], prompt: 'review' });

    expect(args).toEqual(expect.arrayContaining(['-p', '-nt', '--no-session', '@analysis/contact-sheet.png', '@ai-walkthrough-summary.json', '@analysis/motion.json', '@analysis/frame.png', 'review']));
  });

  it('captures nonzero pi as unavailable while preserving stdout/stderr artifacts', async () => {
    const runRoot = await fixtureRunRoot({ motionOk: true });
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner: ExecFileRunner = async (command, args) => {
      calls.push({ command, args });
      return { stdout: '@needs-human step 1 evidence', stderr: 'quota', exitCode: 1 };
    };

    const result = await runAiReview({ runRoot, command: 'fake-pi', execFileRunner: runner });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual(expect.arrayContaining(['-p', '-nt', '--no-session', '@analysis/contact-sheet.png', '@ai-walkthrough-summary.json', '@analysis/motion.json']));
    expect(calls[0]?.args).not.toContain('@walkthrough.json');
    expect(result.status).toBe('unavailable');
    expect(result.reason).toContain('nonzero');
  });

  it('omits absolute runRoot from AI prompt context and attaches provider-safe walkthrough summary', async () => {
    const runRoot = await fixtureRunRoot({ motionOk: true });
    let prompt = '';
    const runner: ExecFileRunner = async (_command, args) => {
      prompt = args.at(-1) ?? '';
      return { stdout: '@needs-human no scoped issues', stderr: '', exitCode: 0 };
    };

    const result = await runAiReview({ runRoot, command: 'fake-pi', execFileRunner: runner });
    const summary = await readFile(resolve(runRoot, 'ai-walkthrough-summary.json'), 'utf8');

    expect(result.status).toBe('available');
    expect(prompt).not.toContain(runRoot);
    expect(summary).not.toContain(runRoot);
    expect(summary).toContain('editor scroll to mid');
  });
});

describe('workbook factory orchestration', () => {
  it('does not call AI when deterministic recording/analyzer fails', async () => {
    const runRoot = await fixtureRunRoot({ motionOk: false, semanticFailures: ['bad geometry'] });
    let aiCalls = 0;

    const result = await runWorkbookFactory({ runRoot, ai: true }, {
      record: async () => { throw new Error('deterministic station failed'); },
      ai: async () => { aiCalls += 1; return aiUnavailable(runRoot, 'should not call'); },
    });

    expect(aiCalls).toBe(0);
    expect(result.exitCode).toBe(1);
    expect(result.ai?.status).toBe('skipped');
  });

  it('does not call AI when recorder returns but deterministic artifact contract is broken', async () => {
    const runRoot = await fixtureRunRoot({ motionOk: true });
    await rm(resolve(runRoot, 'analysis/motion.json'), { force: true });
    let aiCalls = 0;

    const result = await runWorkbookFactory({ runRoot, ai: true }, {
      record: async () => recorderResult(runRoot),
      ai: async () => { aiCalls += 1; return aiUnavailable(runRoot, 'should not call'); },
    });

    expect(aiCalls).toBe(0);
    expect(result.exitCode).toBe(1);
    expect(result.ai?.status).toBe('skipped');
  });

  it('leaves exit success when deterministic passed and AI is unavailable', async () => {
    const runRoot = await fixtureRunRoot({ motionOk: true });
    let aiCalls = 0;

    const result = await runWorkbookFactory({ runRoot, ai: true }, {
      record: async () => recorderResult(runRoot),
      ai: async () => { aiCalls += 1; return aiUnavailable(runRoot, 'provider unavailable'); },
    });

    expect(aiCalls).toBe(1);
    expect(result.exitCode).toBe(0);
    expect(result.deterministicPassed).toBe(true);
    expect(result.ai?.status).toBe('unavailable');
  });

  it('converts thrown AI bugs into unavailable AI and still writes a passing deterministic report', async () => {
    const runRoot = await fixtureRunRoot({ motionOk: true });

    const result = await runWorkbookFactory({ runRoot, ai: true }, {
      record: async () => recorderResult(runRoot),
      ai: async () => { throw new Error('prompt template read exploded'); },
    });

    expect(result.exitCode).toBe(0);
    expect(result.deterministicPassed).toBe(true);
    expect(result.ai?.status).toBe('unavailable');
    expect(result.ai && 'reason' in result.ai ? result.ai.reason : '').toContain('prompt template read exploded');
    await expect(readFile(resolve(runRoot, 'report.md'), 'utf8')).resolves.toContain('AI review (advisory)');
    await expect(readFile(resolve(runRoot, 'factory-result.json'), 'utf8')).resolves.toContain('prompt template read exploded');
  });
});

async function fixtureRunRoot(options: { motionOk: boolean; semanticFailures?: string[] }): Promise<string> {
  const runRoot = await mkdtemp(resolve(tmpdir(), 'wf-factory-test-'));
  await mkdir(resolve(runRoot, 'analysis'), { recursive: true });
  await writeFile(resolve(runRoot, 'input-metadata.json'), JSON.stringify({
    git: { sha: 'aa06ec1', dirty: false, status: [] },
    package: { name: '@lean-software-production/tutorial-engine', version: '0.1.0', playwright: '1.62.1' },
    browser: { name: 'playwright chromium', version: 'test' },
    viewport: { width: 1280, height: 900 },
  }));
  const walkthrough = walkthroughFixture(runRoot, options.semanticFailures ?? []);
  const motion = motionFixture(runRoot, options.motionOk);
  await writeFile(resolve(runRoot, 'walkthrough.json'), JSON.stringify(walkthrough));
  await writeFile(resolve(runRoot, 'walkthrough.webm'), 'fake video');
  await writeFile(resolve(runRoot, 'analysis/motion.json'), JSON.stringify(motion));
  await writeFile(resolve(runRoot, 'analysis/contact-sheet.png'), 'fake png');
  await writeFile(resolve(runRoot, 'analysis/step-3-mid.png'), 'fake png');
  if (!options.motionOk || options.semanticFailures?.length) {
    await writeFile(resolve(runRoot, 'recording-error.json'), JSON.stringify({ message: 'Workbook factory deterministic run failed.', failures: options.semanticFailures ?? [], walkthrough }));
  }
  return runRoot;
}

function walkthroughFixture(runRoot: string, semanticFailures: string[]): WorkbookFactoryWalkthrough {
  return {
    generatedAt: now,
    runRoot,
    fixtureRoot: 'fixture',
    copiedFixtureRoot: 'input',
    videoPath: resolve(runRoot, 'walkthrough.webm'),
    viewport: { width: 1280, height: 900, deviceScaleFactor: 1, reducedMotion: 'no-preference' },
    markerProtocol: { bits: 6, stateCheckpointStepIds: [3], scrollCheckpointStepIds: [3], requiredMotionStepIds: [3] },
    checkpoints: [{
      stepId: 3,
      name: 'editor scroll to mid',
      surface: 'editor',
      requestedState: 'mid',
      kind: 'scroll',
      requiredMotion: true,
      startedAt: now,
      settledAt: now,
      marker: { transitionAt: now, settledAt: now },
      before: geometry(0, 0),
      after: geometry(300, 0.5),
      fakeCallCounts: { mainTutorReviews: 1, fakePtyCommands: 0 },
    }],
    fake: { mainTutorReviews: 1, ptyCommands: [] },
    semanticFailures,
  };
}

function motionFixture(runRoot: string, ok: boolean): AnalyzerReport {
  return {
    ok,
    videoPath: resolve(runRoot, 'walkthrough.webm'),
    outputDir: resolve(runRoot, 'analysis'),
    generatedAt: now,
    markerProtocolVersion: 1,
    video: { width: 1280, height: 900, duration: 12.34, sampleHz: 11, frameCount: 120 },
    requiredMotionStepIds: [3],
    thresholds: {
      markerMaxColourDistance: 115,
      markerMinDistanceMargin: 30,
      stillnessMeanDifference: 8,
      minRequiredMotionPx: 28,
      jumpPx: 260,
      jumpViewportRatio: 0.55,
      jumpIsolationRatio: 2.2,
      oscillationMinShiftPx: 10,
      oscillationMinTotalPx: 120,
      minTextureScore: 4,
      minMotionConfidence: 0.25,
      maxShiftPx: 900,
    },
    roi: { x: 0, y: 0, width: 1280, height: 900 },
    calibration: { motionScale: 1, effectiveThresholds: {}, marker: { maxColourDistance: 115, minDistanceMargin: 30 } },
    markerSamples: { valid: 100, invalid: 0, ignoredLeadingInvalid: 0, ignoredTrailingInvalid: 0 },
    segments: [{
      stepId: 3,
      startTime: 1,
      endTime: 2,
      frameIndexes: [10, 11, 12],
      motions: [],
      totalAbsShiftPx: ok ? 60 : 500,
      netShiftPx: 60,
      maxAdjacentShiftPx: ok ? 20 : 490,
      signReversals: 0,
      confidence: 0.95,
      lowConfidenceMotionCount: 0,
      texture: 8,
    }],
    findings: ok ? [] : [{ code: 'jump', stepId: 3, severity: 'error', message: 'abrupt jump', startTime: 1, endTime: 2 }],
    evidence: { frames: ['step-3-mid.png'], contactSheet: 'contact-sheet.png' },
  };
}

function recorderResult(runRoot: string): WorkbookFactoryRecorderResult {
  const walkthrough = walkthroughFixture(runRoot, []);
  return { runRoot, videoPath: resolve(runRoot, 'walkthrough.webm'), walkthroughPath: resolve(runRoot, 'walkthrough.json'), analysis: motionFixture(runRoot, true), walkthrough };
}

function geometry(scrollY: number, expand: number) {
  const rect = { x: 0, y: 0, width: 100, height: 100, top: 0, right: 100, bottom: 100, left: 0 };
  return { expand, scrollY, bandDocumentTop: 300, bandRect: rect, workRect: rect, mainRect: rect };
}

function station(name: string, status: FactoryStationResult['status']): FactoryStationResult {
  return { name, status, startedAt: now, finishedAt: now, durationMs: 0 };
}

function aiUnavailable(runRoot: string, reason: string): AiReviewResult {
  return {
    requested: true,
    status: 'unavailable',
    reason,
    command: 'fake-pi',
    args: [],
    startedAt: now,
    finishedAt: now,
    durationMs: 0,
    stdoutPath: resolve(runRoot, 'ai-review.md'),
    stderrPath: resolve(runRoot, 'ai-review.stderr.txt'),
    jsonPath: resolve(runRoot, 'ai-review.json'),
    reviewPath: resolve(runRoot, 'ai-review.md'),
    attachmentPaths: [],
    outputBytes: 0,
  };
}
