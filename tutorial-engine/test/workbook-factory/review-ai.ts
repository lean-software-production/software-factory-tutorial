import { execFile } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import type { AnalyzerReport } from './analyzer.js';
import type { WorkbookFactoryWalkthrough } from './record.mjs';

export type AiReviewStatus = 'available' | 'unavailable';

export interface AiReviewResult {
  requested: true;
  status: AiReviewStatus;
  reason?: string;
  command: string;
  args: string[];
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  timedOut?: boolean;
  exitCode?: number | string | null;
  signal?: string | null;
  stdoutPath: string;
  stderrPath: string;
  jsonPath: string;
  reviewPath: string;
  attachmentPaths: string[];
  outputBytes: number;
}

export interface AiReviewOptions {
  runRoot: string;
  command?: string;
  timeoutMs?: number;
  model?: string;
  maxFrameAttachments?: number;
  execFileRunner?: ExecFileRunner;
}

export interface ExecFileRunOptions {
  cwd: string;
  timeoutMs: number;
  maxBuffer: number;
}

export interface ExecFileRunResult {
  stdout: string;
  stderr: string;
  exitCode?: number | string | null;
  signal?: string | null;
  timedOut?: boolean;
}

export type ExecFileRunner = (command: string, args: string[], options: ExecFileRunOptions) => Promise<ExecFileRunResult>;

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_BUFFER = 4 * 1024 * 1024;
const MAX_FRAME_ATTACHMENTS = 8;
const PROMPT_TEMPLATE_PATH = new URL('./review-ai-prompt.md', import.meta.url);

export async function runAiReview(options: AiReviewOptions): Promise<AiReviewResult> {
  const runRoot = resolve(options.runRoot);
  const command = options.command ?? 'pi';
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const reviewPath = resolve(runRoot, 'ai-review.md');
  const stderrPath = resolve(runRoot, 'ai-review.stderr.txt');
  const jsonPath = resolve(runRoot, 'ai-review.json');
  const unavailable = async (reason: string, partial: Partial<AiReviewResult> = {}): Promise<AiReviewResult> => {
    const finishedAtMs = Date.now();
    const result: AiReviewResult = {
      requested: true,
      status: 'unavailable',
      reason,
      command,
      args: partial.args ?? [],
      startedAt,
      finishedAt: new Date(finishedAtMs).toISOString(),
      durationMs: finishedAtMs - startedAtMs,
      stdoutPath: reviewPath,
      stderrPath,
      jsonPath,
      reviewPath,
      attachmentPaths: partial.attachmentPaths ?? [],
      outputBytes: partial.outputBytes ?? 0,
      timedOut: partial.timedOut,
      exitCode: partial.exitCode,
      signal: partial.signal,
    };
    await writeFile(reviewPath, partial.outputBytes ? await readFile(reviewPath, 'utf8').catch(() => '') : '');
    await writeFile(stderrPath, `${reason}\n${partial.signal ? `signal: ${partial.signal}\n` : ''}`);
    await writeFile(jsonPath, `${JSON.stringify(result, null, 2)}\n`);
    return result;
  };

  const prerequisites = await collectAiAttachments(runRoot, options.maxFrameAttachments ?? MAX_FRAME_ATTACHMENTS);
  if (!prerequisites.ok) {
    return unavailable(prerequisites.reason);
  }

  const prompt = await buildAiPrompt(runRoot, prerequisites.attachments);
  const args = buildPiArgs({ model: options.model, attachments: prerequisites.attachments, prompt });
  const runner = options.execFileRunner ?? defaultExecFileRunner;

  let runResult: ExecFileRunResult;
  try {
    runResult = await runner(command, args, { cwd: runRoot, timeoutMs, maxBuffer: DEFAULT_MAX_BUFFER });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return unavailable(`pi invocation failed: ${message}`, { args, attachmentPaths: prerequisites.attachments });
  }

  await writeFile(reviewPath, runResult.stdout);
  await writeFile(stderrPath, runResult.stderr);

  const finishedAtMs = Date.now();
  const outputBytes = Buffer.byteLength(runResult.stdout, 'utf8');
  const reason = aiUnavailableReason(runResult, outputBytes, runResult.stdout);
  const result: AiReviewResult = {
    requested: true,
    status: reason ? 'unavailable' : 'available',
    reason,
    command,
    args,
    startedAt,
    finishedAt: new Date(finishedAtMs).toISOString(),
    durationMs: finishedAtMs - startedAtMs,
    timedOut: runResult.timedOut,
    exitCode: runResult.exitCode,
    signal: runResult.signal,
    stdoutPath: reviewPath,
    stderrPath,
    jsonPath,
    reviewPath,
    attachmentPaths: prerequisites.attachments,
    outputBytes,
  };
  await writeFile(jsonPath, `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

export function buildPiArgs(options: { model?: string; attachments: string[]; prompt: string }): string[] {
  const args = ['-p', '-nt', '--no-session', '--thinking', 'low'];
  if (options.model) args.push('--model', options.model);
  args.push(...options.attachments.map((attachment) => `@${attachment}`));
  args.push(options.prompt);
  return args;
}

async function collectAiAttachments(runRoot: string, maxFrames: number): Promise<{ ok: true; attachments: string[] } | { ok: false; reason: string }> {
  const required = ['walkthrough.json', 'analysis/motion.json', 'analysis/contact-sheet.png'];
  for (const relativePath of required) {
    if (!(await isReadable(resolve(runRoot, relativePath)))) {
      return { ok: false, reason: `AI review prerequisite missing: ${relativePath}` };
    }
  }

  let motion: AnalyzerReport | undefined;
  try {
    motion = JSON.parse(await readFile(resolve(runRoot, 'analysis/motion.json'), 'utf8')) as AnalyzerReport;
  } catch {
    motion = undefined;
  }

  await writeProviderSafeWalkthroughSummary(runRoot);

  const evidenceFrames = motion?.evidence.frames ?? [];
  const discoveredFrames = await readdir(resolve(runRoot, 'analysis')).catch(() => []);
  const pngFrames = unique([
    ...evidenceFrames.filter((file) => file.endsWith('.png')),
    ...discoveredFrames.filter((file) => file.endsWith('.png') && file !== 'contact-sheet.png').sort(),
  ]).slice(0, Math.max(0, maxFrames));

  return {
    ok: true,
    attachments: [
      'analysis/contact-sheet.png',
      'ai-walkthrough-summary.json',
      'analysis/motion.json',
      ...pngFrames.map((file) => `analysis/${file}`),
    ],
  };
}

async function writeProviderSafeWalkthroughSummary(runRoot: string): Promise<void> {
  const walkthrough = await readJson<WorkbookFactoryWalkthrough>(resolve(runRoot, 'walkthrough.json'));
  const summary = {
    generatedAt: walkthrough?.generatedAt,
    viewport: walkthrough?.viewport,
    markerProtocol: walkthrough?.markerProtocol,
    semanticFailures: walkthrough?.semanticFailures ?? [],
    checkpoints: (walkthrough?.checkpoints ?? []).map((checkpoint) => ({
      stepId: checkpoint.stepId,
      name: checkpoint.name,
      surface: checkpoint.surface,
      requestedState: checkpoint.requestedState,
      kind: checkpoint.kind,
      requiredMotion: checkpoint.requiredMotion,
      marker: checkpoint.marker,
      before: checkpoint.before,
      after: checkpoint.after,
      typedText: checkpoint.typedText,
      command: checkpoint.command,
      feedback: checkpoint.feedback,
      fakeCallCounts: checkpoint.fakeCallCounts,
    })),
    fake: walkthrough?.fake,
  };
  await writeFile(resolve(runRoot, 'ai-walkthrough-summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
}

async function buildAiPrompt(runRoot: string, attachments: string[]): Promise<string> {
  const template = await readFile(PROMPT_TEMPLATE_PATH, 'utf8');
  const context = await deterministicContext(runRoot);
  const attachmentList = attachments.map((attachment) => `- @${attachment}`).join('\n');
  return template
    .replace('{{DETERMINISTIC_CONTEXT}}', context)
    .replace('{{ATTACHMENT_LIST}}', attachmentList);
}

async function deterministicContext(runRoot: string): Promise<string> {
  const lines: string[] = [];
  const walkthrough = await readJson<WorkbookFactoryWalkthrough>(resolve(runRoot, 'walkthrough.json'));
  const motion = await readJson<AnalyzerReport>(resolve(runRoot, 'analysis/motion.json'));
  if (walkthrough) {
    lines.push(`- Semantic failures: ${walkthrough.semanticFailures.length === 0 ? 'none' : walkthrough.semanticFailures.join('; ')}`);
    lines.push('- Checkpoints:');
    for (const checkpoint of walkthrough.checkpoints) {
      const state = checkpoint.requestedState ? `/${checkpoint.requestedState}` : '';
      lines.push(`  - step ${checkpoint.stepId} ${checkpoint.name} (${checkpoint.surface}${state}, ${checkpoint.kind}) settled ${checkpoint.settledAt}`);
    }
  }
  if (motion) {
    lines.push(`- Deterministic analyzer ok: ${motion.ok}`);
    lines.push(`- Video: ${motion.video.width}x${motion.video.height}, ${motion.video.duration.toFixed(2)}s, ${motion.video.frameCount} sampled frames`);
    lines.push(`- Deterministic findings: ${motion.findings.length === 0 ? 'none' : motion.findings.map((finding) => `${finding.code}${finding.stepId === undefined ? '' : ` step ${finding.stepId}`}: ${finding.message}`).join('; ')}`);
    lines.push(`- Decoded motion segments: ${motion.segments.map((segment) => `step ${segment.stepId} ${segment.startTime.toFixed(2)}-${segment.endTime.toFixed(2)}s shift ${segment.totalAbsShiftPx.toFixed(1)}px`).join('; ') || 'none'}`);
  }
  return lines.join('\n') || '- Deterministic context could not be read.';
}

function aiUnavailableReason(result: ExecFileRunResult, outputBytes: number, stdout: string): string | undefined {
  if (result.timedOut) return 'pi timed out';
  if (result.exitCode === 'ENOENT') return 'pi command not found';
  if (result.exitCode !== undefined && result.exitCode !== null && result.exitCode !== 0) return `pi exited nonzero (${result.exitCode})`;
  if (result.signal) return `pi terminated by signal ${result.signal}`;
  if (outputBytes === 0 || stdout.trim().length === 0) return 'pi produced empty output';
  return undefined;
}

function defaultExecFileRunner(command: string, args: string[], options: ExecFileRunOptions): Promise<ExecFileRunResult> {
  return new Promise((resolvePromise) => {
    const child = execFile(command, args, {
      cwd: options.cwd,
      maxBuffer: options.maxBuffer,
      timeout: options.timeoutMs,
      killSignal: 'SIGTERM',
      shell: false,
    }, (error, stdout, stderr) => {
      const maybeError = error as NodeJS.ErrnoException & { code?: string | number; signal?: string; killed?: boolean } | null;
      resolvePromise({
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
        exitCode: maybeError?.code ?? 0,
        signal: maybeError?.signal ?? null,
        timedOut: Boolean(maybeError?.killed && maybeError?.signal === 'SIGTERM'),
      });
    });
    child.on('error', (error) => {
      resolvePromise({ stdout: '', stderr: error.message, exitCode: (error as NodeJS.ErrnoException).code ?? 'error' });
    });
  });
}

async function isReadable(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => basename(value))));
}
