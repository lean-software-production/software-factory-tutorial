import { describe, expect, it } from 'vitest';
import { missingRequiredMotionStepFindings, validateSampleHz } from './analyzer.js';

describe('workbook video analyser contracts', () => {
  it('rejects non-finite and out-of-range sample rates before video decoding', () => {
    for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 61, 10_000]) {
      expect(() => validateSampleHz(value)).toThrow(/sampleHz/);
    }
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
});
