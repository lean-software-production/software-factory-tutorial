import { describe, expect, it } from "vitest";
import { TerminalLineInputTracker } from "../src/workbook/terminal-line-input-tracker.js";

function consumeAll(tracker: TerminalLineInputTracker, chunks: string[]) {
  return chunks.map((chunk) => tracker.consume(chunk));
}

describe("TerminalLineInputTracker", () => {
  it("counts the first meaningful printable input on a line and cancels backspace-to-empty", () => {
    const tracker = new TerminalLineInputTracker();

    expect(tracker.consume("a")).toEqual({ started: 1, cancelled: 0 });
    expect(tracker.consume("bc")).toEqual({ started: 0, cancelled: 0 });
    expect(tracker.consume("\b\b")).toEqual({ started: 0, cancelled: 0 });
    expect(tracker.consume("\b")).toEqual({ started: 0, cancelled: 1 });
    expect(tracker.consume("d")).toEqual({ started: 1, cancelled: 0 });
  });

  it("cancels the current unsubmitted physical line with Ctrl-U and Ctrl-C", () => {
    const tracker = new TerminalLineInputTracker();

    expect(tracker.consume("echo nope\u0015")).toEqual({ started: 1, cancelled: 1 });
    expect(tracker.consume("   ")).toEqual({ started: 0, cancelled: 0 });
    expect(tracker.consume("echo also-nope\u0003")).toEqual({ started: 1, cancelled: 1 });
  });

  it("ignores fragmented navigation and CSI escape sequences", () => {
    const tracker = new TerminalLineInputTracker();

    expect(consumeAll(tracker, ["\x1b[", "A", "\x1b", "[3", "~"])).toEqual([
      { started: 0, cancelled: 0 },
      { started: 0, cancelled: 0 },
      { started: 0, cancelled: 0 },
      { started: 0, cancelled: 0 },
      { started: 0, cancelled: 0 },
    ]);
    expect(tracker.consume("x")).toEqual({ started: 1, cancelled: 0 });
  });

  it("counts each meaningful physical line in a multiline shell continuation", () => {
    const tracker = new TerminalLineInputTracker();

    expect(tracker.consume("echo one \\\r")).toEqual({ started: 1, cancelled: 0 });
    expect(tracker.consume("  && echo two\r")).toEqual({ started: 1, cancelled: 0 });
  });

  it("preserves meaningful pasted text while ignoring bracketed-paste controls", () => {
    const tracker = new TerminalLineInputTracker();

    expect(tracker.consume("\x1b[200~cat <<'EOF'\nhello\nEOF\n\x1b[201~")).toEqual({ started: 3, cancelled: 0 });
  });
});
