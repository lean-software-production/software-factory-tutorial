export const MARKER_PROTOCOL_VERSION = 1;

export const MARKER_BITS = 8;
export const MARKER_CELL_SIZE = 18;
export const MARKER_GAP = 4;
export const MARKER_PADDING = 12;
export const MARKER_SAMPLE_INSET = 4;

export type MarkerPhase = 'settled' | 'transition';
export type Rgb = readonly [number, number, number];

export interface MarkerState {
  phase: MarkerPhase;
  stepId: number;
}

export interface MarkerCellRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MarkerGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
  guard: MarkerCellRect;
  phase: MarkerCellRect;
  bits: MarkerCellRect[];
}

export const MARKER_COLOURS = {
  guard: [255, 0, 255] as const,
  phase: {
    settled: [0, 170, 255] as const,
    transition: [255, 196, 0] as const,
  },
  bit: {
    zero: [0, 0, 0] as const,
    one: [255, 255, 255] as const,
  },
  outline: [0, 0, 0] as const,
} satisfies Record<string, unknown>;

export const MARKER_TOTAL_CELLS = 2 + MARKER_BITS;
export const MARKER_WIDTH = MARKER_TOTAL_CELLS * MARKER_CELL_SIZE + (MARKER_TOTAL_CELLS - 1) * MARKER_GAP;
export const MARKER_HEIGHT = MARKER_CELL_SIZE;

export function markerGeometry(videoWidth: number): MarkerGeometry {
  const x = videoWidth - MARKER_PADDING - MARKER_WIDTH;
  const y = MARKER_PADDING;
  const rectAt = (index: number): MarkerCellRect => ({
    x: x + index * (MARKER_CELL_SIZE + MARKER_GAP),
    y,
    width: MARKER_CELL_SIZE,
    height: MARKER_CELL_SIZE,
  });

  return {
    x,
    y,
    width: MARKER_WIDTH,
    height: MARKER_HEIGHT,
    guard: rectAt(0),
    phase: rectAt(1),
    bits: Array.from({ length: MARKER_BITS }, (_, index) => rectAt(index + 2)),
  };
}

export function encodeStepBits(stepId: number): readonly number[] {
  if (!Number.isInteger(stepId) || stepId < 0 || stepId >= 2 ** MARKER_BITS) {
    throw new Error(`stepId must be an integer from 0 to ${2 ** MARKER_BITS - 1}; got ${stepId}`);
  }

  return Array.from({ length: MARKER_BITS }, (_, index) => (stepId >> (MARKER_BITS - index - 1)) & 1);
}

export function rgbCss(rgb: Rgb): string {
  return `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
}

export function markerCellColours(state: MarkerState): readonly Rgb[] {
  return [
    MARKER_COLOURS.guard,
    MARKER_COLOURS.phase[state.phase],
    ...encodeStepBits(state.stepId).map((bit) => (bit === 1 ? MARKER_COLOURS.bit.one : MARKER_COLOURS.bit.zero)),
  ];
}

export function markerHtml(state: MarkerState): string {
  const cells = markerCellColours(state)
    .map((colour, index) => `<div class="wf-marker-cell" data-marker-cell="${index}" style="background:${rgbCss(colour)}"></div>`)
    .join('');
  return `<div class="wf-marker" data-marker-step="${state.stepId}" data-marker-phase="${state.phase}">${cells}</div>`;
}

export function markerCss(): string {
  return `
    .wf-marker {
      position: fixed;
      top: ${MARKER_PADDING}px;
      right: ${MARKER_PADDING}px;
      z-index: 2147483647;
      display: grid;
      grid-template-columns: repeat(${MARKER_TOTAL_CELLS}, ${MARKER_CELL_SIZE}px);
      gap: ${MARKER_GAP}px;
      width: ${MARKER_WIDTH}px;
      height: ${MARKER_HEIGHT}px;
      pointer-events: none;
      background: transparent;
    }
    .wf-marker-cell {
      box-sizing: border-box;
      width: ${MARKER_CELL_SIZE}px;
      height: ${MARKER_CELL_SIZE}px;
      border: 1px solid ${rgbCss(MARKER_COLOURS.outline)};
    }
  `;
}
