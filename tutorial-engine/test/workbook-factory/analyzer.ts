import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import {
  MARKER_COLOURS,
  MARKER_GAP,
  MARKER_HEIGHT,
  MARKER_PADDING,
  MARKER_PROTOCOL_VERSION,
  MARKER_SAMPLE_INSET,
  MARKER_TOTAL_CELLS,
  MARKER_WIDTH,
  markerGeometry,
  type MarkerPhase,
} from './marker-protocol.js';

export type FindingCode =
  | 'oscillation'
  | 'jump'
  | 'no-motion'
  | 'video-unreadable'
  | 'empty-video'
  | 'marker-absent'
  | 'marker-ambiguous'
  | 'missing-required-step'
  | 'no-transition-frames'
  | 'segment-too-short'
  | 'insufficient-texture'
  | 'insufficient-motion-confidence';

export interface MotionRoi {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AnalyzerThresholds {
  markerMaxColourDistance: number;
  markerMinDistanceMargin: number;
  stillnessMeanDifference: number;
  minRequiredMotionPx: number;
  jumpPx: number;
  jumpViewportRatio: number;
  jumpIsolationRatio: number;
  oscillationMinShiftPx: number;
  oscillationMinTotalPx: number;
  minTextureScore: number;
  minMotionConfidence: number;
  maxShiftPx: number;
}

export interface AnalyzerOptions {
  videoPath: string;
  outputDir: string;
  requiredMotionStepIds: number[];
  sampleHz?: number;
  maxMotionWidth?: number;
  roi?: Partial<MotionRoi>;
  thresholds?: Partial<AnalyzerThresholds>;
  keepBrowserOpen?: boolean;
}

export interface MarkerDecode {
  ok: true;
  phase: MarkerPhase;
  stepId: number;
  distances: {
    guard: number;
    phase: number;
    worstBit: number;
  };
}

export interface MarkerDecodeFailure {
  ok: false;
  reason: 'absent' | 'ambiguous';
  detail: string;
}

export interface FrameSample {
  index: number;
  time: number;
  marker: MarkerDecode | MarkerDecodeFailure;
  gray: Uint8Array;
  grayWidth: number;
  grayHeight: number;
  roi: MotionRoi;
}

export interface AdjacentMotion {
  fromIndex: number;
  toIndex: number;
  fromTime: number;
  toTime: number;
  shiftPx: number;
  confidence: number;
  noise: number;
  texture: number;
  unshiftedDifference: number;
}

export interface MotionSegment {
  stepId: number;
  startTime: number;
  endTime: number;
  frameIndexes: number[];
  motions: AdjacentMotion[];
  totalAbsShiftPx: number;
  netShiftPx: number;
  maxAdjacentShiftPx: number;
  signReversals: number;
  confidence: number;
  lowConfidenceMotionCount: number;
  texture: number;
}

export interface Finding {
  code: FindingCode;
  stepId?: number;
  severity: 'error';
  message: string;
  frameIndexes?: number[];
  startTime?: number;
  endTime?: number;
  details?: Record<string, unknown>;
}

export interface AnalyzerReport {
  ok: boolean;
  videoPath: string;
  outputDir: string;
  generatedAt: string;
  markerProtocolVersion: number;
  video: {
    width: number;
    height: number;
    duration: number;
    sampleHz: number;
    frameCount: number;
  };
  requiredMotionStepIds: number[];
  thresholds: AnalyzerThresholds;
  roi: MotionRoi;
  calibration: {
    motionScale: number;
    effectiveThresholds: Record<string, number>;
    marker: {
      maxColourDistance: number;
      minDistanceMargin: number;
    };
  };
  markerSamples: {
    valid: number;
    invalid: number;
    ignoredLeadingInvalid: number;
    ignoredTrailingInvalid: number;
    firstValidIndex?: number;
    lastValidIndex?: number;
  };
  segments: MotionSegment[];
  findings: Finding[];
  evidence: {
    frames: string[];
    contactSheet?: string;
  };
}

interface BrowserFrameSample {
  time: number;
  width: number;
  height: number;
  roi: MotionRoi;
  grayWidth: number;
  grayHeight: number;
  gray: number[];
  markerCells: RgbTuple[];
}

type RgbTuple = [number, number, number];

export const MIN_SAMPLE_HZ = 1;
export const MAX_SAMPLE_HZ = 60;

export function validateSampleHz(sampleHz: number): number {
  if (!Number.isFinite(sampleHz) || sampleHz < MIN_SAMPLE_HZ || sampleHz > MAX_SAMPLE_HZ) {
    throw new Error(`sampleHz must be a finite number from ${MIN_SAMPLE_HZ} to ${MAX_SAMPLE_HZ}; got ${sampleHz}`);
  }
  return sampleHz;
}

export const DEFAULT_THRESHOLDS: AnalyzerThresholds = {
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
};

export async function analyzeWorkbookVideo(options: AnalyzerOptions): Promise<AnalyzerReport> {
  const thresholds = { ...DEFAULT_THRESHOLDS, ...options.thresholds };
  const sampleHz = validateSampleHz(options.sampleHz ?? 11);
  const maxMotionWidth = options.maxMotionWidth ?? 360;
  await mkdir(options.outputDir, { recursive: true });

  const server = await startVideoServer(options.videoPath);
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
    await page.goto(server.playerUrl, { waitUntil: 'domcontentloaded' });
    await installDecoderScript(page);
    const metadata = await getVideoMetadata(page);
    if (!Number.isFinite(metadata.duration) || metadata.duration <= 0 || metadata.width <= 0 || metadata.height <= 0) {
      const report = emptyReport(options, thresholds, sampleHz, metadata, defaultRoi(metadata.width, metadata.height, options.roi), [
        {
          code: 'empty-video',
          severity: 'error',
          message: 'The video has no decodable duration or dimensions.',
        },
      ]);
      await writeReport(report);
      return report;
    }

    const roi = defaultRoi(metadata.width, metadata.height, options.roi);
    const rawSamples = await decodeSamples(page, metadata.duration, sampleHz, roi, maxMotionWidth);
    const samples = rawSamples.map((sample, index): FrameSample => ({
      index,
      time: sample.time,
      marker: decodeMarker(sample.markerCells, thresholds),
      gray: Uint8Array.from(sample.gray),
      grayWidth: sample.grayWidth,
      grayHeight: sample.grayHeight,
      roi: sample.roi,
    }));

    const findings: Finding[] = [];
    const markerEnvelope = markerEnvelopeFor(samples);
    const markerStats = markerEnvelope.stats;
    const analysisSamples = markerEnvelope.envelopeSamples;
    findings.push(...markerEnvelopeFindings(samples, analysisSamples, markerStats));

    const segments = buildSegments(analysisSamples, thresholds);
    if (segments.length === 0) {
      findings.push({
        code: 'no-transition-frames',
        severity: 'error',
        message: 'No marker-labelled transition frames were decoded.',
        frameIndexes: analysisSamples.filter((sample) => sample.marker.ok).map((sample) => sample.index),
      });
    }

    const requiredStepIds = new Set(options.requiredMotionStepIds);
    findings.push(...missingRequiredMotionStepFindings(options.requiredMotionStepIds, segments));

    for (const segment of segments) {
      findings.push(...evaluateSegmentFindings(segment, roi, thresholds, requiredStepIds));
    }

    const evidence = await writeEvidence(page, options.outputDir, samples, segments, findings);
    const report: AnalyzerReport = {
      ok: findings.length === 0,
      videoPath: options.videoPath,
      outputDir: options.outputDir,
      generatedAt: new Date().toISOString(),
      markerProtocolVersion: MARKER_PROTOCOL_VERSION,
      video: {
        width: metadata.width,
        height: metadata.height,
        duration: metadata.duration,
        sampleHz,
        frameCount: samples.length,
      },
      requiredMotionStepIds: options.requiredMotionStepIds,
      thresholds,
      roi,
      calibration: {
        motionScale: samples[0] ? samples[0].roi.height / samples[0].grayHeight : 1,
        effectiveThresholds: {
          minRequiredMotionPx: thresholds.minRequiredMotionPx,
          jumpPx: thresholds.jumpPx,
          oscillationMinShiftPx: thresholds.oscillationMinShiftPx,
          oscillationMinTotalPx: thresholds.oscillationMinTotalPx,
          stillnessMeanDifference: thresholds.stillnessMeanDifference,
          minTextureScore: thresholds.minTextureScore,
          minMotionConfidence: thresholds.minMotionConfidence,
          effectiveJumpPx: effectiveJumpThreshold(roi, thresholds),
        },
        marker: {
          maxColourDistance: thresholds.markerMaxColourDistance,
          minDistanceMargin: thresholds.markerMinDistanceMargin,
        },
      },
      markerSamples: markerStats,
      segments,
      findings,
      evidence,
    };

    await writeReport(report);
    return report;
  } catch (error) {
    const fallbackMetadata = { width: 0, height: 0, duration: 0 };
    const report = emptyReport(options, thresholds, sampleHz, fallbackMetadata, defaultRoi(800, 600, options.roi), [
      {
        code: 'video-unreadable',
        severity: 'error',
        message: error instanceof Error ? error.message : String(error),
      },
    ]);
    await writeReport(report);
    return report;
  } finally {
    if (browser && !options.keepBrowserOpen) {
      await browser.close();
    }
    await server.close();
  }
}

function emptyReport(
  options: AnalyzerOptions,
  thresholds: AnalyzerThresholds,
  sampleHz: number,
  metadata: { width: number; height: number; duration: number },
  roi: MotionRoi,
  findings: Finding[],
): AnalyzerReport {
  return {
    ok: false,
    videoPath: options.videoPath,
    outputDir: options.outputDir,
    generatedAt: new Date().toISOString(),
    markerProtocolVersion: MARKER_PROTOCOL_VERSION,
    video: { ...metadata, sampleHz, frameCount: 0 },
    requiredMotionStepIds: options.requiredMotionStepIds,
    thresholds,
    roi,
    calibration: {
      motionScale: 1,
      effectiveThresholds: {
        minRequiredMotionPx: thresholds.minRequiredMotionPx,
        jumpPx: thresholds.jumpPx,
        oscillationMinShiftPx: thresholds.oscillationMinShiftPx,
        oscillationMinTotalPx: thresholds.oscillationMinTotalPx,
        stillnessMeanDifference: thresholds.stillnessMeanDifference,
        minTextureScore: thresholds.minTextureScore,
        minMotionConfidence: thresholds.minMotionConfidence,
        effectiveJumpPx: effectiveJumpThreshold(roi, thresholds),
      },
      marker: {
        maxColourDistance: thresholds.markerMaxColourDistance,
        minDistanceMargin: thresholds.markerMinDistanceMargin,
      },
    },
    markerSamples: {
      valid: 0,
      invalid: 0,
      ignoredLeadingInvalid: 0,
      ignoredTrailingInvalid: 0,
    },
    segments: [],
    findings,
    evidence: { frames: [] },
  };
}

async function writeReport(report: AnalyzerReport): Promise<void> {
  await mkdir(report.outputDir, { recursive: true });
  await writeFile(join(report.outputDir, 'motion.json'), `${JSON.stringify(report, null, 2)}\n`);
}

function defaultRoi(videoWidth: number, videoHeight: number, override?: Partial<MotionRoi>): MotionRoi {
  const topChrome = 72;
  const leftMargin = 32;
  const rightMarkerExclusion = MARKER_WIDTH + MARKER_PADDING * 2 + 24;
  const bottomMargin = 48;
  const roi: MotionRoi = {
    x: leftMargin,
    y: topChrome,
    width: Math.max(80, videoWidth - leftMargin - rightMarkerExclusion),
    height: Math.max(80, videoHeight - topChrome - bottomMargin),
  };
  return { ...roi, ...override };
}

function decodeMarker(cells: RgbTuple[], thresholds: AnalyzerThresholds): MarkerDecode | MarkerDecodeFailure {
  const guard = cells[0];
  const phase = cells[1];
  if (!guard || !phase) {
    return { ok: false, reason: 'absent', detail: 'marker cells were not sampled' };
  }

  const guardDistance = colourDistance(guard, MARKER_COLOURS.guard);
  if (guardDistance > thresholds.markerMaxColourDistance) {
    return { ok: false, reason: 'absent', detail: `guard distance ${guardDistance.toFixed(1)}` };
  }

  const phaseChoices = [
    { phase: 'settled' as const, distance: colourDistance(phase, MARKER_COLOURS.phase.settled) },
    { phase: 'transition' as const, distance: colourDistance(phase, MARKER_COLOURS.phase.transition) },
  ].sort((a, b) => a.distance - b.distance);
  const bestPhase = phaseChoices[0];
  const secondPhase = phaseChoices[1];
  if (!bestPhase || !secondPhase || bestPhase.distance > thresholds.markerMaxColourDistance || secondPhase.distance - bestPhase.distance < thresholds.markerMinDistanceMargin) {
    return { ok: false, reason: 'ambiguous', detail: `phase distances ${phaseChoices.map((choice) => choice.distance.toFixed(1)).join(', ')}` };
  }

  let stepId = 0;
  let worstBit = 0;
  for (let index = 0; index < cells.length - 2; index += 1) {
    const cell = cells[index + 2];
    if (!cell) {
      return { ok: false, reason: 'ambiguous', detail: `missing bit ${index}` };
    }
    const zeroDistance = colourDistance(cell, MARKER_COLOURS.bit.zero);
    const oneDistance = colourDistance(cell, MARKER_COLOURS.bit.one);
    const bitDistance = Math.min(zeroDistance, oneDistance);
    worstBit = Math.max(worstBit, bitDistance);
    const margin = Math.abs(zeroDistance - oneDistance);
    if (bitDistance > thresholds.markerMaxColourDistance || margin < thresholds.markerMinDistanceMargin) {
      return { ok: false, reason: 'ambiguous', detail: `bit ${index} distances zero=${zeroDistance.toFixed(1)} one=${oneDistance.toFixed(1)}` };
    }
    stepId = (stepId << 1) | (oneDistance < zeroDistance ? 1 : 0);
  }

  return {
    ok: true,
    phase: bestPhase.phase,
    stepId,
    distances: {
      guard: guardDistance,
      phase: bestPhase.distance,
      worstBit,
    },
  };
}

function colourDistance(a: RgbTuple, b: readonly [number, number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

export function markerEnvelopeFor(samples: FrameSample[]): {
  envelopeSamples: FrameSample[];
  stats: AnalyzerReport['markerSamples'];
} {
  const validIndexes = samples.filter((sample) => sample.marker.ok).map((sample) => sample.index);
  const firstValidIndex = validIndexes[0];
  const lastValidIndex = validIndexes.at(-1);
  const invalid = samples.length - validIndexes.length;
  if (firstValidIndex === undefined || lastValidIndex === undefined) {
    return {
      envelopeSamples: samples,
      stats: {
        valid: 0,
        invalid,
        ignoredLeadingInvalid: 0,
        ignoredTrailingInvalid: 0,
      },
    };
  }

  return {
    envelopeSamples: samples.filter((sample) => sample.index >= firstValidIndex && sample.index <= lastValidIndex),
    stats: {
      valid: validIndexes.length,
      invalid,
      ignoredLeadingInvalid: samples.filter((sample) => sample.index < firstValidIndex && !sample.marker.ok).length,
      ignoredTrailingInvalid: samples.filter((sample) => sample.index > lastValidIndex && !sample.marker.ok).length,
      firstValidIndex,
      lastValidIndex,
    },
  };
}

export function markerEnvelopeFindings(
  allSamples: readonly FrameSample[],
  envelopeSamples: readonly FrameSample[],
  markerStats: AnalyzerReport['markerSamples'],
): Finding[] {
  if (markerStats.valid === 0) {
    return [
      {
        code: 'marker-absent',
        severity: 'error',
        message: 'No valid workbook factory marker was decoded from any sampled video frame.',
        frameIndexes: allSamples.map((sample) => sample.index),
      },
    ];
  }

  const findings: Finding[] = [];
  const internalFailures = envelopeSamples.filter((sample) => !sample.marker.ok);
  const internalAbsent = internalFailures.filter((sample) => !sample.marker.ok && sample.marker.reason === 'absent');
  const internalAmbiguous = internalFailures.filter((sample) => !sample.marker.ok && sample.marker.reason === 'ambiguous');
  if (internalAbsent.length > 0) {
    findings.push({
      code: 'marker-absent',
      severity: 'error',
      message: `${internalAbsent.length} sampled frame(s) inside the valid marker envelope did not contain the workbook factory marker guard swatch.`,
      frameIndexes: internalAbsent.map((sample) => sample.index),
      details: { envelope: { firstValidIndex: markerStats.firstValidIndex, lastValidIndex: markerStats.lastValidIndex } },
    });
  }
  if (internalAmbiguous.length > 0) {
    findings.push({
      code: 'marker-ambiguous',
      severity: 'error',
      message: `${internalAmbiguous.length} sampled frame(s) inside the valid marker envelope had an ambiguous workbook factory marker.`,
      frameIndexes: internalAmbiguous.map((sample) => sample.index),
      details: { envelope: { firstValidIndex: markerStats.firstValidIndex, lastValidIndex: markerStats.lastValidIndex } },
    });
  }
  return findings;
}

export function missingRequiredMotionStepFindings(requiredMotionStepIds: number[], segments: readonly Pick<MotionSegment, 'stepId'>[]): Finding[] {
  const seenTransitionSteps = new Set(segments.map((segment) => segment.stepId));
  return requiredMotionStepIds
    .filter((stepId) => !seenTransitionSteps.has(stepId))
    .map((stepId) => ({
      code: 'missing-required-step' as const,
      stepId,
      severity: 'error' as const,
      message: `Required motion step ${stepId} did not appear as a marker-labelled transition segment.`,
    }));
}

export function evaluateSegmentFindings(
  segment: MotionSegment,
  roi: MotionRoi,
  thresholds: AnalyzerThresholds,
  requiredStepIds: ReadonlySet<number>,
): Finding[] {
  const findings: Finding[] = [];
  if (segment.frameIndexes.length < 2) {
    return [
      {
        code: 'segment-too-short',
        stepId: segment.stepId,
        severity: 'error',
        message: `Step ${segment.stepId} transition segment has fewer than two sampled frames.`,
        frameIndexes: segment.frameIndexes,
        startTime: segment.startTime,
        endTime: segment.endTime,
      },
    ];
  }

  if (segment.texture < thresholds.minTextureScore) {
    findings.push({
      code: 'insufficient-texture',
      stepId: segment.stepId,
      severity: 'error',
      message: `Step ${segment.stepId} transition segment lacks enough texture for deterministic translation measurement.`,
      frameIndexes: segment.frameIndexes,
      startTime: segment.startTime,
      endTime: segment.endTime,
      details: { texture: segment.texture, threshold: thresholds.minTextureScore },
    });
  }

  if (segment.lowConfidenceMotionCount > 0) {
    findings.push({
      code: 'insufficient-motion-confidence',
      stepId: segment.stepId,
      severity: 'error',
      message: `Step ${segment.stepId} has ${segment.lowConfidenceMotionCount} moving sample pair(s) below deterministic motion-confidence threshold.`,
      frameIndexes: segment.frameIndexes,
      startTime: segment.startTime,
      endTime: segment.endTime,
      details: { confidence: segment.confidence, threshold: thresholds.minMotionConfidence },
    });
    return findings;
  }

  const appearsStatic = segment.totalAbsShiftPx < thresholds.minRequiredMotionPx;
  if (requiredStepIds.has(segment.stepId) && appearsStatic) {
    findings.push({
      code: 'no-motion',
      stepId: segment.stepId,
      severity: 'error',
      message: `Step ${segment.stepId} is required to move but decoded only ${segment.totalAbsShiftPx.toFixed(1)} px of vertical motion.`,
      frameIndexes: segment.frameIndexes,
      startTime: segment.startTime,
      endTime: segment.endTime,
      details: { totalAbsShiftPx: segment.totalAbsShiftPx, threshold: thresholds.minRequiredMotionPx },
    });
  }

  const jump = jumpEvidence(segment, roi, thresholds);
  if (jump) {
    findings.push({
      code: 'jump',
      stepId: segment.stepId,
      severity: 'error',
      message: `Step ${segment.stepId} contains an isolated ${jump.shiftPx.toFixed(1)} px adjacent-frame teleport.`,
      frameIndexes: [jump.fromIndex, jump.toIndex],
      startTime: jump.fromTime,
      endTime: jump.toTime,
      details: { shiftPx: jump.shiftPx, effectiveThresholdPx: jump.thresholdPx, neighbourMaxPx: jump.neighbourMaxPx },
    });
  }

  if (segment.signReversals >= 2 && segment.totalAbsShiftPx >= thresholds.oscillationMinTotalPx) {
    findings.push({
      code: 'oscillation',
      stepId: segment.stepId,
      severity: 'error',
      message: `Step ${segment.stepId} reverses vertical direction ${segment.signReversals} times during transition.`,
      frameIndexes: segment.frameIndexes,
      startTime: segment.startTime,
      endTime: segment.endTime,
      details: {
        signReversals: segment.signReversals,
        totalAbsShiftPx: segment.totalAbsShiftPx,
        minTotalPx: thresholds.oscillationMinTotalPx,
      },
    });
  }

  return findings;
}

function buildSegments(samples: FrameSample[], thresholds: AnalyzerThresholds): MotionSegment[] {
  const segments: MotionSegment[] = [];
  let current: FrameSample[] = [];
  const flush = (): void => {
    if (current.length === 0) {
      return;
    }
    segments.push(measureSegment(current, thresholds));
    current = [];
  };

  for (const sample of samples) {
    if (!sample.marker.ok || sample.marker.phase !== 'transition') {
      flush();
      continue;
    }
    const currentStep = current[0]?.marker.ok ? current[0].marker.stepId : undefined;
    if (current.length > 0 && currentStep !== sample.marker.stepId) {
      flush();
    }
    current.push(sample);
  }
  flush();
  return segments;
}

function measureSegment(frames: FrameSample[], thresholds: AnalyzerThresholds): MotionSegment {
  const first = frames[0];
  const last = frames.at(-1);
  if (!first || !last || !first.marker.ok) {
    throw new Error('measureSegment requires at least one valid transition frame');
  }
  const motions: AdjacentMotion[] = [];
  for (let index = 1; index < frames.length; index += 1) {
    const previous = frames[index - 1];
    const next = frames[index];
    if (!previous || !next) {
      continue;
    }
    motions.push(estimateVerticalShift(previous, next, thresholds));
  }
  const reliableMotions = motions.filter((motion) => motion.confidence >= thresholds.minMotionConfidence || Math.abs(motion.shiftPx) < thresholds.oscillationMinShiftPx);
  const shifts = reliableMotions.map((motion) => motion.shiftPx);
  const totalAbsShiftPx = shifts.reduce((sum, shift) => sum + Math.abs(shift), 0);
  const netShiftPx = shifts.reduce((sum, shift) => sum + shift, 0);
  const maxAdjacentShiftPx = shifts.reduce((max, shift) => Math.max(max, Math.abs(shift)), 0);
  const signed = shifts
    .map((shift) => (Math.abs(shift) >= thresholds.oscillationMinShiftPx ? Math.sign(shift) : 0))
    .filter((sign) => sign !== 0);
  let signReversals = 0;
  for (let index = 1; index < signed.length; index += 1) {
    if (signed[index] !== signed[index - 1]) {
      signReversals += 1;
    }
  }

  return {
    stepId: first.marker.stepId,
    startTime: first.time,
    endTime: last.time,
    frameIndexes: frames.map((frame) => frame.index),
    motions,
    totalAbsShiftPx,
    netShiftPx,
    maxAdjacentShiftPx,
    signReversals,
    confidence: average(motions.map((motion) => motion.confidence)),
    lowConfidenceMotionCount: motions.filter(
      (motion) => motion.unshiftedDifference > thresholds.stillnessMeanDifference && motion.confidence < thresholds.minMotionConfidence,
    ).length,
    texture: average(motions.map((motion) => motion.texture)),
  };
}

function effectiveJumpThreshold(roi: MotionRoi, thresholds: AnalyzerThresholds): number {
  return Math.max(thresholds.jumpPx, roi.height * thresholds.jumpViewportRatio);
}

function jumpEvidence(segment: MotionSegment, roi: MotionRoi, thresholds: AnalyzerThresholds): {
  fromIndex: number;
  toIndex: number;
  fromTime: number;
  toTime: number;
  shiftPx: number;
  thresholdPx: number;
  neighbourMaxPx: number;
} | undefined {
  const thresholdPx = effectiveJumpThreshold(roi, thresholds);
  for (let index = 0; index < segment.motions.length; index += 1) {
    for (const span of [1, 2]) {
      const window = segment.motions.slice(index, index + span);
      if (window.length !== span || window.some((motion) => motion.confidence < thresholds.minMotionConfidence)) {
        continue;
      }
      const signs = window.map((motion) => Math.sign(motion.shiftPx));
      if (signs.some((sign) => sign === 0) || new Set(signs).size !== 1) {
        continue;
      }
      const shiftPx = window.reduce((sum, motion) => sum + motion.shiftPx, 0);
      if (Math.abs(shiftPx) < thresholdPx) {
        continue;
      }
      const previous = segment.motions[index - 1];
      const next = segment.motions[index + span];
      if (!isReliableNeighbourMotion(previous, thresholds) || !isReliableNeighbourMotion(next, thresholds)) {
        continue;
      }
      const neighbourMaxPx = Math.max(Math.abs(previous.shiftPx), Math.abs(next.shiftPx), thresholds.minRequiredMotionPx);
      if (Math.abs(shiftPx) >= neighbourMaxPx * thresholds.jumpIsolationRatio) {
        const first = window[0];
        const last = window.at(-1);
        if (first && last) {
          return {
            fromIndex: first.fromIndex,
            toIndex: last.toIndex,
            fromTime: first.fromTime,
            toTime: last.toTime,
            shiftPx,
            thresholdPx,
            neighbourMaxPx,
          };
        }
      }
    }
  }
  return undefined;
}

function isReliableNeighbourMotion(motion: AdjacentMotion | undefined, thresholds: AnalyzerThresholds): motion is AdjacentMotion {
  return motion !== undefined && motion.confidence >= thresholds.minMotionConfidence;
}

function estimateVerticalShift(previous: FrameSample, next: FrameSample, thresholds: AnalyzerThresholds): AdjacentMotion {
  const width = previous.grayWidth;
  const height = previous.grayHeight;
  if (width !== next.grayWidth || height !== next.grayHeight) {
    throw new Error('motion frames must have matching gray dimensions');
  }
  const pxPerGrayPx = previous.roi.height / height;
  const unshiftedDifference = meanDifference(previous.gray, next.gray, width, height, 0, 3);
  const texture = Math.min(textureScore(previous.gray, width, height), textureScore(next.gray, width, height));

  if (unshiftedDifference <= thresholds.stillnessMeanDifference) {
    return {
      fromIndex: previous.index,
      toIndex: next.index,
      fromTime: previous.time,
      toTime: next.time,
      shiftPx: 0,
      confidence: 1,
      noise: unshiftedDifference,
      texture,
      unshiftedDifference,
    };
  }

  const maxShiftGray = Math.max(1, Math.min(Math.round(thresholds.maxShiftPx / pxPerGrayPx), Math.floor(height * 0.8)));
  let bestShift = 0;
  let bestScore = Number.POSITIVE_INFINITY;
  let secondBestScore = Number.POSITIVE_INFINITY;
  for (let shift = -maxShiftGray; shift <= maxShiftGray; shift += 1) {
    const score = meanDifference(previous.gray, next.gray, width, height, shift, 3);
    if (score < bestScore) {
      secondBestScore = bestScore;
      bestScore = score;
      bestShift = shift;
    } else if (score < secondBestScore) {
      secondBestScore = score;
    }
  }

  const refinedStart = Math.max(-maxShiftGray, bestShift - 2);
  const refinedEnd = Math.min(maxShiftGray, bestShift + 2);
  for (let shift = refinedStart; shift <= refinedEnd; shift += 0.25) {
    const score = meanDifferenceInterpolated(previous.gray, next.gray, width, height, shift, 2);
    if (score < bestScore) {
      secondBestScore = bestScore;
      bestScore = score;
      bestShift = shift;
    } else if (score < secondBestScore && Math.abs(shift - bestShift) > 0.5) {
      secondBestScore = score;
    }
  }

  const improvementConfidence = Math.max(0, Math.min(1, (unshiftedDifference - bestScore) / Math.max(1, unshiftedDifference)));
  const neighbourConfidence = Math.max(0, Math.min(1, (secondBestScore - bestScore) / Math.max(1, bestScore)));
  const confidence = Math.max(improvementConfidence, neighbourConfidence * 0.5);
  return {
    fromIndex: previous.index,
    toIndex: next.index,
    fromTime: previous.time,
    toTime: next.time,
    shiftPx: bestShift * pxPerGrayPx,
    confidence,
    noise: bestScore,
    texture,
    unshiftedDifference,
  };
}

function meanDifference(a: Uint8Array, b: Uint8Array, width: number, height: number, shiftY: number, stride: number): number {
  let total = 0;
  let count = 0;
  const startY = Math.max(0, -shiftY);
  const endY = Math.min(height, height - shiftY);
  for (let y = startY; y < endY; y += stride) {
    const shiftedY = y + shiftY;
    for (let x = 0; x < width; x += stride) {
      const aValue = a[y * width + x];
      const bValue = b[shiftedY * width + x];
      if (aValue === undefined || bValue === undefined) {
        continue;
      }
      total += Math.abs(aValue - bValue);
      count += 1;
    }
  }
  return count === 0 ? Number.POSITIVE_INFINITY : total / count;
}

function meanDifferenceInterpolated(a: Uint8Array, b: Uint8Array, width: number, height: number, shiftY: number, stride: number): number {
  let total = 0;
  let count = 0;
  const startY = Math.max(0, Math.ceil(-shiftY));
  const endY = Math.min(height - 1, Math.floor(height - shiftY - 1));
  for (let y = startY; y < endY; y += stride) {
    const shiftedY = y + shiftY;
    const lowY = Math.floor(shiftedY);
    const highY = Math.min(height - 1, lowY + 1);
    const fraction = shiftedY - lowY;
    for (let x = 0; x < width; x += stride) {
      const aValue = a[y * width + x];
      const low = b[lowY * width + x];
      const high = b[highY * width + x];
      if (aValue === undefined || low === undefined || high === undefined) {
        continue;
      }
      const bValue = low * (1 - fraction) + high * fraction;
      total += Math.abs(aValue - bValue);
      count += 1;
    }
  }
  return count === 0 ? Number.POSITIVE_INFINITY : total / count;
}

function textureScore(gray: Uint8Array, width: number, height: number): number {
  let total = 0;
  let count = 0;
  for (let y = 1; y < height; y += 4) {
    for (let x = 1; x < width; x += 4) {
      const index = y * width + x;
      const value = gray[index];
      const left = gray[index - 1];
      const up = gray[index - width];
      if (value === undefined || left === undefined || up === undefined) {
        continue;
      }
      total += (Math.abs(value - left) + Math.abs(value - up)) / 2;
      count += 1;
    }
  }
  return count === 0 ? 0 : total / count;
}

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

async function installDecoderScript(page: Page): Promise<void> {
  await page.addScriptTag({
    content: `
      window.__wfGetVideoMetadata = async function() {
        const video = document.querySelector('video');
        if (!video) throw new Error('missing video element');
        if (video.readyState < HTMLMediaElement.HAVE_METADATA) {
          await new Promise((resolve, reject) => {
            const onLoaded = () => { cleanup(); resolve(); };
            const onError = () => { cleanup(); reject(new Error('video metadata failed to load')); };
            const cleanup = () => {
              video.removeEventListener('loadedmetadata', onLoaded);
              video.removeEventListener('error', onError);
            };
            video.addEventListener('loadedmetadata', onLoaded, { once: true });
            video.addEventListener('error', onError, { once: true });
          });
        }
        return { width: video.videoWidth, height: video.videoHeight, duration: video.duration };
      };

      window.__wfSeekVideo = async function(time) {
        const video = document.querySelector('video');
        if (!video) throw new Error('missing video element');
        const seekTime = Math.min(Math.max(0, time), Math.max(0, video.duration - 0.01));
        if (Math.abs(video.currentTime - seekTime) < 0.001 && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
          await new Promise((resolve) => requestAnimationFrame(() => resolve()));
          return seekTime;
        }
        await new Promise((resolve, reject) => {
          const timeout = window.setTimeout(() => { cleanup(); reject(new Error('timed out seeking to ' + seekTime)); }, 5000);
          const cleanup = () => {
            window.clearTimeout(timeout);
            video.removeEventListener('seeked', onSeeked);
            video.removeEventListener('error', onError);
          };
          const onSeeked = () => { cleanup(); resolve(); };
          const onError = () => { cleanup(); reject(new Error('video seek failed')); };
          video.addEventListener('seeked', onSeeked, { once: true });
          video.addEventListener('error', onError, { once: true });
          video.currentTime = seekTime;
        });
        await new Promise((resolve) => requestAnimationFrame(() => resolve()));
        return seekTime;
      };

      window.__wfGetCanvas = function(id, canvasWidth, canvasHeight) {
        let canvas = document.getElementById(id);
        if (!canvas) {
          canvas = document.createElement('canvas');
          canvas.id = id;
          canvas.style.display = 'none';
          document.body.append(canvas);
        }
        canvas.width = canvasWidth;
        canvas.height = canvasHeight;
        return canvas;
      };

      window.__wfCaptureSample = async function(args) {
        const video = document.querySelector('video');
        if (!video) throw new Error('missing video element');
        const seekTime = await window.__wfSeekVideo(args.time);
        const width = video.videoWidth;
        const height = video.videoHeight;
        const fullCanvas = window.__wfGetCanvas('wf-full-canvas', width, height);
        const fullContext = fullCanvas.getContext('2d', { willReadFrequently: true });
        if (!fullContext) throw new Error('2d canvas unavailable');
        fullContext.drawImage(video, 0, 0, width, height);

        const markerX = width - args.constants.markerPadding - args.constants.markerWidth;
        const markerY = args.constants.markerPadding;
        const cellSize = args.constants.markerHeight;
        const markerCells = [];
        for (let index = 0; index < args.constants.markerTotalCells; index += 1) {
          const x = markerX + index * (cellSize + args.constants.markerGap) + args.constants.markerInset;
          const y = markerY + args.constants.markerInset;
          const sampleWidth = cellSize - args.constants.markerInset * 2;
          const data = fullContext.getImageData(x, y, sampleWidth, sampleWidth).data;
          let r = 0, g = 0, b = 0;
          for (let offset = 0; offset < data.length; offset += 4) {
            r += data[offset] || 0;
            g += data[offset + 1] || 0;
            b += data[offset + 2] || 0;
          }
          const count = data.length / 4;
          markerCells.push([Math.round(r / count), Math.round(g / count), Math.round(b / count)]);
        }

        const roiX = Math.max(0, Math.min(width - 1, args.roi.x));
        const roiY = Math.max(0, Math.min(height - 1, args.roi.y));
        const safeRoi = {
          x: roiX,
          y: roiY,
          width: Math.max(1, Math.min(width - roiX, args.roi.width)),
          height: Math.max(1, Math.min(height - roiY, args.roi.height)),
        };
        const scale = Math.min(1, args.maxMotionWidth / safeRoi.width);
        const grayWidth = Math.max(1, Math.round(safeRoi.width * scale));
        const grayHeight = Math.max(1, Math.round(safeRoi.height * scale));
        const roiCanvas = window.__wfGetCanvas('wf-roi-canvas', grayWidth, grayHeight);
        const roiContext = roiCanvas.getContext('2d', { willReadFrequently: true });
        if (!roiContext) throw new Error('2d roi canvas unavailable');
        roiContext.imageSmoothingEnabled = true;
        roiContext.drawImage(fullCanvas, safeRoi.x, safeRoi.y, safeRoi.width, safeRoi.height, 0, 0, grayWidth, grayHeight);
        const rgba = roiContext.getImageData(0, 0, grayWidth, grayHeight).data;
        const gray = new Array(grayWidth * grayHeight);
        for (let index = 0, pixel = 0; index < rgba.length; index += 4, pixel += 1) {
          gray[pixel] = Math.round((0.2126 * (rgba[index] || 0)) + (0.7152 * (rgba[index + 1] || 0)) + (0.0722 * (rgba[index + 2] || 0)));
        }
        return { time: seekTime, width, height, roi: safeRoi, grayWidth, grayHeight, gray, markerCells };
      };

      window.__wfCapturePng = async function(args) {
        const video = document.querySelector('video');
        if (!video) throw new Error('missing video element');
        const seekTime = await window.__wfSeekVideo(args.time);
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(video.videoWidth * args.scale);
        canvas.height = Math.round(video.videoHeight * args.scale);
        const context = canvas.getContext('2d');
        if (!context) throw new Error('2d canvas unavailable');
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL('image/png');
      };

      window.__wfCaptureContactSheet = async function(sheetTimes) {
        const video = document.querySelector('video');
        if (!video) throw new Error('missing video element');
        const thumbWidth = 240;
        const thumbHeight = Math.round(thumbWidth * (video.videoHeight / video.videoWidth));
        const labelHeight = 24;
        const columns = 3;
        const rows = Math.ceil(sheetTimes.length / columns);
        const canvas = document.createElement('canvas');
        canvas.width = columns * thumbWidth;
        canvas.height = rows * (thumbHeight + labelHeight);
        const context = canvas.getContext('2d');
        if (!context) throw new Error('2d canvas unavailable');
        context.fillStyle = '#111';
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.font = '14px sans-serif';
        for (let index = 0; index < sheetTimes.length; index += 1) {
          const seekTime = await window.__wfSeekVideo(sheetTimes[index] || 0);
          const column = index % columns;
          const row = Math.floor(index / columns);
          const x = column * thumbWidth;
          const y = row * (thumbHeight + labelHeight);
          context.drawImage(video, x, y, thumbWidth, thumbHeight);
          context.fillStyle = 'rgba(0, 0, 0, 0.75)';
          context.fillRect(x, y + thumbHeight, thumbWidth, labelHeight);
          context.fillStyle = '#fff';
          context.fillText(seekTime.toFixed(2) + 's', x + 8, y + thumbHeight + 17);
        }
        return canvas.toDataURL('image/png');
      };
    `,
  });
}

async function getVideoMetadata(page: Page): Promise<{ width: number; height: number; duration: number }> {
  return page.evaluate('window.__wfGetVideoMetadata()') as Promise<{ width: number; height: number; duration: number }>;
}

async function decodeSamples(page: Page, duration: number, sampleHz: number, roi: MotionRoi, maxMotionWidth: number): Promise<BrowserFrameSample[]> {
  if (!Number.isFinite(duration) || duration <= 0) {
    return Promise.resolve([]);
  }
  const interval = 1 / sampleHz;
  const times: number[] = [];
  for (let time = 0; time < duration; time += interval) {
    times.push(Number(time.toFixed(4)));
  }
  const lastTime = Math.max(0, duration - 0.04);
  if (times.length === 0 || Math.abs((times.at(-1) ?? 0) - lastTime) > interval / 2) {
    times.push(Number(lastTime.toFixed(4)));
  }

  const samples: BrowserFrameSample[] = [];
  for (const time of times) {
    samples.push(await captureSample(page, time, roi, maxMotionWidth));
  }
  return samples;
}

async function captureSample(page: Page, time: number, roi: MotionRoi, maxMotionWidth: number): Promise<BrowserFrameSample> {
  const constants = {
    markerWidth: MARKER_WIDTH,
    markerHeight: MARKER_HEIGHT,
    markerPadding: MARKER_PADDING,
    markerGap: MARKER_GAP,
    markerInset: MARKER_SAMPLE_INSET,
    markerTotalCells: MARKER_TOTAL_CELLS,
  };
  const args = JSON.stringify({ time, roi, maxMotionWidth, constants });
  return page.evaluate(`window.__wfCaptureSample(${args})`) as Promise<BrowserFrameSample>;
}

async function writeEvidence(
  page: Page,
  outputDir: string,
  samples: FrameSample[],
  segments: MotionSegment[],
  findings: Finding[],
): Promise<AnalyzerReport['evidence']> {
  const frameTimes = new Map<string, number>();
  const pushFrame = (name: string, time: number): void => {
    frameTimes.set(sanitiseEvidenceName(name), time);
  };

  for (const finding of findings) {
    const stepSuffix = finding.stepId === undefined ? 'unknown' : String(finding.stepId);
    const evidencePrefix = `${finding.code}-step-${stepSuffix}`;
    if (finding.startTime !== undefined) {
      pushFrame(`${evidencePrefix}-start`, finding.startTime);
    }
    if (finding.startTime !== undefined && finding.endTime !== undefined) {
      pushFrame(`${evidencePrefix}-mid`, (finding.startTime + finding.endTime) / 2);
    }
    if (finding.endTime !== undefined) {
      pushFrame(`${evidencePrefix}-end`, finding.endTime);
    }
    if (finding.startTime === undefined && finding.endTime === undefined && finding.frameIndexes && finding.frameIndexes.length > 0) {
      const firstFrame = samples.find((sample) => sample.index === finding.frameIndexes?.[0]);
      const middleFrame = samples.find((sample) => sample.index === finding.frameIndexes?.[Math.floor((finding.frameIndexes?.length ?? 1) / 2)]);
      const lastFrame = samples.find((sample) => sample.index === finding.frameIndexes?.at(-1));
      if (firstFrame) {
        pushFrame(`${evidencePrefix}-first`, firstFrame.time);
      }
      if (middleFrame && middleFrame.index !== firstFrame?.index) {
        pushFrame(`${evidencePrefix}-mid`, middleFrame.time);
      }
      if (lastFrame && lastFrame.index !== firstFrame?.index && lastFrame.index !== middleFrame?.index) {
        pushFrame(`${evidencePrefix}-last`, lastFrame.time);
      }
    }
  }

  if (frameTimes.size === 0) {
    for (const segment of segments.slice(0, 4)) {
      pushFrame(`step-${segment.stepId}-mid`, (segment.startTime + segment.endTime) / 2);
    }
  }

  const frameFiles: string[] = [];
  for (const [name, time] of frameTimes) {
    const dataUrl = await capturePng(page, time, 1);
    const fileName = `${name}.png`;
    await writeFile(join(outputDir, fileName), dataUrlToBuffer(dataUrl));
    frameFiles.push(fileName);
  }

  const contactTimes = chooseContactSheetTimes(samples, segments);
  let contactSheet: string | undefined;
  if (contactTimes.length > 0) {
    const dataUrl = await captureContactSheet(page, contactTimes);
    contactSheet = 'contact-sheet.png';
    await writeFile(join(outputDir, contactSheet), dataUrlToBuffer(dataUrl));
  }

  return { frames: frameFiles, contactSheet };
}

function chooseContactSheetTimes(samples: FrameSample[], segments: MotionSegment[]): number[] {
  const times: number[] = [];
  for (const segment of segments) {
    times.push(segment.startTime, (segment.startTime + segment.endTime) / 2, segment.endTime);
  }
  if (times.length === 0) {
    const stride = Math.max(1, Math.floor(samples.length / 12));
    for (let index = 0; index < samples.length; index += stride) {
      const sample = samples[index];
      if (sample) {
        times.push(sample.time);
      }
    }
  }
  return [...new Set(times.map((time) => Number(time.toFixed(3))))].slice(0, 18);
}

async function capturePng(page: Page, time: number, scale: number): Promise<string> {
  return page.evaluate(`window.__wfCapturePng(${JSON.stringify({ time, scale })})`) as Promise<string>;
}

async function captureContactSheet(page: Page, times: number[]): Promise<string> {
  return page.evaluate(`window.__wfCaptureContactSheet(${JSON.stringify(times)})`) as Promise<string>;
}

function dataUrlToBuffer(dataUrl: string): Buffer {
  const comma = dataUrl.indexOf(',');
  if (comma === -1) {
    throw new Error('invalid data URL');
  }
  return Buffer.from(dataUrl.slice(comma + 1), 'base64');
}

function sanitiseEvidenceName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
}

async function startVideoServer(videoPath: string): Promise<{ playerUrl: string; close: () => Promise<void> }> {
  const videoStat = await stat(videoPath);
  const videoName = basename(videoPath);
  const token = randomBytes(16).toString('hex');
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if ((url.pathname === '/' || url.pathname === '/player') && url.searchParams.get('token') === token) {
        servePlayer(response, videoName, token);
        return;
      }
      if (url.pathname !== `/video/${encodeURIComponent(videoName)}` && url.pathname !== `/video/${videoName}`) {
        response.writeHead(404).end('not found');
        return;
      }
      if (url.searchParams.get('token') !== token) {
        response.writeHead(403).end('forbidden');
        return;
      }
      await serveVideo(request, response, videoPath, videoStat.size);
    } catch (error) {
      response.writeHead(500).end(error instanceof Error ? error.message : String(error));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('could not bind video server');
  }
  return {
    playerUrl: `http://127.0.0.1:${address.port}/player?token=${token}`,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

function servePlayer(response: ServerResponse, videoName: string, token: string): void {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(`<!doctype html>
<html><head><meta charset="utf-8"><title>workbook video analyser</title></head>
<body style="margin:0;background:#111">
<video src="/video/${encodeURIComponent(videoName)}?token=${token}" preload="auto" muted playsinline style="width:1px;height:1px;opacity:0"></video>
</body></html>`);
}

async function serveVideo(request: IncomingMessage, response: ServerResponse, videoPath: string, size: number): Promise<void> {
  const range = request.headers.range;
  const commonHeaders = {
    'content-type': 'video/webm',
    'accept-ranges': 'bytes',
  };
  if (!range) {
    response.writeHead(200, { ...commonHeaders, 'content-length': size });
    pipeVideo(videoPath, response);
    return;
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match) {
    response.writeHead(416, { 'content-range': `bytes */${size}` }).end();
    return;
  }
  const startText = match[1] ?? '';
  const endText = match[2] ?? '';
  let start = startText === '' ? 0 : Number(startText);
  let end = endText === '' ? size - 1 : Number(endText);
  if (startText === '' && endText !== '') {
    const suffixLength = Number(endText);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      response.writeHead(416, { 'content-range': `bytes */${size}` }).end();
      return;
    }
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) {
    response.writeHead(416, { 'content-range': `bytes */${size}` }).end();
    return;
  }
  end = Math.min(end, size - 1);
  response.writeHead(206, {
    ...commonHeaders,
    'content-length': end - start + 1,
    'content-range': `bytes ${start}-${end}/${size}`,
  });
  pipeVideo(videoPath, response, { start, end });
}

function pipeVideo(videoPath: string, response: ServerResponse, range?: { start: number; end: number }): void {
  const stream = createReadStream(videoPath, range);
  stream.on('error', (error) => {
    if (!response.headersSent) {
      response.writeHead(500);
    }
    response.end(error.message);
  });
  stream.pipe(response);
}

export function markerDebugGeometry(videoWidth: number): ReturnType<typeof markerGeometry> {
  return markerGeometry(videoWidth);
}
