import { describe, expect, it } from "vitest";
import { TerminalShellProtocol } from "../../src/workbook/terminal-shell-protocol.js";
import { ProtocolAwareFakePty } from "./fake-pty.js";
import { REQUIRED_STATE_CHECKPOINT_STEP_IDS, WORKBOOK_FACTORY_STEP_LIST } from "./steps.js";
import { encodeStepBits } from "./marker-protocol.js";

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

describe("workbook factory marker declarations", () => {
  it("use unique marker ids and keep the six learner state checkpoints decodable", () => {
    const ids = WORKBOOK_FACTORY_STEP_LIST.map((step) => step.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(REQUIRED_STATE_CHECKPOINT_STEP_IDS).toHaveLength(6);
    for (const id of REQUIRED_STATE_CHECKPOINT_STEP_IDS) expect(encodeStepBits(id)).toHaveLength(8);
  });
});
