import { access, lstat, mkdir, readFile, readdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  defineTool,
  type ToolDefinition
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AuditEvent } from "../protocol/events.js";

export type AuditSink = (event: AuditEvent) => void;

export interface WorkspaceToolBoundary {
  readonly root: string;
  resolve(rawPath: string, forWrite?: boolean): Promise<{ absolute: string; relative: string }>;
  readFile(path: string): Promise<Buffer>;
  access(path: string): Promise<void>;
  writeFile(path: string, content: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  move(path: string, destination: string): Promise<{ from: string; to: string }>;
  isDirectory(path: string): Promise<boolean>;
  stat(path: string): Promise<Awaited<ReturnType<typeof stat>>>;
  readdir(path: string): Promise<string[]>;
  exists(path: string): Promise<boolean>;
}

/**
 * Resolves every path through the real workspace root. This is deliberately a
 * filesystem boundary, not a prompt convention: absolute paths, `..`, and
 * symlinks which leave the workspace are rejected before a tool touches them.
 */
export class WorkspaceBoundary {
  readonly #root: string;

  private constructor(root: string) { this.#root = root; }

  static async create(workspace: string): Promise<WorkspaceBoundary> {
    return new WorkspaceBoundary(await realpath(workspace));
  }

  get root(): string { return this.#root; }

  async resolve(rawPath: string, forWrite = false): Promise<{ absolute: string; relative: string }> {
    if (!rawPath || typeof rawPath !== "string") throw new Error("A workspace path is required.");
    const candidate = isAbsolute(rawPath) ? resolve(rawPath) : resolve(this.#root, rawPath);
    // Reject lexical escapes before probing the filesystem. Otherwise a missing
    // external path can leak an ENOENT rather than the boundary decision.
    const lexicalRelative = relative(this.#root, candidate);
    if (lexicalRelative === ".." || lexicalRelative.startsWith(`..${sep}`) || isAbsolute(lexicalRelative)) throw new Error("Path is outside the tutorial workspace.");
    const existing = await this.nearestExisting(candidate, forWrite);
    const realExisting = await realpath(existing);
    if (!this.isInside(realExisting)) throw new Error("Path is outside the tutorial workspace.");
    // A path can contain a symlink below the nearest ancestor. Resolve it when it
    // exists; for a new write its existing parent is already checked above.
    try {
      const realCandidate = await realpath(candidate);
      if (!this.isInside(realCandidate)) throw new Error("Path is outside the tutorial workspace.");
    } catch (error) {
      if (!(error instanceof Error) || !/ENOENT|no such file/i.test(error.message)) throw error;
    }
    const workspaceRelative = relative(this.#root, candidate);
    if (!workspaceRelative || workspaceRelative === ".") return { absolute: candidate, relative: "." };
    if (workspaceRelative === ".." || workspaceRelative.startsWith(`..${sep}`) || isAbsolute(workspaceRelative)) throw new Error("Path is outside the tutorial workspace.");
    return { absolute: candidate, relative: workspaceRelative.split(sep).join("/") };
  }

  async readFile(path: string): Promise<Buffer> { return readFile((await this.resolve(path)).absolute); }
  async access(path: string): Promise<void> { await access((await this.resolve(path)).absolute); }
  async writeFile(path: string, content: string): Promise<void> {
    const safePath = await this.resolve(path, true);
    await mkdir(dirname(safePath.absolute), { recursive: true });
    await writeFile(safePath.absolute, content, "utf8");
  }
  async mkdir(path: string): Promise<void> { await mkdir((await this.resolve(path, true)).absolute, { recursive: true }); }
  /**
   * Relocate one file. Deliberately narrower than a delete: both ends are
   * resolved through the boundary, and an occupied destination is refused, so a
   * move can rearrange the workspace but never destroy anything in it.
   */
  async move(path: string, destination: string): Promise<{ from: string; to: string }> {
    const source = await this.resolve(path);
    const target = await this.resolve(destination, true);
    if (source.absolute === target.absolute) throw new Error("The source and destination are the same path.");
    if (await this.exists(target.absolute)) throw new Error(`'${target.relative}' already exists; a move never overwrites.`);
    await mkdir(dirname(target.absolute), { recursive: true });
    await rename(source.absolute, target.absolute);
    return { from: source.relative, to: target.relative };
  }
  async isDirectory(path: string): Promise<boolean> { return (await stat((await this.resolve(path)).absolute)).isDirectory(); }
  async stat(path: string) { return stat((await this.resolve(path)).absolute); }
  async readdir(path: string): Promise<string[]> { return readdir((await this.resolve(path)).absolute); }
  async exists(path: string): Promise<boolean> {
    try { await lstat((await this.resolve(path)).absolute); return true; }
    catch { return false; }
  }

  private isInside(path: string): boolean { return path === this.#root || path.startsWith(this.#root + sep); }

  private async nearestExisting(candidate: string, forWrite: boolean): Promise<string> {
    let current = candidate;
    for (;;) {
      try { await lstat(current); return current; }
      catch (error) {
        if (!forWrite && current === candidate) throw error;
        const parent = dirname(current);
        if (parent === current) throw new Error("Path is outside the tutorial workspace.");
        current = parent;
      }
    }
  }
}

function pathArguments(name: string, params: Record<string, unknown>): string[] {
  // A move is audited at both ends: relocating a file out of the workspace is
  // exactly as much of a boundary crossing as writing outside it.
  if (name === "move") return [params.path, params.destination].filter((path): path is string => typeof path === "string");
  if (name === "edit" || name === "read" || name === "write") return typeof params.path === "string" ? [params.path] : [];
  return typeof params.path === "string" ? [params.path] : ["."];
}

function audited(definition: ToolDefinition<any, any, any>, boundary: WorkspaceToolBoundary, sink: AuditSink, mutation: boolean): ToolDefinition<any, any, any> {
  const execute = definition.execute;
  return {
    ...definition,
    async execute(id, params, signal, onUpdate, context) {
      const rawPaths = pathArguments(definition.name, params as Record<string, unknown>);
      let paths: string[] = [];
      try {
        paths = await Promise.all(rawPaths.map(async (path) => (await boundary.resolve(path, mutation)).relative));
      } catch (error) {
        sink({ type: "audit", id, tool: definition.name, paths: rawPaths.map((path) => path.replaceAll("\\", "/")), mutation, outcome: "rejected", message: error instanceof Error ? error.message : "Workspace path rejected." });
        throw error;
      }
      try {
        const result = await execute(id, params, signal, onUpdate, context);
        sink({ type: "audit", id, tool: definition.name, paths, mutation, outcome: "ok" });
        return result;
      } catch (error) {
        sink({ type: "audit", id, tool: definition.name, paths, mutation, outcome: "error", message: error instanceof Error ? error.message : "Tool failed." });
        throw error;
      }
    }
  };
}

/** Built-in file tools with their names retained, so they replace Pi's defaults. */
export function createWorkspaceTools(workspace: string, boundary: WorkspaceToolBoundary, sink: AuditSink): ToolDefinition<any, any, any>[] {
  // Pi resolves relative tool paths before invoking our operations. Its cwd
  // must therefore have the same spelling as the boundary root: on macOS,
  // /var and /private/var name the same directory but only the latter is the
  // realpath stored by WorkspaceBoundary.
  const canonicalWorkspace = boundary.root;
  const read = createReadToolDefinition(canonicalWorkspace, { operations: { readFile: (path) => boundary.readFile(path), access: (path) => boundary.access(path) } });
  const write = createWriteToolDefinition(canonicalWorkspace, { operations: { writeFile: (path, content) => boundary.writeFile(path, content), mkdir: (path) => boundary.mkdir(path) } });
  const edit = createEditToolDefinition(canonicalWorkspace, { operations: { readFile: (path) => boundary.readFile(path), writeFile: (path, content) => boundary.writeFile(path, content), access: (path) => boundary.access(path) } });
  const grep = createGrepToolDefinition(canonicalWorkspace, { operations: { isDirectory: (path) => boundary.isDirectory(path), readFile: async (path) => (await boundary.readFile(path)).toString("utf8") } });
  // fd does not follow directory symlinks by default. The audited wrapper
  // validates the requested search root before its process is started.
  const find = createFindToolDefinition(canonicalWorkspace);
  const ls = createLsToolDefinition(canonicalWorkspace, { operations: { exists: (path) => boundary.exists(path), stat: (path) => boundary.stat(path), readdir: (path) => boundary.readdir(path) } });
  // Pi has no move tool of its own, and lesson 005's first act is a move. Read,
  // write and edit together can copy a file but cannot retire the original, so
  // without this a delegating tutor could only ever leave two of everything.
  const move = defineTool({
    name: "move",
    label: "Move file",
    description: "Move or rename one file inside the tutorial workspace. Both paths are workspace-relative. Missing parent directories are created. It refuses a destination that already exists, and it cannot delete a file.",
    parameters: Type.Object({
      path: Type.String({ minLength: 1, maxLength: 400, description: "The file to move, relative to the workspace root." }),
      destination: Type.String({ minLength: 1, maxLength: 400, description: "Where it should end up, relative to the workspace root." })
    }),
    async execute(_id, params) {
      const moved = await boundary.move(params.path, params.destination);
      return { content: [{ type: "text", text: `Moved ${moved.from} to ${moved.to}` }], details: moved };
    }
  });
  return [
    audited(read, boundary, sink, false), audited(edit, boundary, sink, true), audited(write, boundary, sink, true),
    audited(move, boundary, sink, true),
    audited(grep, boundary, sink, false), audited(find, boundary, sink, false), audited(ls, boundary, sink, false)
  ];
}
