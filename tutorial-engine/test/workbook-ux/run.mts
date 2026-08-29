#!/usr/bin/env npx tsx
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { basename, dirname, resolve } from 'node:path';
import { recordWorkbookUxTest, type WorkbookUxTestRecorderOptions, type WorkbookUxTestRecorderResult } from './record.mjs';
import { deterministicContractFailures, writeUxTestReport, type UxTestStationResult, type SerializedError } from './report.js';
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
  const stations: UxTestStationResult[] = [];
  const recordStationStartMs = Date.now();
  const recordStationStartedAt = new Date(recordStationStartMs).toISOString();
  const record = deps.record ?? recordWorkbookUxTest;
  let deterministicPassed = false;
  let deterministicError: SerializedError | undefined;

  try {
    await record({ runRoot, analyze: true, headless: options.headless });
    const contractFailures = await deterministicContractFailures(runRoot);
    if (contractFailures.length > 0) {
      throw new Error(`Workbook UX deterministic artifact contract failed:\n${contractFailures.map((failure) => ` - ${failure}`).join('\n')}`);
    }
    deterministicPassed = true;
    stations.push(station('record-and-deterministic-analysis', 'passed', recordStationStartedAt, recordStationStartMs));
  } catch (error) {
    deterministicError = serializeError(error);
    stations.push(station('record-and-deterministic-analysis', 'failed', recordStationStartedAt, recordStationStartMs, deterministicError));
  }

  let ai: WorkbookUxTestRunResult['ai'];
  if (!options.ai) {
    ai = { requested: false, status: 'skipped', reason: 'AI review disabled by CLI.' };
    stations.push(skippedStation('advisory-ai-review', 'AI review disabled by CLI.'));
  } else if (!deterministicPassed) {
    ai = { requested: false, status: 'skipped', reason: 'AI review skipped because deterministic station failed.' };
    stations.push(skippedStation('advisory-ai-review', 'Deterministic station failed.'));
  } else {
    const aiStationStartMs = Date.now();
    const aiStationStartedAt = new Date(aiStationStartMs).toISOString();
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
    stations.push(station('advisory-ai-review', ai.status === 'available' ? 'passed' : 'unavailable', aiStationStartedAt, aiStationStartMs, ai.reason ? { message: ai.reason } : undefined));
  }

  const runFinishedAt = new Date().toISOString();
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

function parseCliOptions(argv: readonly string[]): WorkbookUxTestRunOptions {
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
  console.log(`Usage: tsx test/workbook-ux/run.mts [--ai|--no-ai] [--headed] [--run-root=PATH] [--ai-command=pi] [--ai-model=MODEL] [--ai-timeout-ms=MS]\n\nRuns the workbook UX test: checked-out engine input -> provider-free fixture walkthrough/WebM -> deterministic decoded-WebM analysis -> optional advisory pi review -> durable report.\n\nExit is nonzero only when the recording/deterministic station fails. AI unavailability or findings never gate exit.`);
}

if (basename(process.argv[1] ?? '') === 'run.mts') {
  runWorkbookUxTest(parseCliOptions(process.argv.slice(2))).then((result) => {
    console.log(`Workbook UX test report: ${result.reportPath}`);
    console.log(`Workbook UX test result: ${result.resultPath}`);
    if (result.ai?.status === 'unavailable') console.log(`AI review unavailable: ${result.ai.reason}`);
    process.exitCode = result.exitCode;
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
