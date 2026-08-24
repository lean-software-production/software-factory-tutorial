import { execFile } from "node:child_process";
import { randomBytes as defaultRandomBytes } from "node:crypto";
import { copyFile, lstat, mkdir, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export const SESSION_STATE_DIRECTORY = ".tutorial";
export const SESSION_WORKSPACE_DIRECTORY = "workspace";
export const MATERIALIZED_WORKSPACE_DIRECTORIES = ["calculator", "factory"] as const;
export const SAFE_SESSION_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

const SESSION_ID_MAX_LENGTH = 64;
const SESSION_GITIGNORE = "factory/**/.tmp/\n";

export class SessionWorkspaceError extends Error {}

export interface TutorialSessionPaths {
  contentRoot: string;
  sessionId: string;
  sessionRoot: string;
  workspaceRoot: string;
}

export interface CreateTutorialSessionOptions {
  id?: string;
  now?: Date;
  randomBytes?: (size: number) => Buffer;
}

function pad(value: number): string { return String(value).padStart(2, "0"); }

function timestamp(now: Date): string {
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

export function createSessionId(options: CreateTutorialSessionOptions = {}): string {
  const now = options.now ?? new Date();
  const randomBytes = options.randomBytes ?? defaultRandomBytes;
  const id = `session-${timestamp(now)}-${randomBytes(4).toString("hex")}`;
  return validateSessionId(id);
}

export function validateSessionId(id: string): string {
  if (!id) throw new SessionWorkspaceError("A session ID is required.");
  if (id.length > SESSION_ID_MAX_LENGTH || !SAFE_SESSION_ID.test(id)) {
    throw new SessionWorkspaceError("Session IDs may contain only lowercase letters, digits, and hyphens, and must not be paths.");
  }
  return id;
}

function inside(root: string, candidate: string): boolean {
  const candidateRelative = relative(root, candidate);
  return candidateRelative === "" || (candidateRelative !== ".." && !candidateRelative.startsWith(`..${sep}`) && !isAbsolute(candidateRelative));
}

async function requireDirectory(path: string, label: string): Promise<void> {
  let info;
  try { info = await stat(path); }
  catch {
    throw new SessionWorkspaceError(`${label} does not exist: ${path}`);
  }
  if (!info.isDirectory()) throw new SessionWorkspaceError(`${label} must be a directory: ${path}`);
}

async function requireDirectoryInside(path: string, label: string, root: string): Promise<void> {
  await requireDirectory(path, label);
  const realDirectory = await realpath(path);
  if (!inside(root, realDirectory)) throw new SessionWorkspaceError(`${label} must stay inside ${basename(root)}.`);
}

async function ensureSessionStateDirectory(contentRoot: string): Promise<string> {
  const stateRoot = resolve(contentRoot, SESSION_STATE_DIRECTORY);
  try {
    const info = await lstat(stateRoot);
    if (info.isSymbolicLink()) throw new SessionWorkspaceError(`Tutorial state directory must be a real directory, not a symlink: ${stateRoot}`);
    if (!info.isDirectory()) throw new SessionWorkspaceError(`Tutorial state directory must be a directory: ${stateRoot}`);
  } catch (error) {
    if (error instanceof SessionWorkspaceError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
    await mkdir(stateRoot);
  }

  const realStateRoot = await realpath(stateRoot);
  if (!inside(contentRoot, realStateRoot)) throw new SessionWorkspaceError("Tutorial state directory must stay inside the content root.");
  return stateRoot;
}

async function copyAuthoredDirectory(source: string, destination: string, contentRoot: string): Promise<void> {
  const realSource = await realpath(source);
  if (!inside(contentRoot, realSource)) throw new SessionWorkspaceError(`Refusing to materialize a path outside the content root: ${source}`);
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const from = resolve(source, entry.name);
    const to = resolve(destination, entry.name);
    if (entry.isSymbolicLink()) throw new SessionWorkspaceError(`Refusing to materialize symlinked content: ${from}`);
    if (entry.isDirectory()) {
      await copyAuthoredDirectory(from, to, contentRoot);
      continue;
    }
    if (entry.isFile()) {
      await copyFile(from, to);
      continue;
    }
    throw new SessionWorkspaceError(`Refusing to materialize unsupported file type: ${from}`);
  }
}

async function pathExists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch { return false; }
}

async function git(workspaceRoot: string, ...args: string[]): Promise<string> {
  const result = await run("git", ["-C", workspaceRoot, ...args]);
  return result.stdout;
}

async function initializeLocalRepository(workspaceRoot: string): Promise<void> {
  await writeFile(resolve(workspaceRoot, ".gitignore"), SESSION_GITIGNORE, "utf8");
  await git(workspaceRoot, "init", "-q", "-b", "main");
  await git(workspaceRoot, "config", "user.email", "learner@example.invalid");
  await git(workspaceRoot, "config", "user.name", "Tutorial Learner");
  await git(workspaceRoot, "add", ".gitignore", ...MATERIALIZED_WORKSPACE_DIRECTORIES);
  const status = await git(workspaceRoot, "status", "--porcelain");
  if (status.trim()) await git(workspaceRoot, "commit", "-qm", "Materialize tutorial workspace");
}

export class SessionWorkspaceManager {
  readonly contentRoot: string;

  private constructor(contentRoot: string) { this.contentRoot = contentRoot; }

  static async create(contentRoot: string): Promise<SessionWorkspaceManager> {
    if (!contentRoot) throw new SessionWorkspaceError("A content root is required.");
    await requireDirectory(contentRoot, "Content root");
    const canonicalContentRoot = await realpath(contentRoot);
    for (const directory of MATERIALIZED_WORKSPACE_DIRECTORIES) {
      const source = resolve(canonicalContentRoot, directory);
      await requireDirectory(source, `${directory}/ content`);
      const realSource = await realpath(source);
      if (!inside(canonicalContentRoot, realSource)) throw new SessionWorkspaceError(`${directory}/ must stay inside the content root.`);
    }
    return new SessionWorkspaceManager(canonicalContentRoot);
  }

  pathsFor(sessionId: string): TutorialSessionPaths {
    const safeId = validateSessionId(sessionId);
    const sessionRoot = resolve(this.contentRoot, SESSION_STATE_DIRECTORY, safeId);
    const stateRoot = resolve(this.contentRoot, SESSION_STATE_DIRECTORY);
    if (!inside(stateRoot, sessionRoot)) throw new SessionWorkspaceError("Session root must stay inside the tutorial state directory.");
    return {
      contentRoot: this.contentRoot,
      sessionId: safeId,
      sessionRoot,
      workspaceRoot: resolve(sessionRoot, SESSION_WORKSPACE_DIRECTORY),
    };
  }

  async createSession(options: CreateTutorialSessionOptions = {}): Promise<TutorialSessionPaths> {
    const sessionId = options.id === undefined ? createSessionId(options) : validateSessionId(options.id);
    const paths = this.pathsFor(sessionId);
    await ensureSessionStateDirectory(this.contentRoot);
    if (await pathExists(paths.sessionRoot)) throw new SessionWorkspaceError(`Session '${sessionId}' already exists.`);

    await mkdir(paths.workspaceRoot, { recursive: true });
    try {
      for (const directory of MATERIALIZED_WORKSPACE_DIRECTORIES) {
        await copyAuthoredDirectory(resolve(this.contentRoot, directory), resolve(paths.workspaceRoot, directory), this.contentRoot);
      }
      await initializeLocalRepository(paths.workspaceRoot);
    } catch (error) {
      await rm(paths.sessionRoot, { recursive: true, force: true });
      throw error;
    }
    return paths;
  }

  async reopenSession(sessionId: string): Promise<TutorialSessionPaths> {
    const paths = this.pathsFor(sessionId);
    const stateRoot = resolve(this.contentRoot, SESSION_STATE_DIRECTORY);
    await requireDirectoryInside(paths.sessionRoot, `Session '${paths.sessionId}'`, stateRoot);
    await requireDirectoryInside(paths.workspaceRoot, `Session '${paths.sessionId}' workspace`, paths.sessionRoot);
    return paths;
  }
}

export async function createTutorialSession(contentRoot: string, options: CreateTutorialSessionOptions = {}): Promise<TutorialSessionPaths> {
  return (await SessionWorkspaceManager.create(contentRoot)).createSession(options);
}

export async function reopenTutorialSession(contentRoot: string, sessionId: string): Promise<TutorialSessionPaths> {
  return (await SessionWorkspaceManager.create(contentRoot)).reopenSession(sessionId);
}
