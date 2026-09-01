#!/usr/bin/env npx tsx
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { basename, dirname, resolve } from 'node:path';
import { formatWorkbookUxPreparationMessage, recordWorkbookUxTest, type WorkbookUxTestRecorderOptions, type WorkbookUxTestRecorderResult } from './record.mjs';
import { deterministicContractFailures, writeUxTestReport, type UxTestStationResult, type SerializedError } from './report.js';
import { formatWorkbookUxStage, type WorkbookUxProgressEvent, type WorkbookUxProgressSink } from './progress.js';
import { runAiReview, type AiReviewResult } from './review-ai.js';

export interface WorkbookUxTestRunOptions extends WorkbookUxTestRecorderOptions {
  ai?: boolean;
  aiCommand?: string;
  aiModel?: string;
  aiTimeoutMs?: number;
}

export interface WorkbookUxTestRunDeps {
  record?: (options: WorkbookUxTestRecorderOptions) => Promise<WorkbookUxTestRecorderResult>;
  ai?: (options: { runRoot: string; command?: string; model?: string; timeoutMs?: number }) => Promise<AiReviewResult>;
  report?: typeof writeUxTestReport;
}

export interface WorkbookUxTestRunResult {
  runRoot: string;
  exitCode: number;
  deterministicPassed: boolean;
  stations: UxTestStationResult[];
  reportPath: string;
  resultPath: string;
  ai?: AiReviewResult | { requested: false; status: 'skipped'; reason: string };
}

const ENGINE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DEFAULT_RUN_ROOT = resolve(ENGINE_ROOT, 'test/.tmp/workbook-ux/latest');

export async function runWorkbookUxTest(options: WorkbookUxTestRunOptions = {}, deps: WorkbookUxTestRunDeps = {}): Promise<WorkbookUxTestRunResult> {
  const runStartedAtMs = Date.now();
  const runStartedAt = new Date(runStartedAtMs).toISOString();
  const runRoot = resolve(options.runRoot ?? DEFAULT_RUN_ROOT);
  const progress = options.progress;
  const stations: UxTestStationResult[] = [];
  const recordStationStartMs = Date.now();
  const recordStationStartedAt = new Date(recordStationStartMs).toISOString();
  const record = deps.record ?? recordWorkbookUxTest;
  let deterministicPassed = false;
  let deterministicError: SerializedError | undefined;

  try {
    progress?.({ type: 'stage', phase: 'prepare', stage: 1, totalStages: 5, message: formatWorkbookUxStage(1, 5, formatWorkbookUxPreparationMessage(options.headless)) });
    await record({ runRoot, analyze: true, headless: options.headless, progress: createRunRecordProgress(progress) });
    const contractFailures = await deterministicContractFailures(runRoot);
    if (contractFailures.length > 0) {
      throw new Error(`Workbook UX deterministic artifact contract failed:\n${contractFailures.map((failure) => ` - ${failure}`).join('\n')}`);
    }
    deterministicPassed = true;
    stations.push(station('record-and-deterministic-analysis', 'passed', recordStationStartedAt, recordStationStartMs));
    progress?.({ type: 'status', phase: 'deterministic', status: 'passed', message: 'Deterministic recording and analysis passed.' });
  } catch (error) {
    deterministicError = serializeError(error);
    stations.push(station('record-and-deterministic-analysis', 'failed', recordStationStartedAt, recordStationStartMs, deterministicError));
    progress?.({ type: 'status', phase: 'deterministic', status: 'failed', message: `Deterministic recording/analysis failed: ${deterministicError.message}` });
  }

  let ai: WorkbookUxTestRunResult['ai'];
  if (!options.ai) {
    ai = { requested: false, status: 'skipped', reason: 'AI review disabled by CLI.' };
    progress?.({ type: 'stage', phase: 'ai', stage: 4, totalStages: 5, message: formatWorkbookUxStage(4, 5, 'Advisory AI review skipped (--no-ai).') });
    stations.push(skippedStation('advisory-ai-review', 'AI review disabled by CLI.'));
  } else if (!deterministicPassed) {
    ai = { requested: false, status: 'skipped', reason: 'AI review skipped because deterministic station failed.' };
    progress?.({ type: 'stage', phase: 'ai', stage: 4, totalStages: 5, message: formatWorkbookUxStage(4, 5, 'Advisory AI review skipped because deterministic station failed.') });
    stations.push(skippedStation('advisory-ai-review', 'Deterministic station failed.'));
  } else {
    const aiStationStartMs = Date.now();
    const aiStationStartedAt = new Date(aiStationStartMs).toISOString();
    progress?.({ type: 'stage', phase: 'ai', stage: 4, totalStages: 5, message: formatWorkbookUxStage(4, 5, `Running advisory AI review (timeout: ${formatSeconds(options.aiTimeoutMs ?? 180_000)})...`) });
    try {
      ai = await (deps.ai ?? ((aiOptions) => runAiReview(aiOptions)))({
        runRoot,
        command: options.aiCommand,
        model: options.aiModel,
        timeoutMs: options.aiTimeoutMs,
      });
    } catch (error) {
      ai = await aiUnavailableFromThrownError(runRoot, options.aiCommand ?? 'pi', error, aiStationStartedAt, aiStationStartMs);
    }
    if (ai.status === 'available') progress?.({ type: 'status', phase: 'ai', status: 'passed', message: 'Advisory AI review complete.' });
    else progress?.({ type: 'status', phase: 'ai', status: 'unavailable', message: `Advisory AI review unavailable: ${ai.reason ?? 'no reason supplied.'}` });
    stations.push(station('advisory-ai-review', ai.status === 'available' ? 'passed' : 'unavailable', aiStationStartedAt, aiStationStartMs, ai.reason ? { message: ai.reason } : undefined));
  }

  const runFinishedAt = new Date().toISOString();
  progress?.({ type: 'stage', phase: 'report', stage: 5, totalStages: 5, message: formatWorkbookUxStage(5, 5, 'Writing report...') });
  const reportResult = await (deps.report ?? writeUxTestReport)({
    runRoot,
    startedAt: runStartedAt,
    finishedAt: runFinishedAt,
    stations,
    deterministicPassed,
    deterministicError,
    aiRequested: Boolean(options.ai),
    ai,
  });

  return {
    runRoot,
    exitCode: reportResult.result.exitCode,
    deterministicPassed: reportResult.result.deterministic.ok,
    stations,
    reportPath: reportResult.reportPath,
    resultPath: reportResult.resultPath,
    ai,
  };
}

export function parseWorkbookUxCliOptions(argv: readonly string[]): WorkbookUxTestRunOptions {
  let ai = false;
  let headless = true;
  let runRoot: string | undefined;
  let aiCommand: string | undefined;
  let aiModel: string | undefined;
  let aiTimeoutMs: number | undefined;

  for (const arg of argv) {
    if (arg === '--ai') ai = true;
    else if (arg === '--no-ai') ai = false;
    else if (arg === '--headed') headless = false;
    else if (arg.startsWith('--run-root=')) runRoot = resolve(arg.slice('--run-root='.length));
    else if (arg.startsWith('--ai-command=')) aiCommand = arg.slice('--ai-command='.length);
    else if (arg.startsWith('--ai-model=')) aiModel = arg.slice('--ai-model='.length);
    else if (arg.startsWith('--ai-timeout-ms=')) aiTimeoutMs = Number(arg.slice('--ai-timeout-ms='.length));
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown workbook UX test option: ${arg}`);
    }
  }

  if (aiTimeoutMs !== undefined && (!Number.isFinite(aiTimeoutMs) || aiTimeoutMs <= 0)) {
    throw new Error(`--ai-timeout-ms must be a positive finite number; got ${aiTimeoutMs}`);
  }

  return { ai, headless, runRoot, aiCommand, aiModel, aiTimeoutMs, analyze: true };
}

function createRunRecordProgress(progress: WorkbookUxProgressSink | undefined): WorkbookUxProgressSink | undefined {
  if (!progress) return undefined;
  let recordingStagePrinted = false;
  let decodeStagePrinted = false;
  return (event: WorkbookUxProgressEvent) => {
    if (event.type === 'stage' && event.phase === 'prepare') return;
    if (event.type === 'stage' && event.phase === 'record') {
      if (recordingStagePrinted) return;
      recordingStagePrinted = true;
      progress({ ...event, stage: 2, totalStages: 5, message: formatWorkbookUxStage(2, 5, event.message) });
      return;
    }
    if (event.type === 'stage' && event.phase === 'decode') {
      if (decodeStagePrinted) return;
      decodeStagePrinted = true;
      progress({ ...event, stage: 3, totalStages: 5, message: formatWorkbookUxStage(3, 5, event.message) });
      return;
    }
    if (event.type === 'status' && event.phase === 'deterministic') return;
    progress(event);
  };
}

function formatSeconds(milliseconds: number): string {
  const seconds = milliseconds / 1_000;
  return Number.isInteger(seconds) ? `${seconds}s` : `${seconds.toFixed(1)}s`;
}

function station(name: string, status: UxTestStationResult['status'], startedAt: string, startedAtMs: number, error?: SerializedError): UxTestStationResult {
  const finishedAtMs = Date.now();
  return { name, status, startedAt, finishedAt: new Date(finishedAtMs).toISOString(), durationMs: finishedAtMs - startedAtMs, error };
}

function skippedStation(name: string, reason: string): UxTestStationResult {
  const now = new Date().toISOString();
  return { name, status: 'skipped', startedAt: now, finishedAt: now, durationMs: 0, error: { message: reason } };
}

async function aiUnavailableFromThrownError(runRoot: string, command: string, error: unknown, startedAt: string, startedAtMs: number): Promise<AiReviewResult> {
  const serialized = serializeError(error);
  const finishedAtMs = Date.now();
  const reviewPath = resolve(runRoot, 'ai-review.md');
  const stderrPath = resolve(runRoot, 'ai-review.stderr.txt');
  const jsonPath = resolve(runRoot, 'ai-review.json');
  const result: AiReviewResult = {
    requested: true,
    status: 'unavailable',
    reason: `AI review threw: ${serialized.message}`,
    command,
    args: [],
    startedAt,
    finishedAt: new Date(finishedAtMs).toISOString(),
    durationMs: finishedAtMs - startedAtMs,
    stdoutPath: reviewPath,
    stderrPath,
    jsonPath,
    reviewPath,
    attachmentPaths: [],
    outputBytes: 0,
  };
  await Promise.allSettled([
    writeFile(reviewPath, ''),
    writeFile(stderrPath, `${serialized.message}\n${serialized.stack ?? ''}`),
    writeFile(jsonPath, `${JSON.stringify(result, null, 2)}\n`),
  ]);
  return result;
}

function serializeError(error: unknown): SerializedError {
  return error instanceof Error ? { message: error.message, stack: error.stack } : { message: String(error) };
}

function printHelp(): void {
  console.log(`Usage: tsx test/workbook-ux/run.mts [--ai|--no-ai] [--headed] [--run-root=PATH] [--ai-command=pi] [--ai-model=MODEL] [--ai-timeout-ms=MS]\n\nRuns the workbook UX test: checked-out engine input -> provider-free fixture walkthrough/WebM -> deterministic decoded-WebM analysis -> optional advisory pi review -> durable report. AI is opt-in; omit --ai or pass --no-ai to skip it.\n\nExit is nonzero only when the recording/deterministic station fails. AI unavailability or findings never gate exit.`);
}

const consoleProgress: WorkbookUxProgressSink = (event) => console.log(event.message);

if (basename(process.argv[1] ?? '') === 'run.mts') {
  runWorkbookUxTest({ ...parseWorkbookUxCliOptions(process.argv.slice(2)), progress: consoleProgress }).then((result) => {
    console.log(`Deterministic verdict: ${result.deterministicPassed ? 'PASSED' : 'FAILED'}`);
    console.log(`Exit verdict: ${result.exitCode === 0 ? 'PASS' : 'FAIL'} (exit code ${result.exitCode})`);
    console.log(`Report: ${result.reportPath}`);
    console.log(`Result JSON: ${result.resultPath}`);
    process.exitCode = result.exitCode;
  }).catch((error) => {
    console.error('Workbook UX test failed before report writing.');
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
