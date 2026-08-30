import { execFile } from "node:child_process";
import { randomBytes as defaultRandomBytes } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { devNull } from "node:os";
import { promisify } from "node:util";
import { LESSON_WORKSPACE_PATTERN } from "./workbook/contract.js";
import { loadWorkbook } from "./workbook/load.js";
import { NO_RUNTIME_PROVISION, trustRuntimeProvision, type RuntimeProvisionInput, type SafeWorkspaceRelativePath, type TrustedRuntimeProvision } from "./workbook/runtime-provision.js";

const run = promisify(execFile);

export const SESSION_STATE_DIRECTORY = ".tutorial";
export const SESSION_WORKSPACES_DIRECTORY = "workspaces";
export const AUTHORED_WORKSPACES_DIRECTORY = "workspaces";
export const SAFE_SESSION_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
export const LESSON_WORKSPACE_GITIGNORE_LINES = ["factory/**/.tmp/"] as const;

const SESSION_ID_MAX_LENGTH = 64;
const SKIPPED_AUTHORED_ENTRIES = new Set(["node_modules", ".tmp", ".tutorial", ".git", ".DS_Store"]);
const WORKER_REPOSITORY_GIT_CONFIG = [
  ["user.name", "Tutorial Factory Worker"],
  ["user.email", "factory-worker@example.invalid"],
  ["user.useConfigOnly", "true"],
  ["commit.gpgSign", "false"],
  ["tag.gpgSign", "false"],
  ["credential.helper", ""],
  ["credential.interactive", "false"],
  ["core.hooksPath", "/dev/null"],
  ["protocol.allow", "never"],
] as const;

export class SessionWorkspaceError extends Error {}

export interface TutorialSessionPaths {
  contentRoot: string;
  sessionId: string;
  sessionRoot: string;
  workspacesRoot: string;
  workspaceRoots: Record<string, string>;
  runtimeProvision?: TrustedRuntimeProvision;
}

export interface CreateTutorialSessionOptions {
  id?: string;
  now?: Date;
  randomBytes?: (size: number) => Buffer;
  runtimeProvision?: RuntimeProvisionInput;
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

export function validateLessonWorkspaceId(id: string, location = "workspace"): string {
  if (typeof id !== "string" || !LESSON_WORKSPACE_PATTERN.test(id)) {
    throw new SessionWorkspaceError(`${location}: workspace must be a lowercase-hyphenated workspace id`);
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

async function pathExists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch { return false; }
}

async function copyAuthoredDirectory(source: string, destination: string, contentRoot: string): Promise<void> {
  const sourceInfo = await lstat(source);
  if (sourceInfo.isSymbolicLink()) throw new SessionWorkspaceError(`Refusing to materialize symlinked content: ${source}`);
  if (!sourceInfo.isDirectory()) throw new SessionWorkspaceError(`Authored workspace content must be a directory: ${source}`);
  const realSource = await realpath(source);
  if (!inside(contentRoot, realSource)) throw new SessionWorkspaceError(`Refusing to materialize a path outside the content root: ${source}`);
  await mkdir(destination, { recursive: true });
  await chmod(destination, sourceInfo.mode);
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (SKIPPED_AUTHORED_ENTRIES.has(entry.name)) continue;
    const from = resolve(source, entry.name);
    const to = resolve(destination, entry.name);
    if (entry.isSymbolicLink()) throw new SessionWorkspaceError(`Refusing to materialize symlinked content: ${from}`);
    if (entry.isDirectory()) {
      await copyAuthoredDirectory(from, to, contentRoot);
      continue;
    }
    if (entry.isFile()) {
      const sourceFileInfo = await stat(from);
      if (sourceFileInfo.nlink !== 1) throw new SessionWorkspaceError(`Refusing to materialize hardlinked content: ${from}`);
      await copyFile(from, to);
      await chmod(to, sourceFileInfo.mode);
      const destinationInfo = await stat(to);
      if (!destinationInfo.isFile() || destinationInfo.nlink !== 1) throw new SessionWorkspaceError(`Materialized workspace file must be a fresh ordinary file: ${to}`);
      continue;
    }
    throw new SessionWorkspaceError(`Refusing to materialize unsupported file type: ${from}`);
  }
}

export async function discoverDeclaredLessonWorkspaces(contentRoot: string): Promise<string[]> {
  const workbook = await loadWorkbook(contentRoot);
  const workspaces = new Set<string>();
  for (const chapter of workbook.chapters) if (chapter.lesson.workspace) workspaces.add(chapter.lesson.workspace);
  return [...workspaces].sort();
}

async function validateAuthoredWorkspaceTemplate(contentRoot: string, workspaceId: string): Promise<string> {
  validateLessonWorkspaceId(workspaceId, "lesson workspace");
  const authoredRoot = resolve(contentRoot, AUTHORED_WORKSPACES_DIRECTORY);
  const source = resolve(authoredRoot, workspaceId);
  const realContentRoot = await realpath(contentRoot);
  let info;
  try { info = await lstat(source); }
  catch {
    throw new SessionWorkspaceError(`Declared workspace '${workspaceId}' is missing; expected ${AUTHORED_WORKSPACES_DIRECTORY}/${workspaceId}.`);
  }
  if (info.isSymbolicLink()) throw new SessionWorkspaceError(`Authored workspace template must be a real directory, not a symlink: ${source}`);
  if (!info.isDirectory()) throw new SessionWorkspaceError(`Authored workspace template must be a directory: ${source}`);
  const realSource = await realpath(source);
  if (!inside(realContentRoot, realSource)) throw new SessionWorkspaceError(`Authored workspace template must stay inside the content root: ${source}`);
  return source;
}

function isolatedGitEnvironment(): NodeJS.ProcessEnv {
  const ambient = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")));
  return { ...ambient, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: devNull, GIT_TERMINAL_PROMPT: "0" };
}

async function git(workspaceRoot: string, ...args: string[]): Promise<string> {
  const result = await run("git", ["-C", workspaceRoot, ...args], { env: isolatedGitEnvironment() });
  return result.stdout;
}

function sessionGitignore(runtimeTargets: readonly SafeWorkspaceRelativePath[]): string {
  return [...LESSON_WORKSPACE_GITIGNORE_LINES, ...runtimeTargets.map((target) => `${target}/`)].join("\n") + "\n";
}

async function ensureEmptyRuntimeDirectory(workspaceRoot: string, target: SafeWorkspaceRelativePath): Promise<void> {
  const realWorkspace = await realpath(workspaceRoot);
  const destination = resolve(workspaceRoot, target);
  const parent = resolve(dirname(destination));
  await mkdir(parent, { recursive: true });
  const realParent = await realpath(parent);
  if (!inside(realWorkspace, realParent)) throw new SessionWorkspaceError(`Runtime mount target must stay inside the learner workspace: ${target}`);

  try {
    const info = await lstat(destination);
    if (info.isSymbolicLink()) throw new SessionWorkspaceError(`Runtime mount target must be a real directory, not a symlink: ${target}`);
    if (!info.isDirectory()) throw new SessionWorkspaceError(`Runtime mount target must be a directory: ${target}`);
    if ((await readdir(destination)).length > 0) throw new SessionWorkspaceError(`Runtime mount target must be empty: ${target}`);
  } catch (error) {
    if (error instanceof SessionWorkspaceError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
    await mkdir(destination);
  }
}

async function initializeLiveWorkspaceRepository(workspaceRoot: string, workspaceId: string, runtimeTargets: readonly SafeWorkspaceRelativePath[] = []): Promise<void> {
  await writeFile(resolve(workspaceRoot, ".gitignore"), sessionGitignore(runtimeTargets), "utf8");
  await git(workspaceRoot, "init", "-q", "-b", "main");
  for (const [key, value] of WORKER_REPOSITORY_GIT_CONFIG) await git(workspaceRoot, "config", "--local", key, value);
  await git(workspaceRoot, "add", "-A");
  const status = await git(workspaceRoot, "status", "--porcelain");
  if (status.trim()) await git(workspaceRoot, "commit", "-qm", `Materialize tutorial workspace ${workspaceId}`);
}

async function validateLiveWorkspaceRepository(workspacesRoot: string, workspaceId: string, workspaceRoot: string): Promise<void> {
  await requireDirectoryInside(workspaceRoot, `Session workspace '${workspaceId}'`, workspacesRoot);
  const top = (await git(workspaceRoot, "rev-parse", "--show-toplevel")).trim();
  const realTop = await realpath(top);
  const realWorkspace = await realpath(workspaceRoot);
  if (realTop !== realWorkspace) throw new SessionWorkspaceError(`Session workspace '${workspaceId}' must be its own Git repository.`);
}

function workspaceRootsFor(workspacesRoot: string, ids: readonly string[]): Record<string, string> {
  return Object.fromEntries(ids.map((id) => [id, resolve(workspacesRoot, id)]));
}

export function workspaceRootFor(paths: TutorialSessionPaths, workspaceId: string): string {
  validateLessonWorkspaceId(workspaceId, "lesson workspace");
  const root = paths.workspaceRoots[workspaceId];
  if (!root) throw new SessionWorkspaceError(`Session does not contain workspace '${workspaceId}'.`);
  return root;
}

export class SessionWorkspaceManager {
  readonly contentRoot: string;

  private constructor(contentRoot: string) { this.contentRoot = contentRoot; }

  static async create(contentRoot: string): Promise<SessionWorkspaceManager> {
    if (!contentRoot) throw new SessionWorkspaceError("A content root is required.");
    await requireDirectory(contentRoot, "Content root");
    const canonicalContentRoot = await realpath(contentRoot);
    return new SessionWorkspaceManager(canonicalContentRoot);
  }

  pathsFor(sessionId: string, workspaceIds: readonly string[] = []): TutorialSessionPaths {
    const safeId = validateSessionId(sessionId);
    const sessionRoot = resolve(this.contentRoot, SESSION_STATE_DIRECTORY, safeId);
    const stateRoot = resolve(this.contentRoot, SESSION_STATE_DIRECTORY);
    if (!inside(stateRoot, sessionRoot)) throw new SessionWorkspaceError("Session root must stay inside the tutorial state directory.");
    const workspacesRoot = resolve(sessionRoot, SESSION_WORKSPACES_DIRECTORY);
    return {
      contentRoot: this.contentRoot,
      sessionId: safeId,
      sessionRoot,
      workspacesRoot,
      workspaceRoots: workspaceRootsFor(workspacesRoot, workspaceIds),
    };
  }

  async createSession(options: CreateTutorialSessionOptions = {}): Promise<TutorialSessionPaths> {
    const runtimeProvision = options.runtimeProvision ? trustRuntimeProvision(options.runtimeProvision) : NO_RUNTIME_PROVISION;
    const sessionId = options.id === undefined ? createSessionId(options) : validateSessionId(options.id);
    const workspaceIds = await discoverDeclaredLessonWorkspaces(this.contentRoot);
    const paths = this.pathsFor(sessionId, workspaceIds);
    await ensureSessionStateDirectory(this.contentRoot);
    if (await pathExists(paths.sessionRoot)) throw new SessionWorkspaceError(`Session '${sessionId}' already exists.`);

    await mkdir(paths.workspacesRoot, { recursive: true });
    try {
      for (const workspaceId of workspaceIds) {
        const source = await validateAuthoredWorkspaceTemplate(this.contentRoot, workspaceId);
        const destination = workspaceRootFor(paths, workspaceId);
        await copyAuthoredDirectory(source, destination, this.contentRoot);
        for (const target of runtimeProvision.workspaceMountTargets) await ensureEmptyRuntimeDirectory(destination, target);
        await initializeLiveWorkspaceRepository(destination, workspaceId, runtimeProvision.workspaceMountTargets);
      }
    } catch (error) {
      await rm(paths.sessionRoot, { recursive: true, force: true });
      throw error;
    }
    return runtimeProvision.workspaceMountTargets.length ? { ...paths, runtimeProvision } : paths;
  }

  async reopenSession(sessionId: string): Promise<TutorialSessionPaths> {
    const workspaceIds = await discoverDeclaredLessonWorkspaces(this.contentRoot);
    const paths = this.pathsFor(sessionId, workspaceIds);
    const stateRoot = resolve(this.contentRoot, SESSION_STATE_DIRECTORY);
    await requireDirectoryInside(paths.sessionRoot, `Session '${paths.sessionId}'`, stateRoot);
    await requireDirectoryInside(paths.workspacesRoot, `Session '${paths.sessionId}' workspaces`, paths.sessionRoot);
    for (const workspaceId of workspaceIds) await validateLiveWorkspaceRepository(paths.workspacesRoot, workspaceId, workspaceRootFor(paths, workspaceId));
    return paths;
  }
}

export async function createTutorialSession(contentRoot: string, options: CreateTutorialSessionOptions = {}): Promise<TutorialSessionPaths> {
  return (await SessionWorkspaceManager.create(contentRoot)).createSession(options);
}

export async function reopenTutorialSession(contentRoot: string, sessionId: string): Promise<TutorialSessionPaths> {
  return (await SessionWorkspaceManager.create(contentRoot)).reopenSession(sessionId);
}
