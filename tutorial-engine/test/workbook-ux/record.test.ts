import { describe, expect, it } from "vitest";
import { TerminalShellProtocol } from "../../src/workbook/terminal-shell-protocol.js";
import { ProtocolAwareFakePty } from "./fake-pty.js";
import { REQUIRED_MOTION_STEP_IDS, REQUIRED_STATE_CHECKPOINT_STEP_IDS, SCROLL_CHECKPOINT_STEP_IDS, WORKBOOK_UX_TEST_STEP_LIST, WORKBOOK_UX_TEST_STEPS } from "./steps.js";
import { encodeStepBits } from "./marker-protocol.js";
import { assertCheckpointGeometry, assertContinueLandings, assertPageHeldBetweenCheckpoints, assertRealJourneyMotionThresholdCalibration, geometryStateFailure, PAGE_HOLD_TOLERANCE_PX, REAL_JOURNEY_MIN_REQUIRED_MOTION_PX, REQUIRED_SCROLL_SEMANTIC_DELTA_MIN_PX, type GeometryTelemetry, type SemanticCheckpoint } from "./record.mjs";
import { checkpointProgressEvent, createWorkbookUxProgressLogger, formatWorkbookUxCheckpointProgress, WORKBOOK_UX_SEMANTIC_CHECKPOINT_TOTAL, type WorkbookUxProgressEvent } from "./progress.js";

describe("protocol-aware fake PTY", () => {
  it("frames typed characters as authoritative workbook command and finished markers", () => {
    const pty = new ProtocolAwareFakePty({ cwd: "/tmp/workspace", cols: 80, rows: 24 }, {
      outputForCommand: (command) => `observed:${command}\r\n`,
    });
    const protocol = new TerminalShellProtocol();
    const events: ReturnType<TerminalShellProtocol["consume"]> = [];
    pty.onData((data) => events.push(...protocol.consume(data)));

    pty.open();
    for (const char of "npm test") pty.write(char);
    pty.write("\r");

    expect(pty.commands.map((entry) => entry.command)).toEqual(["npm test"]);
    expect(events).toContainEqual({ type: "command-submitted", command: "npm test" });
    expect(events).toContainEqual({ type: "command-finished", exitStatus: 0 });
    expect(events.filter((event) => event.type === "output").map((event) => event.data).join("")).toContain("observed:npm test");
  });
});

describe("workbook UX test progress", () => {
  it("formats semantic checkpoint progress with count and step name", () => {
    expect(WORKBOOK_UX_SEMANTIC_CHECKPOINT_TOTAL).toBe(12);
    expect(formatWorkbookUxCheckpointProgress(3, WORKBOOK_UX_SEMANTIC_CHECKPOINT_TOTAL, "editor scroll from in-flow to docked band"))
      .toBe("Checkpoint 3/12: editor scroll from in-flow to docked band");
    expect(checkpointProgressEvent(1, WORKBOOK_UX_SEMANTIC_CHECKPOINT_TOTAL, WORKBOOK_UX_TEST_STEPS.editorScrollToInflow)).toMatchObject({
      type: "checkpoint",
      completed: 1,
      total: 12,
      stepId: WORKBOOK_UX_TEST_STEPS.editorScrollToInflow.id,
      message: "Checkpoint 1/12: editor reveal: Continue lands the band in view, then it is placed in flow",
    });
  });

  it("routes server diagnostics through the supplied progress sink", () => {
    const events: WorkbookUxProgressEvent[] = [];
    const logger = createWorkbookUxProgressLogger((event) => events.push(event));

    logger.info("Workbook tutor listening on http://127.0.0.1:1234.");
    logger.error("Embedded terminal startup failed", new Error("boom"));

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ type: "detail", source: "server", severity: "info" });
    expect(events[0]?.message).toContain("  server: Workbook tutor listening");
    expect(events[1]).toMatchObject({ type: "detail", source: "server", severity: "error" });
    expect(events[1]?.message).toContain("server error: Embedded terminal startup failed");
    expect(events[1]?.message).toContain("boom");
  });
});

describe("workbook UX test marker declarations", () => {
  it("keeps the real journey video motion floor below semantic scroll motion", () => {
    expect(() => assertRealJourneyMotionThresholdCalibration()).not.toThrow();
    expect(REAL_JOURNEY_MIN_REQUIRED_MOTION_PX).toBeGreaterThan(0);
    expect(REAL_JOURNEY_MIN_REQUIRED_MOTION_PX).toBeLessThan(REQUIRED_SCROLL_SEMANTIC_DELTA_MIN_PX);
  });

  it("use unique marker ids and keep feedback and required scroll phases separate", () => {
    const ids = WORKBOOK_UX_TEST_STEP_LIST.map((step) => step.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(REQUIRED_STATE_CHECKPOINT_STEP_IDS).toHaveLength(6);
    expect(SCROLL_CHECKPOINT_STEP_IDS).toHaveLength(6);
    expect(REQUIRED_MOTION_STEP_IDS.length).toBeGreaterThan(0);
    const feedbackIds = new Set<number>(REQUIRED_STATE_CHECKPOINT_STEP_IDS);
    const scrollIds = new Set<number>(SCROLL_CHECKPOINT_STEP_IDS);
    for (const id of REQUIRED_MOTION_STEP_IDS) expect(scrollIds.has(id)).toBe(true);
    for (const id of REQUIRED_STATE_CHECKPOINT_STEP_IDS) expect(scrollIds.has(id)).toBe(false);
    for (const id of SCROLL_CHECKPOINT_STEP_IDS) expect(feedbackIds.has(id)).toBe(false);
    for (const id of [...REQUIRED_STATE_CHECKPOINT_STEP_IDS, ...SCROLL_CHECKPOINT_STEP_IDS, ...REQUIRED_MOTION_STEP_IDS]) expect(encodeStepBits(id)).toHaveLength(8);
  });
});

function geometry(overrides: Partial<GeometryTelemetry> & { bandTop: number; scrollY: number }): GeometryTelemetry {
  const { bandTop, scrollY, ...rest } = overrides;
  const rect = { x: 0, y: bandTop, width: 720, height: 500, top: bandTop, right: 720, bottom: bandTop + 500, left: 0 };
  return { scrollY, viewportHeight: 900, bandDocumentTop: 4500, bandRect: rect, bandStuck: bandTop === 0, workRect: rect, mainRect: { x: 265, y: 0, width: 1015, height: 900, top: 0, right: 1280, bottom: 900, left: 265 }, composerTop: 806, scrollWidth: 1280, clientWidth: 1280, overflowing: [], ...rest };
}

function checkpoint(overrides: Partial<SemanticCheckpoint> & Pick<SemanticCheckpoint, "kind" | "before" | "after">): SemanticCheckpoint {
  return {
    stepId: 12, name: "fixture checkpoint", surface: "editor", requiredMotion: false, startedAt: "2026-09-02T00:00:00.000Z", settledAt: "2026-09-02T00:00:01.000Z",
    marker: { transitionAt: "2026-09-02T00:00:00.000Z", settledAt: "2026-09-02T00:00:01.000Z" },
    scroll: { applicationScrollCalls: [], applicationScrollEvents: 0, maxExcursionPx: 0 },
    fakeCallCounts: { mainTutorReviews: 0, fakePtyCommands: 0 },
    ...overrides,
  };
}

describe("workbook UX scroll contract", () => {
  it("names each band placement by where the band sits, not by how wide it is", () => {
    expect(geometryStateFailure("inflow", geometry({ bandTop: 285, scrollY: 4215 }))).toBeUndefined();
    expect(geometryStateFailure("inflow", geometry({ bandTop: 340, scrollY: 4215 }))).toMatch(/measured band top 340/);
    expect(geometryStateFailure("docked", geometry({ bandTop: 0, scrollY: 4500 }))).toBeUndefined();
    expect(geometryStateFailure("docked", geometry({ bandTop: 0, scrollY: 4500, bandStuck: false }))).toMatch(/stuck/);
    expect(geometryStateFailure("docked", geometry({ bandTop: 0, scrollY: 4500, composerTop: 400 }))).toMatch(/fit above the composer/);
    expect(geometryStateFailure("away", geometry({ bandTop: 1020, scrollY: 3480 }))).toBeUndefined();
    expect(geometryStateFailure("away", geometry({ bandTop: 880, scrollY: 3620 }))).toMatch(/below the fold/);
  });

  it("fails a feedback checkpoint when the page moved while typing or while feedback landed", () => {
    const failures: string[] = [];
    assertCheckpointGeometry(checkpoint({ kind: "feedback", requestedState: "docked", before: geometry({ bandTop: 0, scrollY: 4500 }), after: geometry({ bandTop: 0, scrollY: 4500 }) }), failures);
    expect(failures).toEqual([]);

    assertCheckpointGeometry(checkpoint({ kind: "feedback", requestedState: "docked", before: geometry({ bandTop: 0, scrollY: 4500 }), after: geometry({ bandTop: 0, scrollY: 4500 + PAGE_HOLD_TOLERANCE_PX + 1 }) }), failures);
    expect(failures.at(-1)).toMatch(/moved 2\.0px while feedback arrived/);

    assertCheckpointGeometry(checkpoint({ kind: "feedback", requestedState: "docked", before: geometry({ bandTop: 0, scrollY: 4500 }), after: geometry({ bandTop: 0, scrollY: 4500 }), scroll: { applicationScrollCalls: [], applicationScrollEvents: 3, maxExcursionPx: 18, typingExcursionPx: 18 } }), failures);
    expect(failures.at(-1)).toMatch(/moved 18\.0px while the learner typed/);

    assertCheckpointGeometry(checkpoint({ kind: "feedback", requestedState: "docked", before: geometry({ bandTop: 0, scrollY: 4500 }), after: geometry({ bandTop: 0, scrollY: 4500 }), scroll: { applicationScrollCalls: [{ index: 1, atMs: 1, kind: "window.scrollTo", scrollX: 0, scrollY: 4500 }], applicationScrollEvents: 1, maxExcursionPx: 0 } }), failures);
    expect(failures.at(-1)).toMatch(/scrolled the page on its own \(window\.scrollTo\)/);
  });

  it("fails any checkpoint that overflows horizontally or leaves a Continue landing out of view", () => {
    const failures: string[] = [];
    assertCheckpointGeometry(checkpoint({ kind: "scroll", before: geometry({ bandTop: 285, scrollY: 0 }), after: geometry({ bandTop: 285, scrollY: 0, scrollWidth: 1300 }) }), failures);
    expect(failures.at(-1)).toMatch(/overflows horizontally/);

    assertContinueLandings([{ from: "a", to: "b", scrollYBefore: 0, scrollYAfter: 0, successorTop: 1190, composerTop: 806, inView: false }], failures);
    expect(failures.at(-1)).toMatch(/left b out of view/);
    assertContinueLandings([], failures);
    expect(failures.at(-1)).toMatch(/pressed no Continue/);
  });

  it("fails when the page moved between a scroll checkpoint settling and the next feedback checkpoint starting", () => {
    const failures: string[] = [];
    const settled = checkpoint({ kind: "scroll", name: "scroll", before: geometry({ bandTop: 285, scrollY: 4215 }), after: geometry({ bandTop: 0, scrollY: 4500 }) });
    assertPageHeldBetweenCheckpoints([settled, checkpoint({ kind: "feedback", name: "feedback", before: geometry({ bandTop: 0, scrollY: 4500 }), after: geometry({ bandTop: 0, scrollY: 4500 }) })], failures);
    expect(failures).toEqual([]);
    assertPageHeldBetweenCheckpoints([settled, checkpoint({ kind: "feedback", name: "feedback", before: geometry({ bandTop: 0, scrollY: 4756 }), after: geometry({ bandTop: 0, scrollY: 4756 }) })], failures);
    expect(failures.at(-1)).toMatch(/moved 256\.0px between "scroll" settling/);
  });
});
