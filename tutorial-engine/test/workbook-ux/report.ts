import { readFile, stat, writeFile } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import type { AnalyzerReport, Finding } from './analyzer.js';
import type { WorkbookUxTestWalkthrough, SemanticCheckpoint } from './record.mjs';
import type { AiReviewResult } from './review-ai.js';

export type StationStatus = 'passed' | 'failed' | 'skipped' | 'unavailable';

export interface UxTestStationResult {
  name: string;
  status: StationStatus;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  error?: SerializedError;
}

export interface SerializedError {
  message: string;
  stack?: string;
}

export interface UxTestReportOptions {
  runRoot: string;
  startedAt: string;
  finishedAt: string;
  stations: UxTestStationResult[];
  deterministicPassed: boolean;
  deterministicError?: SerializedError;
  aiRequested: boolean;
  ai?: AiReviewResult | { requested: false; status: 'skipped'; reason: string };
}

export interface UxTestResultJson {
  schemaVersion: 1;
  generatedAt: string;
  runRoot: string;
  exitCode: number;
  deterministicVerdict: 'passed' | 'failed';
  aiRequested: boolean;
  aiStatus: string;
  inputIdentity?: unknown;
  artifacts: Record<string, string | undefined>;
  stations: UxTestStationResult[];
  deterministic: {
    ok: boolean;
    error?: SerializedError;
    semanticFailures: string[];
    findings: Finding[];
  };
  ai?: UxTestReportOptions['ai'];
}

export async function deterministicContractFailures(runRootInput: string): Promise<string[]> {
  const runRoot = resolve(runRootInput);
  const inputMetadataJson = await readJsonDetailed<unknown>(resolve(runRoot, 'input-metadata.json'));
  const walkthroughJson = await readJsonDetailed<WorkbookUxTestWalkthrough>(resolve(runRoot, 'walkthrough.json'));
  const motionJson = await readJsonDetailed<AnalyzerReport>(resolve(runRoot, 'analysis/motion.json'));
  const walkthrough = walkthroughJson.value;
  const motion = motionJson.value;
  const videoPath = walkthrough?.videoPath ?? motion?.videoPath ?? resolve(runRoot, 'walkthrough.webm');
  const videoStats = await stat(videoPath).catch(() => undefined);
  const contactSheetStats = await stat(resolve(runRoot, 'analysis/contact-sheet.png')).catch(() => undefined);
  return [
    ...deterministicArtifactFailures({ inputMetadataJson, walkthroughJson, videoStats, motionJson, contactSheetStats }),
    ...(walkthrough?.semanticFailures ?? []),
    ...(motion?.findings.map((finding) => `${finding.code}${finding.stepId === undefined ? '' : ` step ${finding.stepId}`}: ${finding.message}`) ?? []),
  ];
}

export async function writeUxTestReport(options: UxTestReportOptions): Promise<{ reportPath: string; resultPath: string; result: UxTestResultJson }> {
  const runRoot = resolve(options.runRoot);
  const inputMetadataJson = await readJsonDetailed<unknown>(resolve(runRoot, 'input-metadata.json'));
  const walkthroughJson = await readJsonDetailed<WorkbookUxTestWalkthrough>(resolve(runRoot, 'walkthrough.json'));
  const motionJson = await readJsonDetailed<AnalyzerReport>(resolve(runRoot, 'analysis/motion.json'));
  const recordingErrorPath = resolve(runRoot, 'recording-error.json');
  const recordingError = await readJson<{ message?: string; stack?: string; failures?: string[]; walkthrough?: WorkbookUxTestWalkthrough }>(recordingErrorPath);
  const recordingErrorStats = await stat(recordingErrorPath).catch(() => undefined);
  const inputMetadata = inputMetadataJson.value;
  const walkthrough = walkthroughJson.value ?? recordingError?.walkthrough;
  const motion = motionJson.value;
  const videoPath = walkthrough?.videoPath ?? motion?.videoPath ?? resolve(runRoot, 'walkthrough.webm');
  const videoStats = await stat(videoPath).catch(() => undefined);
  const contactSheetPath = resolve(runRoot, 'analysis/contact-sheet.png');
  const contactSheetStats = await stat(contactSheetPath).catch(() => undefined);
  const aiReviewPath = resolve(runRoot, 'ai-review.md');
  const aiReviewText = await readFile(aiReviewPath, 'utf8').catch(() => '');
  const aiReviewStats = await stat(aiReviewPath).catch(() => undefined);
  const artifactFailures = deterministicArtifactFailures({ inputMetadataJson, walkthroughJson, videoStats, motionJson, contactSheetStats });
  const semanticFailures = [
    ...(walkthrough?.semanticFailures ?? recordingError?.failures ?? (recordingError?.message ? [recordingError.message] : [])),
    ...artifactFailures,
  ];
  const findings = motion?.findings ?? [];
  const deterministicOk = options.deterministicPassed
    && artifactFailures.length === 0
    && semanticFailures.length === 0
    && motion?.ok === true
    && findings.length === 0;
  const result: UxTestResultJson = {
    schemaVersion: 1,
    generatedAt: options.finishedAt,
    runRoot,
    exitCode: deterministicOk ? 0 : 1,
    deterministicVerdict: deterministicOk ? 'passed' : 'failed',
    aiRequested: options.aiRequested,
    aiStatus: options.ai?.status ?? 'skipped',
    inputIdentity: inputMetadata,
    artifacts: {
      inputMetadata: inputMetadataJson.exists ? link(runRoot, resolve(runRoot, 'input-metadata.json')) : undefined,
      walkthrough: walkthroughJson.exists ? link(runRoot, resolve(runRoot, 'walkthrough.json')) : undefined,
      video: videoStats ? link(runRoot, videoPath) : undefined,
      motion: motionJson.exists ? link(runRoot, resolve(runRoot, 'analysis/motion.json')) : undefined,
      contactSheet: contactSheetStats ? link(runRoot, contactSheetPath) : undefined,
      recordingError: recordingErrorStats ? link(runRoot, recordingErrorPath) : undefined,
      recordingScreenshot: await exists(resolve(runRoot, 'recording-error.png')) ? link(runRoot, resolve(runRoot, 'recording-error.png')) : undefined,
      aiReview: aiReviewStats ? link(runRoot, aiReviewPath) : undefined,
    },
    stations: options.stations,
    deterministic: {
      ok: deterministicOk,
      error: options.deterministicError ?? (recordingError?.message ? { message: recordingError.message, stack: recordingError.stack } : undefined),
      semanticFailures,
      findings,
    },
    ai: options.ai,
  };

  const report = renderMarkdownReport({
    runRoot,
    startedAt: options.startedAt,
    finishedAt: options.finishedAt,
    inputMetadata,
    walkthrough,
    motion,
    videoPath,
    videoStats,
    recordingError,
    result,
    aiReviewText,
  });
  const reportPath = resolve(runRoot, 'report.md');
  const resultPath = resolve(runRoot, 'ux-test-result.json');
  await writeFile(reportPath, report);
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
  return { reportPath, resultPath, result };
}

function renderMarkdownReport(args: {
  runRoot: string;
  startedAt: string;
  finishedAt: string;
  inputMetadata?: unknown;
  walkthrough?: WorkbookUxTestWalkthrough;
  motion?: AnalyzerReport;
  videoPath: string;
  videoStats?: { size: number };
  recordingError?: { message?: string; stack?: string; failures?: string[] };
  result: UxTestResultJson;
  aiReviewText: string;
}): string {
  const lines: string[] = [];
  lines.push('# Workbook UX test report', '');
  lines.push(`Generated: ${args.finishedAt}`);
  lines.push(`Run root: ${args.runRoot}`);
  lines.push(`Deterministic verdict: **${args.result.deterministicVerdict.toUpperCase()}**`);
  lines.push('');
  lines.push('The deterministic recorder/analyzer verdict is authoritative and gates the command exit code. AI content is advisory only and every AI finding should be treated as `@needs-human` review material.');
  lines.push('');

  lines.push('## Input identity', '');
  lines.push(...inputIdentityLines(args.inputMetadata));
  lines.push('');

  lines.push('## Station status and timing', '');
  lines.push(table(['Station', 'Status', 'Duration', 'Started', 'Finished', 'Error'], args.result.stations.map((station) => [
    station.name,
    station.status,
    `${station.durationMs} ms`,
    station.startedAt,
    station.finishedAt,
    station.error?.message ?? '',
  ])));
  lines.push('');

  lines.push('## Artifact contract', '');
  const artifacts = Object.entries(args.result.artifacts).map(([name, artifact]) => [name, artifact ? markdownLink(args.runRoot, artifact) : 'missing/not produced']);
  lines.push(table(['Artifact', 'Path'], artifacts));
  lines.push('');

  lines.push('## Video', '');
  lines.push(table(['Path', 'Duration', 'Size', 'Dimensions', 'Samples'], [[
    args.videoStats ? markdownLink(args.runRoot, args.videoPath) : 'missing/not finalized',
    args.motion ? `${args.motion.video.duration.toFixed(2)} s` : 'unknown',
    args.videoStats ? formatBytes(args.videoStats.size) : 'unknown',
    args.motion ? `${args.motion.video.width}×${args.motion.video.height}` : 'unknown',
    args.motion ? String(args.motion.video.frameCount) : 'unknown',
  ]]));
  lines.push('');

  lines.push('## Deterministic findings', '');
  const findingRows: string[][] = [];
  for (const failure of args.result.deterministic.semanticFailures) findingRows.push(['semantic-failure', '', '', '', failure]);
  for (const finding of args.result.deterministic.findings) findingRows.push([
    finding.code,
    finding.stepId === undefined ? '' : String(finding.stepId),
    timeRange(finding.startTime, finding.endTime),
    evidenceForFinding(args.runRoot, args.motion, finding),
    finding.message,
  ]);
  lines.push(findingRows.length ? table(['Code', 'Step', 'Timestamp(s)', 'Evidence', 'Message'], findingRows) : 'No deterministic findings.');
  lines.push('');

  lines.push('## Semantic checkpoint table', '');
  lines.push(args.walkthrough?.checkpoints.length ? checkpointTable(args.walkthrough.checkpoints) : 'No checkpoint telemetry was written.');
  lines.push('');

  lines.push('## Required scroll segment motion', '');
  lines.push(requiredMotionTable(args.motion));
  lines.push('');

  if (args.recordingError) {
    lines.push('## Recording/deterministic error', '');
    lines.push('```text');
    lines.push(args.recordingError.message ?? 'Unknown recording error');
    if (args.recordingError.failures?.length) lines.push(...args.recordingError.failures.map((failure) => `- ${failure}`));
    lines.push('```', '');
  }

  lines.push('## AI review (advisory)', '');
  lines.push(`Requested: ${args.result.aiRequested ? 'yes' : 'no'}`);
  lines.push(`Status: ${args.result.aiStatus}`);
  if (args.result.ai && 'reason' in args.result.ai && args.result.ai.reason) lines.push(`Reason: ${args.result.ai.reason}`);
  lines.push('');
  if (args.aiReviewText.trim()) {
    lines.push('### Raw advisory review', '');
    lines.push(args.aiReviewText.trim(), '');
  } else {
    lines.push('No advisory AI review text was produced.', '');
  }
  return `${lines.join('\n')}\n`;
}

function inputIdentityLines(inputMetadata: unknown): string[] {
  if (!inputMetadata || typeof inputMetadata !== 'object') return ['Input metadata was not written.'];
  const metadata = inputMetadata as { git?: { sha?: string; shortSha?: string; dirty?: boolean; status?: string[] }; package?: { name?: string; version?: string; playwright?: string }; browser?: { name?: string; version?: string }; viewport?: Record<string, unknown>; engine?: { webBundle?: unknown } };
  return [
    `- Git SHA: ${metadata.git?.sha ?? 'unknown'}${metadata.git?.shortSha ? ` (${metadata.git.shortSha})` : ''}`,
    `- Dirty: ${metadata.git?.dirty === undefined ? 'unknown' : String(metadata.git.dirty)}`,
    `- Dirty files: ${metadata.git?.status?.length ? metadata.git.status.join('; ') : 'none recorded'}`,
    `- Package: ${metadata.package?.name ?? 'unknown'} ${metadata.package?.version ?? ''}`.trim(),
    `- Playwright package pin: ${metadata.package?.playwright ?? 'unknown'}`,
    `- Browser: ${metadata.browser?.name ?? 'unknown'} ${metadata.browser?.version ?? ''}`.trim(),
    `- Viewport: ${metadata.viewport ? JSON.stringify(metadata.viewport) : 'unknown'}`,
    `- Web bundle: ${metadata.engine?.webBundle ? JSON.stringify(metadata.engine.webBundle) : 'unknown'}`,
  ];
}

function checkpointTable(checkpoints: readonly SemanticCheckpoint[]): string {
  return table(['Step', 'Name', 'Surface/state', 'Kind', 'Typed/command', 'Feedback geometry', 'Safe region', 'Occlusion'], checkpoints.map((checkpoint) => [
    String(checkpoint.stepId),
    checkpoint.name,
    `${checkpoint.surface}${checkpoint.requestedState ? `/${checkpoint.requestedState}` : ''}`,
    checkpoint.kind,
    truncate(checkpoint.typedText ?? checkpoint.command ?? '', 80),
    checkpoint.feedback ? rectSummary(checkpoint.feedback.rect) : '',
    checkpoint.feedback ? `${checkpoint.feedback.safeRegion.insideSafeRegion ? 'inside' : 'outside'} safeBottom=${checkpoint.feedback.safeRegion.safeBottom.toFixed(1)}` : '',
    checkpoint.feedback ? (checkpoint.feedback.safeRegion.unoccluded ? 'unoccluded' : 'occluded') : '',
  ]));
}

function requiredMotionTable(motion?: AnalyzerReport): string {
  if (!motion) return 'No deterministic motion report was written.';
  const required = new Set(motion.requiredMotionStepIds);
  const segments = motion.segments.filter((segment) => required.has(segment.stepId));
  if (segments.length === 0) return 'No required scroll motion segments were decoded.';
  return table(['Step', 'Time range', 'Frames', 'Total shift', 'Net shift', 'Max adjacent', 'Reversals', 'Confidence', 'Texture'], segments.map((segment) => [
    String(segment.stepId),
    timeRange(segment.startTime, segment.endTime),
    `${segment.frameIndexes[0] ?? ''}–${segment.frameIndexes.at(-1) ?? ''}`,
    `${segment.totalAbsShiftPx.toFixed(1)} px`,
    `${segment.netShiftPx.toFixed(1)} px`,
    `${segment.maxAdjacentShiftPx.toFixed(1)} px`,
    String(segment.signReversals),
    segment.confidence.toFixed(2),
    segment.texture.toFixed(2),
  ]));
}

function evidenceForFinding(runRoot: string, motion: AnalyzerReport | undefined, finding: Finding): string {
  const files = motion?.evidence.frames.filter((file) => file.includes(finding.code) && (finding.stepId === undefined || file.includes(`step-${finding.stepId}`))) ?? [];
  if (files.length === 0) return '';
  return files.map((file) => markdownLink(runRoot, `analysis/${file}`)).join(', ');
}

function table(headers: string[], rows: string[][]): string {
  const clean = (value: string) => value.replace(/\n/g, '<br>').replace(/\|/g, '\\|');
  return [
    `| ${headers.map(clean).join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map((value) => clean(value)).join(' | ')} |`),
  ].join('\n');
}

function link(runRoot: string, path: string): string {
  const absolute = resolve(path);
  return relative(runRoot, absolute).split(sep).join('/');
}

function markdownLink(runRoot: string, path: string): string {
  const relativePath = path.startsWith('.') || !path.startsWith('/') ? path : link(runRoot, path);
  return `[${relativePath}](${relativePath})`;
}

function rectSummary(rect: { left: number; top: number; right: number; bottom: number; width: number; height: number }): string {
  return `x=${rect.left.toFixed(1)} y=${rect.top.toFixed(1)} w=${rect.width.toFixed(1)} h=${rect.height.toFixed(1)} bottom=${rect.bottom.toFixed(1)}`;
}

function timeRange(start?: number, end?: number): string {
  if (start === undefined && end === undefined) return '';
  if (start !== undefined && end !== undefined) return `${start.toFixed(2)}–${end.toFixed(2)}s`;
  return `${(start ?? end ?? 0).toFixed(2)}s`;
}

function truncate(value: string, length: number): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length <= length ? compact : `${compact.slice(0, length - 1)}…`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

interface ParsedJson<T> {
  exists: boolean;
  value?: T;
  error?: string;
}

function deterministicArtifactFailures(args: {
  inputMetadataJson: ParsedJson<unknown>;
  walkthroughJson: ParsedJson<WorkbookUxTestWalkthrough>;
  videoStats?: { size: number };
  motionJson: ParsedJson<AnalyzerReport>;
  contactSheetStats?: { size: number };
}): string[] {
  const failures: string[] = [];
  if (!args.inputMetadataJson.exists) failures.push('Required deterministic artifact missing: input-metadata.json.');
  else if (args.inputMetadataJson.error) failures.push(`Required deterministic artifact is corrupt: input-metadata.json (${args.inputMetadataJson.error}).`);

  if (!args.walkthroughJson.exists) failures.push('Required deterministic artifact missing: walkthrough.json.');
  else if (args.walkthroughJson.error) failures.push(`Required deterministic artifact is corrupt: walkthrough.json (${args.walkthroughJson.error}).`);

  if (!args.videoStats) failures.push('Required deterministic artifact missing: finalized walkthrough video.');

  if (!args.motionJson.exists) failures.push('Required deterministic artifact missing: analysis/motion.json.');
  else if (args.motionJson.error) failures.push(`Required deterministic artifact is corrupt: analysis/motion.json (${args.motionJson.error}).`);
  else if (args.motionJson.value?.ok !== true) failures.push('Required deterministic artifact disagrees: analysis/motion.json ok is not true.');

  if (!args.contactSheetStats) failures.push('Required deterministic artifact missing: analysis/contact-sheet.png.');
  return failures;
}

async function readJson<T>(path: string): Promise<T | undefined> {
  return (await readJsonDetailed<T>(path)).value;
}

async function readJsonDetailed<T>(path: string): Promise<ParsedJson<T>> {
  try {
    const content = await readFile(path, 'utf8');
    try {
      return { exists: true, value: JSON.parse(content) as T };
    } catch (error) {
      return { exists: true, error: error instanceof Error ? error.message : String(error) };
    }
  } catch {
    return { exists: false };
  }
}
