import { describe, expect, it } from 'vitest';
import {
  DEFAULT_THRESHOLDS,
  evaluateSegmentFindings,
  markerEnvelopeFindings,
  markerEnvelopeFor,
  missingRequiredMotionStepFindings,
  validateSampleHz,
  type AdjacentMotion,
  type FrameSample,
  type MotionSegment,
} from './analyzer.js';
import {
  REAL_JOURNEY_MIN_TEXTURE_SCORE,
  REAL_JOURNEY_OBSERVED_SPARSE_EDITOR_TEXTURE_FLOOR,
} from './record.mjs';

describe('workbook video analyser contracts', () => {
  it('rejects non-finite and out-of-range sample rates before video decoding', () => {
    for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 61, 10_000]) {
      expect(() => validateSampleHz(value)).toThrow(/sampleHz/);
    }
  });

  it('calibrates the real journey texture floor below observed sparse editor texture', () => {
    expect(REAL_JOURNEY_MIN_TEXTURE_SCORE).toBeGreaterThan(0);
    expect(REAL_JOURNEY_MIN_TEXTURE_SCORE).toBeLessThan(REAL_JOURNEY_OBSERVED_SPARSE_EDITOR_TEXTURE_FLOOR);
  });

  it('accepts finite sample rates in the supported range', () => {
    expect(validateSampleHz(1)).toBe(1);
    expect(validateSampleHz(11)).toBe(11);
    expect(validateSampleHz(60)).toBe(60);
  });

  it('fails closed when a required marker-labelled transition is absent', () => {
    expect(missingRequiredMotionStepFindings([1, 2, 3], [{ stepId: 1 }, { stepId: 3 }])).toMatchObject([
      { code: 'missing-required-step', stepId: 2 },
    ]);
  });

  it('reports unresolved low-confidence movement instead of factual no-motion', () => {
    const findings = evaluateSegmentFindings(
      segment({
        stepId: 7,
        totalAbsShiftPx: 0,
        lowConfidenceMotionCount: 1,
        motions: [motion({ shiftPx: 0, confidence: 0.1, unshiftedDifference: 20 })],
      }),
      roi(),
      DEFAULT_THRESHOLDS,
      new Set([7]),
    );

    expect(codes(findings)).toContain('insufficient-motion-confidence');
    expect(codes(findings)).not.toContain('no-motion');
    expect(codes(findings)).not.toContain('jump');
    expect(codes(findings)).not.toContain('oscillation');
  });

  it('allows no-motion only for confidently static required transitions', () => {
    const findings = evaluateSegmentFindings(
      segment({
        stepId: 8,
        totalAbsShiftPx: 0,
        motions: [motion({ shiftPx: 0, confidence: 1, unshiftedDifference: 0.4 })],
      }),
      roi(),
      DEFAULT_THRESHOLDS,
      new Set([8]),
    );

    expect(codes(findings)).toContain('no-motion');
    expect(codes(findings)).not.toContain('insufficient-motion-confidence');
  });

  it('does not classify a short fast smooth edge cluster as an isolated jump', () => {
    const findings = evaluateSegmentFindings(
      segment({
        stepId: 9,
        totalAbsShiftPx: 1_000,
        maxAdjacentShiftPx: 500,
        motions: [
          motion({ fromIndex: 0, toIndex: 1, shiftPx: -500, confidence: 0.9 }),
          motion({ fromIndex: 1, toIndex: 2, shiftPx: -500, confidence: 0.9 }),
        ],
      }),
      roi(),
      DEFAULT_THRESHOLDS,
      new Set([9]),
    );

    expect(codes(findings)).not.toContain('jump');
  });

  it('detects a reliable middle-of-segment teleport jump', () => {
    const findings = evaluateSegmentFindings(
      segment({
        stepId: 10,
        totalAbsShiftPx: 614,
        maxAdjacentShiftPx: 602,
        motions: [
          motion({ fromIndex: 0, toIndex: 1, shiftPx: -5, confidence: 1, unshiftedDifference: 0.8 }),
          motion({ fromIndex: 1, toIndex: 2, shiftPx: -602, confidence: 0.9, unshiftedDifference: 30 }),
          motion({ fromIndex: 2, toIndex: 3, shiftPx: -7, confidence: 1, unshiftedDifference: 1.2 }),
        ],
      }),
      roi(),
      DEFAULT_THRESHOLDS,
      new Set([10]),
    );

    expect(codes(findings)).toContain('jump');
  });

  it('fails closed when no valid marker exists in the sample envelope', () => {
    const samples = [sample(0, invalidMarker('absent')), sample(1, invalidMarker('ambiguous'))];
    const envelope = markerEnvelopeFor(samples);

    expect(envelope.stats).toMatchObject({ valid: 0, invalid: 2, ignoredLeadingInvalid: 0, ignoredTrailingInvalid: 0 });
    expect(markerEnvelopeFindings(samples, envelope.envelopeSamples, envelope.stats)).toMatchObject([
      { code: 'marker-absent', frameIndexes: [0, 1] },
    ]);
  });

  it('fails closed for invalid marker gaps inside the valid marker envelope only', () => {
    const samples = [
      sample(0, invalidMarker('absent')),
      sample(1, validMarker(1)),
      sample(2, invalidMarker('ambiguous')),
      sample(3, validMarker(1)),
      sample(4, invalidMarker('absent')),
    ];
    const envelope = markerEnvelopeFor(samples);
    const findings = markerEnvelopeFindings(samples, envelope.envelopeSamples, envelope.stats);

    expect(envelope.stats).toMatchObject({
      valid: 2,
      invalid: 3,
      ignoredLeadingInvalid: 1,
      ignoredTrailingInvalid: 1,
      firstValidIndex: 1,
      lastValidIndex: 3,
    });
    expect(findings).toMatchObject([{ code: 'marker-ambiguous', frameIndexes: [2] }]);
    expect(codes(findings)).not.toContain('marker-absent');
  });
});

function codes(findings: Array<{ code: string }>): string[] {
  return findings.map((finding) => finding.code);
}

function roi() {
  return { x: 0, y: 0, width: 1280, height: 900 };
}

function motion(overrides: Partial<AdjacentMotion> = {}): AdjacentMotion {
  return {
    fromIndex: 0,
    toIndex: 1,
    fromTime: 0,
    toTime: 0.1,
    shiftPx: 0,
    confidence: 1,
    noise: 1,
    texture: 8,
    unshiftedDifference: 10,
    ...overrides,
  };
}

function segment(overrides: Partial<MotionSegment> = {}): MotionSegment {
  const motions = overrides.motions ?? [motion()];
  return {
    stepId: 1,
    startTime: 0,
    endTime: 0.3,
    frameIndexes: [0, 1, 2],
    motions,
    totalAbsShiftPx: motions.reduce((sum, item) => sum + Math.abs(item.shiftPx), 0),
    netShiftPx: motions.reduce((sum, item) => sum + item.shiftPx, 0),
    maxAdjacentShiftPx: motions.reduce((max, item) => Math.max(max, Math.abs(item.shiftPx)), 0),
    signReversals: 0,
    confidence: 1,
    lowConfidenceMotionCount: 0,
    texture: 8,
    ...overrides,
  };
}

function sample(index: number, marker: FrameSample['marker']): FrameSample {
  return {
    index,
    time: index / 10,
    marker,
    gray: new Uint8Array([0]),
    grayWidth: 1,
    grayHeight: 1,
    roi: roi(),
  };
}

function validMarker(stepId: number): FrameSample['marker'] {
  return {
    ok: true,
    phase: 'transition',
    stepId,
    distances: { guard: 0, phase: 0, worstBit: 0 },
  };
}

function invalidMarker(reason: 'absent' | 'ambiguous'): FrameSample['marker'] {
  return { ok: false, reason, detail: `test ${reason}` };
}
