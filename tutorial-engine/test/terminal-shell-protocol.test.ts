import { spawn } from "node:child_process";
import { open, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TerminalShellProtocol, type TerminalShellProtocolEvent } from "../src/workbook/terminal-shell-protocol.js";

const commandMarker = (command: string) => `\x1b]633;workbook-command;${Buffer.from(command).toString("base64")}\x07`;
const finishedMarker = (exitStatus: number) => `\x1b]633;workbook-finished;${exitStatus}\x07`;

async function controlledBashOutput(commands: string): Promise<Buffer> {
  const directory = await mkdtemp(join(tmpdir(), "workbook-shell-protocol-"));
  const rcfile = join(directory, "bashrc");
  const outputPath = join(directory, "output");
  const output = await open(outputPath, "w");
  // Docker supplies GNU base64 (-w); this shim gives the local BSD utility the
  // same no-wrap behaviour while preserving the command-marker trap under test.
  await writeFile(rcfile, "base64() { command base64 | tr -d '\\n'; }\n");
  try {
    await new Promise<void>((resolve, reject) => {
      const shell = spawn("bash", ["--noprofile", "--rcfile", rcfile, "-i"], {
        env: {
          ...process.env,
          HISTFILE: join(directory, "history"),
          PS1: "$ ",
          PROMPT_COMMAND: "status=$?; printf '\\033]633;workbook-finished;%s\\007' \"$status\"; trap 'command=$BASH_COMMAND; trap - DEBUG; printf \"\\033]633;workbook-command;\"; printf '%s' \"$command\" | base64 -w 0; printf \"\\007\"' DEBUG"
        },
        stdio: ["pipe", output.fd, output.fd]
      });
      shell.once("error", reject);
      shell.once("close", (code) => code === 0 ? resolve() : reject(new Error(`Controlled Bash exited with ${code}.`)));
      shell.stdin!.end(commands);
    });
    return await readFile(outputPath);
  } finally {
    await output.close();
    await rm(directory, { recursive: true, force: true });
  }
}

function parseEmittedBytes(bytes: Buffer): TerminalShellProtocolEvent[] {
  const protocol = new TerminalShellProtocol();
  const events: TerminalShellProtocolEvent[] = [];
  for (let offset = 0; offset < bytes.length; offset += 11) {
    events.push(...protocol.consume(bytes.subarray(offset, offset + 11).toString("utf8")));
  }
  return events;
}

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

  it("decodes lifecycle facts from the equivalent controlled Bash setup without exposing private OSC output", async () => {
    const quotedCommand = `printf '%s\\n' "two words"`;
    const events = parseEmittedBytes(await controlledBashOutput(`${quotedCommand}\nfalse\nexit 0\n`));

    expect(events.filter((event) => event.type === "command-submitted")).toEqual([
      { type: "command-submitted", command: quotedCommand },
      { type: "command-submitted", command: "false" },
      { type: "command-submitted", command: "exit 0" }
    ]);
    // The first status belongs to the initial prompt; the next two are the
    // completed quoted command and false, respectively.
    expect(events.filter((event) => event.type === "command-finished")).toEqual([
      { type: "command-finished", exitStatus: 0 },
      { type: "command-finished", exitStatus: 0 },
      { type: "command-finished", exitStatus: 1 }
    ]);

    const normalOutput = events.filter((event) => event.type === "output").map((event) => event.data).join("");
    expect(normalOutput).toContain("two words");
    expect(normalOutput).not.toContain("\x1b]633;workbook-");
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
