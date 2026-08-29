import { describe, expect, it } from "vitest";
import { TerminalShellProtocol } from "../../src/workbook/terminal-shell-protocol.js";
import { ProtocolAwareFakePty } from "./fake-pty.js";
import { REQUIRED_MOTION_STEP_IDS, REQUIRED_STATE_CHECKPOINT_STEP_IDS, SCROLL_CHECKPOINT_STEP_IDS, WORKBOOK_UX_TEST_STEP_LIST } from "./steps.js";
import { encodeStepBits } from "./marker-protocol.js";
import { assertRealJourneyMotionThresholdCalibration, REAL_JOURNEY_MIN_REQUIRED_MOTION_PX, REQUIRED_SCROLL_SEMANTIC_DELTA_MIN_PX } from "./record.mjs";

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
