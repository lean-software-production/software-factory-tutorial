import { mkdir, mkdtemp, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createTutorWorkspaceTools, TUTOR_READ_MAX_BYTES, TUTOR_LIST_MAX_ENTRIES } from "../src/workbook/tutor-workspace-tools.js";

const noExtensionContext = undefined as unknown as ExtensionContext;
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(stem: string): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), stem));
  roots.push(root);
  return root;
}

async function fixture(): Promise<{ workspace: string; outside: string; sibling: string; authored: string }> {
  const parent = await tempRoot("tutor-tools-parent-");
  const workspace = resolve(parent, "active-workspace");
  const sibling = resolve(parent, "sibling-workspace");
  const authored = resolve(parent, "authored-curriculum");
  const outside = await tempRoot("tutor-tools-outside-");
  await mkdir(resolve(workspace, "src"), { recursive: true });
  await mkdir(resolve(workspace, ".tutorial/tmp"), { recursive: true });
  await mkdir(sibling, { recursive: true });
  await mkdir(authored, { recursive: true });
  await writeFile(resolve(workspace, "README.md"), "hello workspace\n", "utf8");
  await writeFile(resolve(workspace, "src/index.ts"), "export const answer = 42;\n", "utf8");
  await writeFile(resolve(workspace, ".tutorial/tmp/state.json"), "{}\n", "utf8");
  await writeFile(resolve(sibling, "secret.txt"), "sibling secret\n", "utf8");
  await writeFile(resolve(authored, "lesson.md"), "authored private lesson\n", "utf8");
  await writeFile(resolve(outside, "secret.txt"), "outside secret\n", "utf8");
  return { workspace, outside, sibling, authored };
}

async function tool(name: "list_files" | "read_file", workspace: string) {
  const tools = await createTutorWorkspaceTools(workspace);
  expect(tools.map((candidate) => candidate.name)).toEqual(["list_files", "read_file"]);
  return tools.find((candidate) => candidate.name === name)!;
}

async function execute(candidate: Awaited<ReturnType<typeof tool>>, params: Record<string, unknown>) {
  return await candidate.execute("call", params, undefined, undefined, noExtensionContext) as { content: Array<{ type: "text"; text: string }>; details?: any };
}

describe("Main Tutor workspace tools", () => {
  it("lists files deterministically with bounded count and a truncation indicator", async () => {
    const { workspace } = await fixture();
    for (let index = 0; index < TUTOR_LIST_MAX_ENTRIES + 2; index += 1) {
      await writeFile(resolve(workspace, `file-${String(index).padStart(3, "0")}.txt`), `${index}\n`, "utf8");
    }

    const result = await execute(await tool("list_files", workspace), { path: ".", limit: 3, offset: 0 });

    expect(result.details).toMatchObject({ ok: true, path: '"."', offset: 0, limit: 3, truncated: true, nextOffset: 3 });
    expect(result.details.entries.map((entry: any) => entry.name)).toEqual(['"README.md"', '"file-000.txt"', '"file-001.txt"']);
    expect(result.content[0]!.text).toContain("[TRUNCATED: ");
    expect(result.content[0]!.text).not.toContain(workspace);

    const later = await execute(await tool("list_files", workspace), { path: ".", limit: 2, offset: 2 });
    expect(later.details.entries.map((entry: any) => entry.name)).toEqual(['"file-001.txt"', '"file-002.txt"']);
  });

  it("reads bounded byte ranges with offsets and deterministic truncation", async () => {
    const { workspace } = await fixture();
    await writeFile(resolve(workspace, "long.txt"), "0123456789abcdefghijklmnopqrstuvwxyz", "utf8");

    const result = await execute(await tool("read_file", workspace), { path: "long.txt", offset: 10, limit: 5 });

    expect(result.details).toMatchObject({ ok: true, path: '"long.txt"', offset: 10, bytesRead: 5, size: 36, truncated: true, nextOffset: 15 });
    expect(result.content[0]!.text).toContain("abcde");
    expect(result.content[0]!.text).toContain("[TRUNCATED: 21 bytes remain; call read_file with offset 15]");
    expect(result.content[0]!.text).not.toContain(workspace);
  });

  it("escapes control characters in learner-controlled path and file-name metadata", async () => {
    const { workspace } = await fixture();
    await writeFile(resolve(workspace, "line\nbreak.txt"), "newline name contents\n", "utf8");
    await writeFile(resolve(workspace, "ansi\u001b[31mred.txt"), "ansi name contents\n", "utf8");
    const list = await execute(await tool("list_files", workspace), { path: ".", limit: 20 });

    expect(list.content[0]!.text).toContain('"line\\nbreak.txt"');
    expect(list.content[0]!.text).toContain('"ansi\\u001b[31mred.txt"');
    expect(list.content[0]!.text).not.toContain("line\nbreak.txt");
    expect(list.content[0]!.text).not.toContain("\u001b[31m");
    expect(list.details.entries.map((entry: any) => entry.name)).toEqual(expect.arrayContaining(['"line\\nbreak.txt"', '"ansi\\u001b[31mred.txt"']));

    const read = await execute(await tool("read_file", workspace), { path: "line\nbreak.txt", limit: 5 });
    const readHeader = read.content[0]!.text.split("\n")[0]!;
    expect(readHeader).toContain('"line\\nbreak.txt"');
    expect(readHeader).not.toContain("line\nbreak.txt");
    expect(read.details.path).toBe('"line\\nbreak.txt"');
  });

  it("rejects oversized files before reading them", async () => {
    const { workspace } = await fixture();
    await writeFile(resolve(workspace, "huge.log"), "", "utf8");
    await truncate(resolve(workspace, "huge.log"), TUTOR_READ_MAX_BYTES * 40);

    const result = await execute(await tool("read_file", workspace), { path: "huge.log", offset: 0, limit: 100 });

    expect(result.details).toMatchObject({ ok: false, path: '"huge.log"', size: TUTOR_READ_MAX_BYTES * 40 });
    expect(result.content[0]!.text).toContain("File is too large to read safely");
    expect(result.content[0]!.text).not.toContain(workspace);
  });

  it("returns safe validation errors for bad parameters without leaking outside paths", async () => {
    const { workspace, outside } = await fixture();
    const read = await tool("read_file", workspace);
    const list = await tool("list_files", workspace);

    for (const params of [
      { path: "../secret.txt" },
      { path: resolve(outside, "secret.txt") },
      { path: "C:\\outside\\secret.txt" },
      { path: "\\\\server\\share\\secret.txt" },
      { path: "src/index.ts", offset: -1 },
      { path: "src/index.ts", limit: TUTOR_READ_MAX_BYTES + 1 },
    ]) {
      const result = await execute(read, params);
      expect(result.details.ok).toBe(false);
      expect(result.content[0]!.text).toMatch(/rejected|invalid|outside/i);
      expect(result.content[0]!.text).not.toContain(outside);
      expect(result.content[0]!.text).not.toContain(workspace);
    }

    const listResult = await execute(list, { path: "/tmp", limit: 1 });
    expect(listResult.details.ok).toBe(false);
    expect(listResult.content[0]!.text).not.toContain("/tmp");
  });

  it("rejects traversal to sibling workspaces, session state, authored curriculum, and escaping symlinks", async () => {
    const { workspace, outside, sibling, authored } = await fixture();
    await symlink(outside, resolve(workspace, "escape-outside"));
    await symlink(resolve(outside, "secret.txt"), resolve(workspace, "escape-secret.txt"));
    const read = await tool("read_file", workspace);

    for (const unsafe of [
      "../sibling-workspace/secret.txt",
      "../authored-curriculum/lesson.md",
      "../active-workspace/.tutorial/tmp/state.json",
      ".Git/config",
      ".Tutorial/tmp/state.json",
      "escape-outside/secret.txt",
      "escape-secret.txt",
    ]) {
      const result = await execute(read, { path: unsafe });
      expect(result.details.ok).toBe(false);
      expect(result.content[0]!.text).toMatch(/outside|reserved|rejected/i);
      expect(result.content[0]!.text).not.toContain("secret");
      expect(result.content[0]!.text).not.toContain(sibling);
      expect(result.content[0]!.text).not.toContain(authored);
      expect(result.content[0]!.text).not.toContain(outside);
    }
  });

});
