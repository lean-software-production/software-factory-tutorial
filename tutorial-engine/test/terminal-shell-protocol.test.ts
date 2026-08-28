import { describe, expect, it } from "vitest";
import { TerminalShellProtocol } from "../src/workbook/terminal-shell-protocol.js";

const commandMarker = (command: string) => `\x1b]633;workbook-command;${Buffer.from(command).toString("base64")}\x07`;
const finishedMarker = (exitStatus: number) => `\x1b]633;workbook-finished;${exitStatus}\x07`;

describe("TerminalShellProtocol", () => {
  it("removes authoritative Bash markers from terminal output and emits their facts", () => {
    const protocol = new TerminalShellProtocol();

    expect(protocol.consume(`$ echo hello\r\n${commandMarker("echo hello")}hello\r\n${finishedMarker(0)}$ `)).toEqual([
      { type: "output", data: "$ echo hello\r\n" },
      { type: "command-submitted", command: "echo hello" },
      { type: "output", data: "hello\r\n" },
      { type: "command-finished", exitStatus: 0 },
      { type: "output", data: "$ " }
    ]);
  });

  it("waits for a split marker before emitting its fact or later output", () => {
    const protocol = new TerminalShellProtocol();
    const marker = commandMarker("printf '%s\\n' exact");

    expect(protocol.consume(`before${marker.slice(0, 12)}`)).toEqual([{ type: "output", data: "before" }]);
    expect(protocol.consume(`${marker.slice(12)}after`)).toEqual([
      { type: "command-submitted", command: "printf '%s\\n' exact" },
      { type: "output", data: "after" }
    ]);
  });

  it("leaves invalid or unrelated control sequences in normal terminal output", () => {
    const protocol = new TerminalShellProtocol();
    const malformed = "\x1b]633;workbook-command;not-base64!\x07";
    const unrelated = "\x1b]0;window title\x07";

    expect(protocol.consume(`${malformed}${unrelated}`)).toEqual([{ type: "output", data: `${malformed}${unrelated}` }]);
  });

  it("accepts only non-negative integer exit statuses", () => {
    const protocol = new TerminalShellProtocol();
    const malformed = "\x1b]633;workbook-finished;-1\x07";

    expect(protocol.consume(`${malformed}${finishedMarker(130)}`)).toEqual([
      { type: "output", data: malformed },
      { type: "command-finished", exitStatus: 130 }
    ]);
  });
});
