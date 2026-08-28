import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_TERMINAL_COMMAND_BYTES,
  TerminalEvidenceRepository,
} from "../src/workbook/terminal-evidence.js";

let directories: string[] = [];

async function stateRoot(): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), "terminal-evidence-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
  directories = [];
});

describe("TerminalEvidenceRepository", () => {
  it("writes one immutable finished snapshot outside the timeline", async () => {
    const repository = new TerminalEvidenceRepository({ stateRoot: await stateRoot() });
    const finishedRef = await repository.writeFinished({
      command: "npm test",
      interactions: [{ kind: "input", data: "npm test\r" }, { kind: "output", data: "PASS\n" }],
      exitStatus: 0,
    });

    expect(finishedRef).toMatch(/^[0-9a-f-]{36}$/i);
    await expect(repository.read(finishedRef)).resolves.toEqual({
      kind: "finished",
      command: "npm test",
      interactions: [{ kind: "input", data: "npm test\r" }, { kind: "output", data: "PASS\n" }],
      exitStatus: 0,
    });
  });

  it("refuses a reference collision instead of overwriting the original snapshot", async () => {
    const evidenceRef = "00000000-0000-4000-8000-000000000001";
    const repository = new TerminalEvidenceRepository({ stateRoot: await stateRoot(), createEvidenceRef: () => evidenceRef });
    await repository.writeFinished({ command: "first", interactions: [], exitStatus: 0 });

    await expect(repository.writeFinished({ command: "second", interactions: [], exitStatus: 0 })).rejects.toMatchObject({ code: "EEXIST" });
    await expect(repository.read(evidenceRef)).resolves.toEqual({ kind: "finished", command: "first", interactions: [], exitStatus: 0 });
  });

  it("validates bounded snapshots when writing and when reading persisted JSON", async () => {
    const root = await stateRoot();
    const repository = new TerminalEvidenceRepository({ stateRoot: root });
    await expect(repository.writeFinished({ command: "x".repeat(MAX_TERMINAL_COMMAND_BYTES + 1), interactions: [], exitStatus: 0 }))
      .rejects.toThrow("Terminal evidence command is invalid.");

    const evidenceRef = "00000000-0000-4000-8000-000000000002";
    const directory = resolve(root, "workbook", "terminal-evidence");
    const path = resolve(directory, `${evidenceRef}.json`);
    await mkdir(directory, { recursive: true });
    await writeFile(path, "{\"kind\":\"finished\",\"command\":\"npm test\",\"interactions\":[{\"kind\":\"output\",\"data\":42}],\"exitStatus\":0}\n", "utf8");

    await expect(repository.read(evidenceRef)).rejects.toThrow("Terminal evidence");
  });
});
