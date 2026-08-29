#!/usr/bin/env tsx
import { analyzeWorkbookVideo, validateSampleHz } from './analyzer.js';

interface CliArgs {
  video?: string;
  out?: string;
  requiredMotionStepIds: number[];
  sampleHz?: number;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { requiredMotionStepIds: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '--video' && next) {
      args.video = next;
      index += 1;
    } else if (arg === '--out' && next) {
      args.out = next;
      index += 1;
    } else if ((arg === '--required-motion-step' || arg === '--required-motion-steps') && next) {
      args.requiredMotionStepIds.push(...next.split(',').filter(Boolean).map((value) => Number(value)));
      index += 1;
    } else if (arg === '--sample-hz' && next) {
      args.sampleHz = validateSampleHz(Number(next));
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg ?? '(none)'}`);
    }
  }
  if (!args.video || !args.out) {
    printHelp();
    throw new Error('--video and --out are required');
  }
  if (args.requiredMotionStepIds.length === 0) {
    throw new Error('At least one --required-motion-step is required');
  }
  for (const stepId of args.requiredMotionStepIds) {
    if (!Number.isInteger(stepId) || stepId < 0) {
      throw new Error(`Invalid required step id: ${stepId}`);
    }
  }
  return args;
}

function printHelp(): void {
  console.log(`Usage:
  tsx test/workbook-factory/analyze-video.mts --video recording.webm --out .tmp/analyser --required-motion-step 1,2,3

Decodes a finalized Playwright WebM in pinned Chromium, samples real pixels, segments marker-labelled transitions, and writes motion.json plus PNG evidence.`);
}

const args = parseArgs(process.argv.slice(2));
const report = await analyzeWorkbookVideo({
  videoPath: args.video!,
  outputDir: args.out!,
  requiredMotionStepIds: args.requiredMotionStepIds,
  sampleHz: args.sampleHz,
});

console.log(JSON.stringify({ ok: report.ok, findings: report.findings.map((finding) => ({ code: finding.code, stepId: finding.stepId })) }, null, 2));
process.exitCode = report.ok ? 0 : 1;
