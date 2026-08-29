#!/usr/bin/env npx tsx
import { fileURLToPath } from 'node:url';
import { basename, dirname, resolve } from 'node:path';
import { recordWorkbookFactory, type WorkbookFactoryRecorderOptions, type WorkbookFactoryRecorderResult } from './record.mjs';
import { writeFactoryReport, type FactoryStationResult, type SerializedError } from './report.js';
import { runAiReview, type AiReviewResult } from './review-ai.js';

export interface WorkbookFactoryRunOptions extends WorkbookFactoryRecorderOptions {
  ai?: boolean;
  aiCommand?: string;
  aiModel?: string;
  aiTimeoutMs?: number;
}

export interface WorkbookFactoryRunDeps {
  record?: (options: WorkbookFactoryRecorderOptions) => Promise<WorkbookFactoryRecorderResult>;
  ai?: (options: { runRoot: string; command?: string; model?: string; timeoutMs?: number }) => Promise<AiReviewResult>;
  report?: typeof writeFactoryReport;
}

export interface WorkbookFactoryRunResult {
  runRoot: string;
  exitCode: number;
  deterministicPassed: boolean;
  stations: FactoryStationResult[];
  reportPath: string;
  resultPath: string;
  ai?: AiReviewResult | { requested: false; status: 'skipped'; reason: string };
}

const ENGINE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DEFAULT_RUN_ROOT = resolve(ENGINE_ROOT, 'test/.tmp/workbook-factory/latest');

export async function runWorkbookFactory(options: WorkbookFactoryRunOptions = {}, deps: WorkbookFactoryRunDeps = {}): Promise<WorkbookFactoryRunResult> {
  const runStartedAtMs = Date.now();
  const runStartedAt = new Date(runStartedAtMs).toISOString();
  const runRoot = resolve(options.runRoot ?? DEFAULT_RUN_ROOT);
  const stations: FactoryStationResult[] = [];
  const recordStationStartMs = Date.now();
  const recordStationStartedAt = new Date(recordStationStartMs).toISOString();
  const record = deps.record ?? recordWorkbookFactory;
  let deterministicPassed = false;
  let deterministicError: SerializedError | undefined;

  try {
    await record({ runRoot, analyze: true, headless: options.headless });
    deterministicPassed = true;
    stations.push(station('record-and-deterministic-analysis', 'passed', recordStationStartedAt, recordStationStartMs));
  } catch (error) {
    deterministicError = serializeError(error);
    stations.push(station('record-and-deterministic-analysis', 'failed', recordStationStartedAt, recordStationStartMs, deterministicError));
  }

  let ai: WorkbookFactoryRunResult['ai'];
  if (!options.ai) {
    ai = { requested: false, status: 'skipped', reason: 'AI review disabled by CLI.' };
    stations.push(skippedStation('advisory-ai-review', 'AI review disabled by CLI.'));
  } else if (!deterministicPassed) {
    ai = { requested: false, status: 'skipped', reason: 'AI review skipped because deterministic station failed.' };
    stations.push(skippedStation('advisory-ai-review', 'Deterministic station failed.'));
  } else {
    const aiStationStartMs = Date.now();
    const aiStationStartedAt = new Date(aiStationStartMs).toISOString();
    ai = await (deps.ai ?? ((aiOptions) => runAiReview(aiOptions)))({
      runRoot,
      command: options.aiCommand,
      model: options.aiModel,
      timeoutMs: options.aiTimeoutMs,
    });
    stations.push(station('advisory-ai-review', ai.status === 'available' ? 'passed' : 'unavailable', aiStationStartedAt, aiStationStartMs, ai.reason ? { message: ai.reason } : undefined));
  }

  const runFinishedAt = new Date().toISOString();
  const reportResult = await (deps.report ?? writeFactoryReport)({
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

function parseCliOptions(argv: readonly string[]): WorkbookFactoryRunOptions {
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
      throw new Error(`Unknown workbook factory option: ${arg}`);
    }
  }

  if (aiTimeoutMs !== undefined && (!Number.isFinite(aiTimeoutMs) || aiTimeoutMs <= 0)) {
    throw new Error(`--ai-timeout-ms must be a positive finite number; got ${aiTimeoutMs}`);
  }

  return { ai, headless, runRoot, aiCommand, aiModel, aiTimeoutMs, analyze: true };
}

function station(name: string, status: FactoryStationResult['status'], startedAt: string, startedAtMs: number, error?: SerializedError): FactoryStationResult {
  const finishedAtMs = Date.now();
  return { name, status, startedAt, finishedAt: new Date(finishedAtMs).toISOString(), durationMs: finishedAtMs - startedAtMs, error };
}

function skippedStation(name: string, reason: string): FactoryStationResult {
  const now = new Date().toISOString();
  return { name, status: 'skipped', startedAt: now, finishedAt: now, durationMs: 0, error: { message: reason } };
}

function serializeError(error: unknown): SerializedError {
  return error instanceof Error ? { message: error.message, stack: error.stack } : { message: String(error) };
}

function printHelp(): void {
  console.log(`Usage: tsx test/workbook-factory/run.mts [--ai|--no-ai] [--headed] [--run-root=PATH] [--ai-command=pi] [--ai-model=MODEL] [--ai-timeout-ms=MS]\n\nRuns the linear workbook factory: checked-out engine input -> provider-free fixture walkthrough/WebM -> deterministic decoded-WebM analysis -> optional advisory pi review -> durable report.\n\nExit is nonzero only when the recording/deterministic station fails. AI unavailability or findings never gate exit.`);
}

if (basename(process.argv[1] ?? '') === 'run.mts') {
  runWorkbookFactory(parseCliOptions(process.argv.slice(2))).then((result) => {
    console.log(`Workbook factory report: ${result.reportPath}`);
    console.log(`Workbook factory result: ${result.resultPath}`);
    if (result.ai?.status === 'unavailable') console.log(`AI review unavailable: ${result.ai.reason}`);
    process.exitCode = result.exitCode;
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
