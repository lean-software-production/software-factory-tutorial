import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AnalyzerReport } from './analyzer.js';
import { writeUxTestReport, type UxTestStationResult } from './report.js';
import { parseWorkbookUxCliOptions, runWorkbookUxTest } from './run.mjs';
import { buildPiArgs, runAiReview, type AiReviewResult, type ExecFileRunner } from './review-ai.js';
import { formatWorkbookUxPreparationMessage, type WorkbookUxTestRecorderOptions, type WorkbookUxTestRecorderResult, type WorkbookUxTestWalkthrough } from './record.mjs';

const now = '2026-01-02T03:04:05.000Z';
const engineRoot = resolve(import.meta.dirname, '../..');

type PackageJson = { scripts: Record<string, string> };

async function readPackageJson(path: string): Promise<PackageJson> {
  return JSON.parse(await readFile(path, 'utf8')) as PackageJson;
}

function requiredScript(manifest: PackageJson, name: string): string {
  const script = manifest.scripts[name];
  expect(script, `${name} script is not declared`).toBeDefined();
  return script as string;
}

describe('workbook UX package and CLI contracts', () => {
  it('keeps the ordinary package script deterministic and exposes explicit AI opt-in', async () => {
    const manifest = await readPackageJson(resolve(engineRoot, 'package.json'));

    expect(requiredScript(manifest, 'test:workbook-ux')).toBe('tsx test/workbook-ux/run.mts --no-ai');
    expect(requiredScript(manifest, 'test:workbook-ux:deterministic')).toBe('tsx test/workbook-ux/run.mts --no-ai');
    expect(requiredScript(manifest, 'test:workbook-ux:ai')).toBe('tsx test/workbook-ux/run.mts --ai');
    expect(requiredScript(manifest, 'test:workbook-ux:record')).toBe('tsx test/workbook-ux/record.mts --record-only');
    expect(requiredScript(manifest, 'test:workbook-ux:analyser')).toBe('tsx test/workbook-ux/synthetic-contract.mts');
  });

  it('keeps the CLI default no-AI while preserving explicit --ai opt-in', () => {
    expect(parseWorkbookUxCliOptions([])).toMatchObject({ ai: false, headless: true, analyze: true });
    expect(parseWorkbookUxCliOptions(['--no-ai'])).toMatchObject({ ai: false, headless: true, analyze: true });
    expect(parseWorkbookUxCliOptions(['--ai'])).toMatchObject({ ai: true, headless: true, analyze: true });
  });

  it('documents AI as an explicit opt-in without masking deterministic failures', async () => {
    const engineReadme = await readFile(resolve(engineRoot, 'README.md'), 'utf8');
    const uxReadme = await readFile(resolve(engineRoot, 'test/workbook-ux/README.md'), 'utf8');

    expect(engineReadme).toContain('npm run test:workbook-ux:ai');
    expect(uxReadme).toContain('test:workbook-ux:ai` is the deliberate manual/weekly opt-in');
    expect(uxReadme).not.toContain('test:workbook-ux:ai || true');
  });
});

describe('workbook UX test report', () => {
  it('writes pass reports with authoritative deterministic verdict', async () => {
    const runRoot = await fixtureRunRoot({ motionOk: true });
    const stationResults = [station('record-and-deterministic-analysis', 'passed')];
    const { result, reportPath, resultPath } = await writeUxTestReport({
      runRoot,
      startedAt: now,
      finishedAt: now,
      stations: stationResults,
      deterministicPassed: true,
      aiRequested: false,
      ai: { requested: false, status: 'skipped', reason: 'test' },
    });

    expect(reportPath).toBe(resolve(runRoot, 'report.md'));
    expect(resultPath).toBe(resolve(runRoot, 'ux-test-result.json'));
    expect(result.exitCode).toBe(0);
    expect(result.deterministicVerdict).toBe('passed');
  });

  it('writes failure reports from partial artifacts without crashing', async () => {
    const runRoot = await fixtureRunRoot({ motionOk: false, semanticFailures: ['feedback is occluded'] });
    const { result } = await writeUxTestReport({
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
    const { result } = await writeUxTestReport({
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

    const { result } = await writeUxTestReport({
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

    const { result } = await writeUxTestReport({
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

    const { result } = await writeUxTestReport({
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

describe('workbook UX test AI review', () => {
  it('builds pi args with no tools/session, low thinking, and evidence attachments', () => {
    const args = buildPiArgs({ attachments: ['analysis/contact-sheet.png', 'ai-walkthrough-summary.json', 'analysis/motion.json', 'analysis/frame.png'], prompt: 'review' });

    expect(args.slice(0, 5)).toEqual(['-p', '-nt', '--no-session', '--thinking', 'low']);
    expect(args).toEqual(expect.arrayContaining(['@analysis/contact-sheet.png', '@ai-walkthrough-summary.json', '@analysis/motion.json', '@analysis/frame.png', 'review']));
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
    expect(calls[0]?.args.slice(0, 5)).toEqual(['-p', '-nt', '--no-session', '--thinking', 'low']);
    expect(calls[0]?.args).toEqual(expect.arrayContaining(['@analysis/contact-sheet.png', '@ai-walkthrough-summary.json', '@analysis/motion.json']));
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

describe('workbook UX test orchestration', () => {
  it('emits ordered progress for a full deterministic plus AI run', async () => {
    const runRoot = await fixtureRunRoot({ motionOk: true });
    const messages: string[] = [];

    const result = await runWorkbookUxTest({ runRoot, ai: true, progress: (event) => messages.push(event.message) }, {
      record: async (options) => progressRecorder(options, runRoot),
      ai: async () => aiAvailable(runRoot),
    });

    expect(result.exitCode).toBe(0);
    expect(messages).toEqual(expect.arrayContaining([
      '[1/5] Preparing fixture, local server, and headless browser...',
      '[2/5] Recording browser journey (12 checkpoints)...',
      'Checkpoint 1/12: editor reveal scroll to small activity band',
      '[3/5] Decoding and analysing recorded video (this can take several minutes)...',
      'Deterministic recording and analysis passed.',
      '[4/5] Running advisory AI review (timeout: 180s)...',
      'Advisory AI review complete.',
      '[5/5] Writing report...',
    ]));
    expectInOrder(messages, [
      '[1/5] Preparing fixture, local server, and headless browser...',
      '[2/5] Recording browser journey (12 checkpoints)...',
      'Checkpoint 1/12: editor reveal scroll to small activity band',
      '[3/5] Decoding and analysing recorded video (this can take several minutes)...',
      '[4/5] Running advisory AI review (timeout: 180s)...',
      '[5/5] Writing report...',
    ]);
  });

  it('reports headed browser preparation when headed without launching a browser', async () => {
    const runRoot = await fixtureRunRoot({ motionOk: true });
    const messages: string[] = [];
    let recorderHeadless: boolean | undefined;

    const result = await runWorkbookUxTest({ runRoot, ai: false, headless: false, progress: (event) => messages.push(event.message) }, {
      record: async (options) => {
        recorderHeadless = options.headless;
        return recorderResult(runRoot);
      },
    });

    expect(result.exitCode).toBe(0);
    expect(recorderHeadless).toBe(false);
    expect(messages).toContain('[1/5] Preparing fixture, local server, and headed browser...');
    expect(messages).not.toContain('[1/5] Preparing fixture, local server, and headless browser...');
    expect(formatWorkbookUxPreparationMessage(false)).toBe('Preparing fixture, local server, and headed browser...');
    expect(formatWorkbookUxPreparationMessage(undefined)).toBe('Preparing fixture, local server, and headless browser...');
  });

  it('emits an explicit AI skipped stage for no-AI runs', async () => {
    const runRoot = await fixtureRunRoot({ motionOk: true });
    const messages: string[] = [];
    let aiCalls = 0;

    const result = await runWorkbookUxTest({ runRoot, ai: false, progress: (event) => messages.push(event.message) }, {
      record: async (options) => progressRecorder(options, runRoot),
      ai: async () => { aiCalls += 1; return aiAvailable(runRoot); },
    });

    expect(result.exitCode).toBe(0);
    expect(aiCalls).toBe(0);
    expect(messages).toContain('[4/5] Advisory AI review skipped (--no-ai).');
    expectInOrder(messages, [
      '[3/5] Decoding and analysing recorded video (this can take several minutes)...',
      '[4/5] Advisory AI review skipped (--no-ai).',
      '[5/5] Writing report...',
    ]);
  });

  it('emits unavailable AI as advisory progress without failing exit', async () => {
    const runRoot = await fixtureRunRoot({ motionOk: true });
    const messages: string[] = [];

    const result = await runWorkbookUxTest({ runRoot, ai: true, progress: (event) => messages.push(event.message) }, {
      record: async (options) => progressRecorder(options, runRoot),
      ai: async () => aiUnavailable(runRoot, 'provider unavailable'),
    });

    expect(result.exitCode).toBe(0);
    expect(messages).toContain('Advisory AI review unavailable: provider unavailable');
    expect(messages.filter((message) => message === 'Advisory AI review unavailable: provider unavailable')).toHaveLength(1);
    expectInOrder(messages, [
      '[4/5] Running advisory AI review (timeout: 180s)...',
      'Advisory AI review unavailable: provider unavailable',
      '[5/5] Writing report...',
    ]);
  });

  it('emits deterministic failure, AI skip, and report stages in order', async () => {
    const runRoot = await fixtureRunRoot({ motionOk: false, semanticFailures: ['bad geometry'] });
    const messages: string[] = [];

    const result = await runWorkbookUxTest({ runRoot, ai: true, progress: (event) => messages.push(event.message) }, {
      record: async (options) => {
        options.progress?.({ type: 'stage', phase: 'record', message: 'Recording browser journey (12 checkpoints)...' });
        throw new Error('deterministic station failed');
      },
    });

    expect(result.exitCode).toBe(1);
    expect(messages.some((message) => message.startsWith('Deterministic recording/analysis failed: deterministic station failed'))).toBe(true);
    expect(messages).toContain('[4/5] Advisory AI review skipped because deterministic station failed.');
    expectInOrder(messages, [
      '[1/5] Preparing fixture, local server, and headless browser...',
      '[2/5] Recording browser journey (12 checkpoints)...',
      '[4/5] Advisory AI review skipped because deterministic station failed.',
      '[5/5] Writing report...',
    ]);
  });

  it('does not call AI when deterministic recording/analyzer fails', async () => {
    const runRoot = await fixtureRunRoot({ motionOk: false, semanticFailures: ['bad geometry'] });
    let aiCalls = 0;

    const result = await runWorkbookUxTest({ runRoot, ai: true }, {
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

    const result = await runWorkbookUxTest({ runRoot, ai: true }, {
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

    const result = await runWorkbookUxTest({ runRoot, ai: true }, {
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

    const result = await runWorkbookUxTest({ runRoot, ai: true }, {
      record: async () => recorderResult(runRoot),
      ai: async () => { throw new Error('prompt template read exploded'); },
    });

    expect(result.exitCode).toBe(0);
    expect(result.deterministicPassed).toBe(true);
    expect(result.ai?.status).toBe('unavailable');
    expect(result.ai && 'reason' in result.ai ? result.ai.reason : '').toContain('prompt template read exploded');
    await expect(readFile(resolve(runRoot, 'report.md'), 'utf8')).resolves.toContain('AI review (advisory)');
    await expect(readFile(resolve(runRoot, 'ux-test-result.json'), 'utf8')).resolves.toContain('prompt template read exploded');
  });
});

async function fixtureRunRoot(options: { motionOk: boolean; semanticFailures?: string[] }): Promise<string> {
  const runRoot = await mkdtemp(resolve(tmpdir(), 'workbook-ux-test-'));
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
    await writeFile(resolve(runRoot, 'recording-error.json'), JSON.stringify({ message: 'Workbook UX test deterministic run failed.', failures: options.semanticFailures ?? [], walkthrough }));
  }
  return runRoot;
}

function walkthroughFixture(runRoot: string, semanticFailures: string[]): WorkbookUxTestWalkthrough {
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

function recorderResult(runRoot: string): WorkbookUxTestRecorderResult {
  const walkthrough = walkthroughFixture(runRoot, []);
  return { runRoot, videoPath: resolve(runRoot, 'walkthrough.webm'), walkthroughPath: resolve(runRoot, 'walkthrough.json'), analysis: motionFixture(runRoot, true), walkthrough };
}

async function progressRecorder(options: WorkbookUxTestRecorderOptions, runRoot: string): Promise<WorkbookUxTestRecorderResult> {
  options.progress?.({ type: 'stage', phase: 'record', message: 'Recording browser journey (12 checkpoints)...' });
  options.progress?.({ type: 'checkpoint', completed: 1, total: 12, stepId: 31, stepName: 'editor reveal scroll to small activity band', message: 'Checkpoint 1/12: editor reveal scroll to small activity band' });
  options.progress?.({ type: 'stage', phase: 'decode', message: 'Decoding and analysing recorded video (this can take several minutes)...' });
  return recorderResult(runRoot);
}

function expectInOrder(haystack: readonly string[], needles: readonly string[]): void {
  let previousIndex = -1;
  for (const needle of needles) {
    const index = haystack.findIndex((message, candidateIndex) => candidateIndex > previousIndex && message === needle);
    expect(index, `missing progress message after index ${previousIndex}: ${needle}`).toBeGreaterThan(previousIndex);
    previousIndex = index;
  }
}

function geometry(scrollY: number, expand: number) {
  const rect = { x: 0, y: 0, width: 100, height: 100, top: 0, right: 100, bottom: 100, left: 0 };
  return { expand, scrollY, bandDocumentTop: 300, bandRect: rect, workRect: rect, mainRect: rect };
}

function station(name: string, status: UxTestStationResult['status']): UxTestStationResult {
  return { name, status, startedAt: now, finishedAt: now, durationMs: 0 };
}

function aiAvailable(runRoot: string): AiReviewResult {
  return {
    requested: true,
    status: 'available',
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
    outputBytes: 10,
  };
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
