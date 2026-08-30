import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

/**
 * Ordinary read-only containment for Main Tutor workspace tools.
 *
 * Paths are checked lexically and then through the filesystem's canonical path.
 * This rejects absolute paths, traversal, and static symlinks that leave the live
 * workspace. It deliberately does not try to defend against a concurrent process
 * replacing a checked path between this check and the read.
 */
export class WorkspaceBoundary {
  readonly #root: string;

  private constructor(root: string) { this.#root = root; }

  static async create(workspace: string): Promise<WorkspaceBoundary> {
    const root = await realpath(workspace);
    const rootInfo = await stat(root);
    if (!rootInfo.isDirectory()) throw new Error("Workspace root must be a directory.");
    return new WorkspaceBoundary(root);
  }

  get root(): string { return this.#root; }

  async resolve(rawPath: string): Promise<{ absolute: string; relative: string }> {
    if (!rawPath || typeof rawPath !== "string") throw new Error("A workspace path is required.");
    if (rawPath.includes("\0")) throw new Error("Workspace path contains an invalid character.");
    if (isAbsolute(rawPath) || /^[a-z]:[\\/]/i.test(rawPath) || rawPath.startsWith("\\\\")) throw new Error("Absolute paths are not allowed; use a workspace-relative path.");

    const segments = rawPath.split(/[\\/]+/).filter((segment) => segment && segment !== ".");
    if (segments.includes("..")) throw new Error("Path is outside the tutorial workspace.");
    const candidate = segments.length === 0 ? this.#root : resolve(this.#root, ...segments);
    const lexicalRelative = relative(this.#root, candidate);
    if (lexicalRelative === ".." || lexicalRelative.startsWith(`..${sep}`) || isAbsolute(lexicalRelative)) throw new Error("Path is outside the tutorial workspace.");

    const canonicalCandidate = await realpath(candidate);
    if (!this.isInside(canonicalCandidate)) throw new Error("Path is outside the tutorial workspace.");
    const workspaceRelative = relative(this.#root, candidate);
    return { absolute: candidate, relative: workspaceRelative && workspaceRelative !== "." ? workspaceRelative.split(sep).join("/") : "." };
  }

  async readFile(path: string): Promise<Buffer> {
    const safePath = await this.resolve(path);
    const info = await stat(safePath.absolute);
    if (!info.isFile()) throw new Error("Path is not a regular file.");
    return readFile(safePath.absolute);
  }

  async stat(path: string) { return stat((await this.resolve(path)).absolute); }
  async readdir(path: string): Promise<string[]> { return readdir((await this.resolve(path)).absolute); }

  private isInside(path: string): boolean { return path === this.#root || path.startsWith(this.#root + sep); }
}
