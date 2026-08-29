import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readdir, readFile, realpath, rm, stat, writeFile, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { parseFrontMatter } from "../../tutorial-engine/src/workbook/load.js";
import { SessionWorkspaceManager, type CreateTutorialSessionOptions, type TutorialSessionPaths } from "../../tutorial-engine/src/session-workspace.js";
import { startWorkbookServer, type StartedWorkbookServer, type WorkbookServerOptions } from "../../tutorial-engine/src/workbook/server.js";
import type { WorkbookLesson } from "../../tutorial-engine/src/workbook/contract.js";
import { loadWorkbook } from "../../tutorial-engine/src/workbook/load.js";
import { trustRuntimeProvision, type RuntimeProvisionInput, type TrustedRuntimeProvision } from "../../tutorial-engine/src/workbook/runtime-provision.js";

export interface AuthoredCurriculumLessonSelection {
  id: string;
  /** Omit to include every authored block in source order. */
  blocks?: readonly string[];
}

export interface AuthoredCurriculumPartSelection {
  id: string;
  lessons: readonly AuthoredCurriculumLessonSelection[];
}

export interface AuthoredCurriculumSliceSelection {
  parts: readonly AuthoredCurriculumPartSelection[];
}

export interface AuthoredSliceProvenanceRoot {
  path: string;
  internal: true;
  reportable: false;
}

export interface AuthoredSliceProvenanceEntryBase {
  kind: "file" | "directory";
  sourceRelativePath: string;
  materializedRelativePath: string;
  sourceMode: string;
  materializedMode: string;
  exact: boolean;
  internal: false;
  reportable: true;
  note?: string;
}

export interface AuthoredSliceProvenanceFile extends AuthoredSliceProvenanceEntryBase {
  kind: "file";
  sourceSha256: string;
  materializedSha256: string;
}

export interface AuthoredSliceProvenanceDirectory extends AuthoredSliceProvenanceEntryBase {
  kind: "directory";
}

export type AuthoredSliceProvenanceEntry = AuthoredSliceProvenanceFile | AuthoredSliceProvenanceDirectory;

export interface AuthoredSliceProvenance {
  /** Absolute roots are local implementation details and must not be projected into public reports. */
  sourceTutorialRoot: string;
  materializedRoot: string;
  roots: {
    sourceTutorialRoot: AuthoredSliceProvenanceRoot;
    materializedRoot: AuthoredSliceProvenanceRoot;
  };
  selection: AuthoredCurriculumSliceSelection;
  entries: AuthoredSliceProvenanceEntry[];
  files: AuthoredSliceProvenanceFile[];
}

export interface AuthoredEvaluatorPrerequisiteContext {
  /** Disposable content root that the workbook server will load. Do not write curriculum here. */
  contentRoot: string;
  /** Fresh normal tutorial session created for this server start. */
  session: TutorialSessionPaths;
}

export interface AuthoredEvaluatorPrerequisite {
  id: string;
  description: string;
  /** Apply only evaluator-owned state, normally beneath session.sessionRoot or one session workspace. */
  apply(context: AuthoredEvaluatorPrerequisiteContext): Promise<void>;
}

export interface AuthoredEvaluatorDriver {
  id: string;
  drive(context: { serverUrl: string; session: TutorialSessionPaths; contentRoot: string }): Promise<void>;
}

export type AuthoredSliceServerFactory = (options: WorkbookServerOptions) => Promise<StartedWorkbookServer>;

export interface AuthoredCurriculumSliceWorkspaceDependencies {
  startWorkbookServer?: AuthoredSliceServerFactory;
  /** Test seam: invoked immediately before opening a selected source file for materialization. */
  beforeSourceFileOpen?: (sourceRelativePath: string) => void | Promise<void>;
}

export interface CreateAuthoredCurriculumSliceWorkspaceOptions {
  selection: AuthoredCurriculumSliceSelection;
  sourceTutorialRoot?: string;
  tempParent?: string;
  /** Non-release diagnostic switch: close() leaves the disposable repository on disk. */
  keepWorkspace?: boolean;
  prerequisites?: readonly AuthoredEvaluatorPrerequisite[];
  /** Test seam only: production authored slices use the repository root node_modules runtime provision. */
  runtimeProvision?: RuntimeProvisionInput;
  dependencies?: AuthoredCurriculumSliceWorkspaceDependencies;
}

export interface StartAuthoredSliceServerOptions {
  session?: CreateTutorialSessionOptions;
  prerequisites?: readonly AuthoredEvaluatorPrerequisite[];
}

export interface AuthoredCurriculumSliceWorkspace {
  repositoryRoot: string;
  root: string;
  webRoot: string;
  sourceTutorialRoot: string;
  provenance: AuthoredSliceProvenance;
  sessions: TutorialSessionPaths[];
  latestSession(): TutorialSessionPaths;
  startServer(serverOptions?: Partial<Omit<WorkbookServerOptions, "target" | "webRoot" | "session">>, options?: StartAuthoredSliceServerOptions): Promise<StartedWorkbookServer>;
  close(): Promise<void>;
}

type StructuralManifest = Map<string, string>;
type SourceKind = "file" | "directory";
type ProvenanceRecorder = { entries: AuthoredSliceProvenanceEntry[]; seen: Set<string> };

interface RegularFileIdentity {
  type: "file";
  dev: number;
  ino: number;
  nlink: number;
  mode: string;
  size: number;
  sha256: string;
}

interface DirectoryIdentity {
  type: "directory";
  dev: number;
  ino: number;
  nlink: number;
  mode: string;
}

type SourceIdentity = RegularFileIdentity | DirectoryIdentity;
type SourceValidationManifest = Map<string, SourceIdentity>;

const maxAuthoredSourceFileBytes = 16 * 1024 * 1024;

const workbookIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const blockIdPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const defaultRepositoryRoot = resolve(import.meta.dirname, "../..");
const defaultSourceTutorialRoot = resolve(defaultRepositoryRoot, "tutorial");
const webIndex = "<!doctype html><title>Authored curriculum evaluator</title><div id=\"root\"></div>\n";
const derivedWorkbookNote = "front matter narrowed to selected authored parts and lessons";
const derivedPartOrdinalNote = "part heading ordinal adjusted so the isolated slice satisfies the workbook loader invariant";
const derivedLessonBlocksNote = "lesson front matter narrowed to selected authored blocks";
const generatedOrSessionEntryNames = new Set([".tmp", ".tutorial", "node_modules", ".git", ".DS_Store"]);

export function trustedAuthoredSliceRuntimeProvision(repositoryRoot = defaultRepositoryRoot): TrustedRuntimeProvision {
  return trustRuntimeProvision({ mounts: [{ source: resolve(repositoryRoot, "node_modules"), target: "node_modules", readonly: true }] });
}

export async function sha256File(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function permissionMode(mode: number): string {
  return (mode & 0o7777).toString(8).padStart(4, "0");
}

function sameStableNode(left: Pick<RegularFileIdentity | DirectoryIdentity, "dev" | "ino" | "nlink" | "mode" | "type">, right: Pick<RegularFileIdentity | DirectoryIdentity, "dev" | "ino" | "nlink" | "mode" | "type">): boolean {
  return left.type === right.type && left.dev === right.dev && left.ino === right.ino && left.nlink === right.nlink && left.mode === right.mode;
}

function describeFileIdentity(identity: RegularFileIdentity): string {
  return `${identity.type}:${identity.dev}:${identity.ino}:${identity.nlink}:${identity.mode}:${identity.sha256}`;
}

function describeDirectoryIdentity(identity: DirectoryIdentity): string {
  // Directory hardlinks are not portable, and a directory's link count changes when
  // excluded generated child directories (.tmp/.tutorial/.git/node_modules) are
  // created or removed. The structural guard therefore tracks stable device/inode
  // identity plus permissions, but deliberately excludes nlink.
  return `${identity.type}:${identity.dev}:${identity.ino}:${identity.mode}`;
}

async function readBoundedFileFromHandle(handle: FileHandle, size: number, label: string): Promise<Buffer> {
  if (!Number.isSafeInteger(size) || size < 0 || size > maxAuthoredSourceFileBytes) throw new Error(`${label} is too large to materialize safely (${size} bytes).`);
  const buffer = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const { bytesRead } = await handle.read(buffer, offset, size - offset, offset);
    if (bytesRead === 0) throw new Error(`${label} changed while it was being read.`);
    offset += bytesRead;
  }
  const extra = Buffer.alloc(1);
  const { bytesRead: extraBytes } = await handle.read(extra, 0, 1, size);
  if (extraBytes !== 0) throw new Error(`${label} changed while it was being read.`);
  return buffer;
}

async function readStableRegularFile(input: { root: string; relativePath: string; expected?: RegularFileIdentity; beforeOpen?: (sourceRelativePath: string) => void | Promise<void>; labelPrefix?: string }): Promise<{ path: string; data: Buffer; identity: RegularFileIdentity }> {
  const path = resolve(input.root, input.relativePath);
  if (!inside(input.root, path)) throw new Error(`Refusing authored source path outside the tutorial root: ${input.relativePath}`);
  await input.beforeOpen?.(input.relativePath);

  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP") throw new Error(`Refusing symlinked authored source file: ${input.relativePath}`);
    if (code === "ENOENT") throw new Error(`Selected authored source file is missing: ${input.relativePath}`);
    throw error;
  }

  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error(`Selected authored source must be a file: ${input.relativePath}`);
    if (before.nlink !== 1) throw new Error(`Refusing authored source file with hardlink aliases: ${input.relativePath}`);
    const beforeIdentity = { type: "file" as const, dev: before.dev, ino: before.ino, nlink: before.nlink, mode: permissionMode(before.mode), size: before.size };
    if (input.expected !== undefined && !sameStableNode(beforeIdentity, input.expected)) throw new Error(`Selected authored source file changed before materialization: ${input.relativePath}`);
    const data = await readBoundedFileFromHandle(handle, before.size, input.labelPrefix ? `${input.labelPrefix}: ${input.relativePath}` : input.relativePath);
    const after = await handle.stat();
    const afterIdentity = { type: "file" as const, dev: after.dev, ino: after.ino, nlink: after.nlink, mode: permissionMode(after.mode), size: after.size };
    if (!after.isFile() || !sameStableNode(beforeIdentity, afterIdentity) || before.size !== after.size) throw new Error(`Selected authored source file changed while it was being read: ${input.relativePath}`);
    const identity: RegularFileIdentity = { ...afterIdentity, sha256: createHash("sha256").update(data).digest("hex") };
    if (input.expected !== undefined && (identity.sha256 !== input.expected.sha256 || identity.size !== input.expected.size)) throw new Error(`Selected authored source file content changed before materialization: ${input.relativePath}`);

    const pathInfo = await lstat(path);
    if (pathInfo.isSymbolicLink()) throw new Error(`Refusing symlinked authored source file: ${input.relativePath}`);
    const pathIdentity = { type: "file" as const, dev: pathInfo.dev, ino: pathInfo.ino, nlink: pathInfo.nlink, mode: permissionMode(pathInfo.mode), size: pathInfo.size };
    if (!pathInfo.isFile() || !sameStableNode(pathIdentity, identity) || pathInfo.size !== identity.size) throw new Error(`Selected authored source file path changed during materialization: ${input.relativePath}`);
    const realSource = await realpath(path);
    if (!inside(input.root, realSource)) throw new Error(`Resolved authored source escapes the tutorial root: ${input.relativePath}`);
    return { path, data, identity };
  } finally {
    await handle.close();
  }
}

async function writeFreshRegularFile(destination: string, data: Buffer | string, mode: string): Promise<RegularFileIdentity> {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
  let handle: FileHandle;
  try {
    handle = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, Number.parseInt(mode, 8));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") throw new Error(`Refusing to overwrite existing materialized file: ${destination}`);
    if (code === "ELOOP") throw new Error(`Refusing symlinked materialized destination: ${destination}`);
    throw error;
  }

  let openIdentity: RegularFileIdentity;
  try {
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, offset);
      if (bytesWritten === 0) throw new Error(`Could not write materialized file: ${destination}`);
      offset += bytesWritten;
    }
    await handle.chmod(Number.parseInt(mode, 8));
    const info = await handle.stat();
    if (!info.isFile()) throw new Error(`Materialized destination must be a file: ${destination}`);
    if (info.nlink !== 1) throw new Error(`Materialized destination has hardlink aliases: ${destination}`);
    if (info.size !== bytes.length) throw new Error(`Materialized destination size changed while writing: ${destination}`);
    openIdentity = { type: "file", dev: info.dev, ino: info.ino, nlink: info.nlink, mode: permissionMode(info.mode), size: info.size, sha256: createHash("sha256").update(bytes).digest("hex") };
  } finally {
    await handle.close();
  }

  const pathInfo = await lstat(destination);
  if (!pathInfo.isFile() || pathInfo.isSymbolicLink()) throw new Error(`Materialized destination path is not a fresh ordinary file: ${destination}`);
  const pathIdentity = { type: "file" as const, dev: pathInfo.dev, ino: pathInfo.ino, nlink: pathInfo.nlink, mode: permissionMode(pathInfo.mode), size: pathInfo.size };
  if (!sameStableNode(pathIdentity, openIdentity) || pathInfo.size !== openIdentity.size) throw new Error(`Materialized destination path changed after writing: ${destination}`);
  return openIdentity;
}

function unixRelative(from: string, to: string): string {
  return relative(from, to).split(sep).join("/");
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`));
}

async function assertDirectory(path: string, label: string): Promise<string> {
  let info;
  try { info = await lstat(path); }
  catch { throw new Error(`${label} does not exist: ${path}`); }
  if (info.isSymbolicLink()) throw new Error(`${label} must be a real directory, not a symlink: ${path}`);
  if (!info.isDirectory()) throw new Error(`${label} must be a directory: ${path}`);
  return realpath(path);
}

async function requireSourceEntry(sourceTutorialRoot: string, sourceRelativePath: string, kind: SourceKind): Promise<{ path: string }> {
  const source = resolve(sourceTutorialRoot, sourceRelativePath);
  if (!inside(sourceTutorialRoot, source)) throw new Error(`Refusing authored source path outside the tutorial root: ${sourceRelativePath}`);
  let info;
  try { info = await lstat(source); }
  catch { throw new Error(`Selected authored source ${kind} is missing: ${sourceRelativePath}`); }
  if (info.isSymbolicLink()) throw new Error(`Refusing symlinked authored source ${kind}: ${sourceRelativePath}`);
  if (kind === "file") {
    if (!info.isFile()) throw new Error(`Selected authored source must be a file: ${sourceRelativePath}`);
    if (info.nlink !== 1) throw new Error(`Refusing authored source file with hardlink aliases: ${sourceRelativePath}`);
  }
  if (kind === "directory" && !info.isDirectory()) throw new Error(`Selected authored source must be a directory: ${sourceRelativePath}`);
  const realSource = await realpath(source);
  if (!inside(sourceTutorialRoot, realSource)) throw new Error(`Resolved authored source escapes the tutorial root: ${sourceRelativePath}`);
  return { path: source };
}

function requireManifestFile(manifest: SourceValidationManifest, relativePath: string): RegularFileIdentity {
  const entry = manifest.get(relativePath);
  if (!entry) throw new Error(`Selected authored source file was not preflighted: ${relativePath}`);
  if (entry.type !== "file") throw new Error(`Selected authored source path is not a file: ${relativePath}`);
  return entry;
}

function requireManifestDirectory(manifest: SourceValidationManifest, relativePath: string): DirectoryIdentity {
  const entry = manifest.get(relativePath);
  if (!entry) throw new Error(`Selected authored source directory was not preflighted: ${relativePath}`);
  if (entry.type !== "directory") throw new Error(`Selected authored source path is not a directory: ${relativePath}`);
  return entry;
}

async function readSourceFile(sourceTutorialRoot: string, sourceRelativePath: string, manifest: SourceValidationManifest, dependencies?: AuthoredCurriculumSliceWorkspaceDependencies): Promise<string> {
  const source = await readStableRegularFile({ root: sourceTutorialRoot, relativePath: sourceRelativePath, expected: requireManifestFile(manifest, sourceRelativePath), beforeOpen: dependencies?.beforeSourceFileOpen, labelPrefix: "Selected authored source" });
  return source.data.toString("utf8");
}

function splitAuthoredFrontMatter(text: string, location: string): { data: Record<string, unknown>; bodyWithLeadingNewline: string } {
  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (lines[0] !== "---") throw new Error(`${location} needs YAML front matter delimited by --- lines.`);
  const closing = lines.indexOf("---", 1);
  if (closing < 0) throw new Error(`${location} front matter is missing its closing --- line.`);
  return { data: parseFrontMatter(normalized, location).data, bodyWithLeadingNewline: lines.slice(closing + 1).join("\n") };
}

function workbookFrontMatter(selection: AuthoredCurriculumSliceSelection): string {
  const lines = ["---", "parts:"];
  for (const part of selection.parts) {
    lines.push(`  - id: ${part.id}`, "    lessons:");
    for (const lesson of part.lessons) lines.push(`      - ${lesson.id}`);
  }
  lines.push("---");
  return `${lines.join("\n")}\n`;
}

function lessonFrontMatter(source: Record<string, unknown>, blocks: readonly string[]): string {
  const lines = ["---", `durationMinutes: ${String(source.durationMinutes)}`];
  if (typeof source.workspace === "string") lines.push(`workspace: ${source.workspace}`);
  lines.push("blocks:");
  for (const block of blocks) lines.push(`  - ${block}`);
  lines.push("---");
  return `${lines.join("\n")}\n`;
}

function renumberPartHeadingIfNeeded(text: string, partPosition: number): { text: string; changed: boolean } {
  const desired = `# Part ${partPosition} `;
  let changed = false;
  const rewritten = text.replace(/(^|\n)# Part\s+\d+\s+/i, (match, prefix: string) => {
    changed = !match.startsWith(`${prefix}${desired}`);
    return `${prefix}${desired}`;
  });
  return { text: rewritten, changed };
}

function provenanceRelative(root: string, path: string): string {
  const relativePath = unixRelative(root, path);
  return relativePath === "" ? "." : relativePath;
}

function provenanceKey(kind: AuthoredSliceProvenanceEntry["kind"], materializedRelativePath: string): string {
  return `${kind}:${materializedRelativePath}`;
}

async function recordFileProvenance(input: { sourceRelativePath: string; materializedRoot: string; destination: string; sourceIdentity: RegularFileIdentity; materializedIdentity: RegularFileIdentity; exact: boolean; recorder: ProvenanceRecorder; note?: string }): Promise<void> {
  const materializedRelativePath = provenanceRelative(input.materializedRoot, input.destination);
  const key = provenanceKey("file", materializedRelativePath);
  if (input.recorder.seen.has(key)) return;
  input.recorder.seen.add(key);
  input.recorder.entries.push({
    kind: "file",
    sourceRelativePath: input.sourceRelativePath,
    materializedRelativePath,
    sourceMode: input.sourceIdentity.mode,
    materializedMode: input.materializedIdentity.mode,
    sourceSha256: input.sourceIdentity.sha256,
    materializedSha256: input.materializedIdentity.sha256,
    exact: input.exact,
    internal: false,
    reportable: true,
    ...(input.note === undefined ? {} : { note: input.note })
  });
}

async function recordDirectoryProvenance(input: { sourceRelativePath: string; materializedRoot: string; destination: string; sourceIdentity: DirectoryIdentity; exact: boolean; recorder: ProvenanceRecorder; note?: string }): Promise<void> {
  const materializedRelativePath = provenanceRelative(input.materializedRoot, input.destination);
  const key = provenanceKey("directory", materializedRelativePath);
  if (input.recorder.seen.has(key)) return;
  input.recorder.seen.add(key);
  const materializedInfo = await lstat(input.destination);
  input.recorder.entries.push({
    kind: "directory",
    sourceRelativePath: input.sourceRelativePath,
    materializedRelativePath,
    sourceMode: input.sourceIdentity.mode,
    materializedMode: permissionMode(materializedInfo.mode),
    exact: input.exact,
    internal: false,
    reportable: true,
    ...(input.note === undefined ? {} : { note: input.note })
  });
}

async function ensureSourcedDirectory(sourceTutorialRoot: string, materializedRoot: string, sourceRelativePath: string, recorder: ProvenanceRecorder, manifest: SourceValidationManifest): Promise<void> {
  const normalized = sourceRelativePath === "" ? "." : sourceRelativePath;
  const destination = normalized === "." ? materializedRoot : resolve(materializedRoot, normalized);
  const key = provenanceKey("directory", provenanceRelative(materializedRoot, destination));
  if (recorder.seen.has(key)) return;
  const parent = normalized === "." ? undefined : dirname(normalized);
  if (parent !== undefined) await ensureSourcedDirectory(sourceTutorialRoot, materializedRoot, parent === "." ? "." : parent, recorder, manifest);
  const source = await requireSourceEntry(sourceTutorialRoot, normalized, "directory");
  const sourceIdentity = requireManifestDirectory(manifest, normalized);
  const sourceInfo = await lstat(source.path);
  const currentIdentity = { type: "directory" as const, dev: sourceInfo.dev, ino: sourceInfo.ino, nlink: sourceInfo.nlink, mode: permissionMode(sourceInfo.mode) };
  if (!sameStableNode(currentIdentity, sourceIdentity)) throw new Error(`Selected authored source directory changed before materialization: ${normalized}`);
  await mkdir(destination, { recursive: true });
  await chmod(destination, Number.parseInt(sourceIdentity.mode, 8));
  await recordDirectoryProvenance({ sourceRelativePath: normalized, materializedRoot, destination, sourceIdentity, exact: true, recorder });
}

async function copySourceFile(sourceTutorialRoot: string, materializedRoot: string, sourceRelativePath: string, recorder: ProvenanceRecorder, manifest: SourceValidationManifest, dependencies?: AuthoredCurriculumSliceWorkspaceDependencies): Promise<void> {
  const source = await readStableRegularFile({ root: sourceTutorialRoot, relativePath: sourceRelativePath, expected: requireManifestFile(manifest, sourceRelativePath), beforeOpen: dependencies?.beforeSourceFileOpen, labelPrefix: "Selected authored source" });
  const destination = resolve(materializedRoot, sourceRelativePath);
  await ensureSourcedDirectory(sourceTutorialRoot, materializedRoot, dirname(sourceRelativePath), recorder, manifest);
  const materializedIdentity = await writeFreshRegularFile(destination, source.data, source.identity.mode);
  await recordFileProvenance({ sourceRelativePath, materializedRoot, destination, sourceIdentity: source.identity, materializedIdentity, exact: true, recorder });
}

async function writeDerivedSourceFile(sourceTutorialRoot: string, materializedRoot: string, sourceRelativePath: string, text: string, recorder: ProvenanceRecorder, manifest: SourceValidationManifest, dependencies: AuthoredCurriculumSliceWorkspaceDependencies | undefined, note: string): Promise<void> {
  const source = await readStableRegularFile({ root: sourceTutorialRoot, relativePath: sourceRelativePath, expected: requireManifestFile(manifest, sourceRelativePath), beforeOpen: dependencies?.beforeSourceFileOpen, labelPrefix: "Selected authored source" });
  const sourceText = source.data.toString("utf8");
  const destination = resolve(materializedRoot, sourceRelativePath);
  await ensureSourcedDirectory(sourceTutorialRoot, materializedRoot, dirname(sourceRelativePath), recorder, manifest);
  const exact = text === sourceText;
  const materializedIdentity = await writeFreshRegularFile(destination, exact ? source.data : text, source.identity.mode);
  await recordFileProvenance({ sourceRelativePath, materializedRoot, destination, sourceIdentity: source.identity, materializedIdentity, exact, recorder, ...(exact ? {} : { note }) });
}

function selectedBlockIds(selection: AuthoredCurriculumLessonSelection, sourceLesson: WorkbookLesson): string[] {
  if (selection.blocks === undefined) return sourceLesson.blocks.map((block) => block.id);
  const sourceIds = new Set(sourceLesson.blocks.map((block) => block.id));
  const unknown = selection.blocks.filter((block) => !sourceIds.has(block));
  if (unknown.length) throw new Error(`Lesson '${selection.id}' does not contain selected block id(s): ${unknown.join(", ")}`);
  const requested = new Set(selection.blocks);
  return sourceLesson.blocks.map((block) => block.id).filter((block) => requested.has(block));
}

function validateSelection(selection: AuthoredCurriculumSliceSelection): void {
  if (!selection.parts.length) throw new Error("An authored curriculum slice needs at least one selected part.");
  const partIds = new Set<string>();
  const lessonIds = new Set<string>();
  for (const part of selection.parts) {
    if (!workbookIdPattern.test(part.id)) throw new Error(`Selected part id '${part.id}' is malformed.`);
    if (partIds.has(part.id)) throw new Error(`Duplicate selected part '${part.id}'.`);
    partIds.add(part.id);
    if (!part.lessons.length) throw new Error(`Selected part '${part.id}' needs at least one selected lesson.`);
    for (const lesson of part.lessons) {
      if (!workbookIdPattern.test(lesson.id)) throw new Error(`Selected lesson id '${lesson.id}' is malformed.`);
      if (lessonIds.has(lesson.id)) throw new Error(`Duplicate selected lesson '${lesson.id}'.`);
      lessonIds.add(lesson.id);
      if (lesson.blocks?.length === 0) throw new Error(`Selected lesson '${lesson.id}' needs at least one selected block.`);
      const blockIds = new Set<string>();
      for (const block of lesson.blocks ?? []) {
        if (!blockIdPattern.test(block)) throw new Error(`Selected block id '${lesson.id}/${block}' is malformed.`);
        if (blockIds.has(block)) throw new Error(`Duplicate selected block '${lesson.id}/${block}'.`);
        blockIds.add(block);
      }
    }
  }
}

function validateSelectionSourceOrder(selection: AuthoredCurriculumSliceSelection, sourceWorkbook: Awaited<ReturnType<typeof loadWorkbook>>): void {
  const sourcePartIndexes = new Map<string, number>();
  const sourceLessonIndexes = new Map<string, number>();
  const sourceLessonParts = new Map<string, string | undefined>();
  for (const [index, chapter] of sourceWorkbook.chapters.entries()) {
    sourceLessonIndexes.set(chapter.id, index);
    sourceLessonParts.set(chapter.id, chapter.partId);
    if (chapter.partId !== undefined && !sourcePartIndexes.has(chapter.partId)) sourcePartIndexes.set(chapter.partId, sourcePartIndexes.size);
  }

  let previousPartIndex = -1;
  for (const part of selection.parts) {
    const partIndex = sourcePartIndexes.get(part.id);
    if (partIndex === undefined) throw new Error(`Selected part '${part.id}' does not exist in the authored source tutorial.`);
    if (partIndex < previousPartIndex) throw new Error("Selected parts must be supplied in authored source order.");
    previousPartIndex = partIndex;

    let previousLessonIndex = -1;
    for (const lesson of part.lessons) {
      const lessonIndex = sourceLessonIndexes.get(lesson.id);
      if (lessonIndex === undefined) throw new Error(`Selected lesson '${lesson.id}' does not exist in the authored source tutorial.`);
      const lessonPart = sourceLessonParts.get(lesson.id);
      if (lessonPart !== part.id) throw new Error(`Selected lesson '${lesson.id}' belongs to part '${lessonPart ?? "<none>"}', not selected part '${part.id}'.`);
      if (lessonIndex < previousLessonIndex) throw new Error(`Selected lessons for part '${part.id}' must be supplied in authored source order.`);
      previousLessonIndex = lessonIndex;
    }
  }
}

async function captureSourceDirectory(sourceTutorialRoot: string, sourceRelativePath: string, manifest: SourceValidationManifest): Promise<DirectoryIdentity> {
  const normalized = sourceRelativePath === "" ? "." : sourceRelativePath;
  const existing = manifest.get(normalized);
  if (existing) {
    if (existing.type !== "directory") throw new Error(`Selected authored source path changed type before preflight completed: ${normalized}`);
    return existing;
  }
  if (normalized !== ".") await captureSourceAncestors(sourceTutorialRoot, normalized, manifest);
  const source = await requireSourceEntry(sourceTutorialRoot, normalized, "directory");
  const info = await lstat(source.path);
  const identity: DirectoryIdentity = { type: "directory", dev: info.dev, ino: info.ino, nlink: info.nlink, mode: permissionMode(info.mode) };
  manifest.set(normalized, identity);
  return identity;
}

async function captureSourceAncestors(sourceTutorialRoot: string, sourceRelativePath: string, manifest: SourceValidationManifest): Promise<void> {
  const parent = sourceRelativePath === "." ? undefined : dirname(sourceRelativePath);
  if (parent === undefined) return;
  if (parent !== ".") await captureSourceAncestors(sourceTutorialRoot, parent, manifest);
  await captureSourceDirectory(sourceTutorialRoot, parent, manifest);
}

async function captureSourceFile(sourceTutorialRoot: string, sourceRelativePath: string, manifest: SourceValidationManifest): Promise<RegularFileIdentity> {
  const existing = manifest.get(sourceRelativePath);
  if (existing) {
    if (existing.type !== "file") throw new Error(`Selected authored source path changed type before preflight completed: ${sourceRelativePath}`);
    return existing;
  }
  await captureSourceAncestors(sourceTutorialRoot, sourceRelativePath, manifest);
  const source = await readStableRegularFile({ root: sourceTutorialRoot, relativePath: sourceRelativePath, labelPrefix: "Selected authored source" });
  manifest.set(sourceRelativePath, source.identity);
  return source.identity;
}

async function captureSourceTree(sourceTutorialRoot: string, sourceRelativeRoot: string, manifest: SourceValidationManifest): Promise<void> {
  await captureSourceDirectory(sourceTutorialRoot, sourceRelativeRoot, manifest);
  const sourceRoot = resolve(sourceTutorialRoot, sourceRelativeRoot);
  for (const entry of await readdir(sourceRoot, { withFileTypes: true })) {
    if (skipGeneratedOrSessionEntry(entry.name)) continue;
    const relativePath = `${sourceRelativeRoot}/${entry.name}`;
    const source = resolve(sourceTutorialRoot, relativePath);
    const info = await lstat(source);
    if (info.isSymbolicLink()) throw new Error(`Refusing symlinked authored workspace entry: ${relativePath}`);
    if (info.isDirectory()) await captureSourceTree(sourceTutorialRoot, relativePath, manifest);
    else if (info.isFile()) await captureSourceFile(sourceTutorialRoot, relativePath, manifest);
    else throw new Error(`Refusing to copy unsupported authored workspace entry: ${relativePath}`);
  }
}

async function preflightSelectedSourcePaths(sourceTutorialRoot: string, selection: AuthoredCurriculumSliceSelection, sourceWorkbook: Awaited<ReturnType<typeof loadWorkbook>>): Promise<SourceValidationManifest> {
  const manifest: SourceValidationManifest = new Map();
  await captureSourceDirectory(sourceTutorialRoot, ".", manifest);
  await captureSourceFile(sourceTutorialRoot, "workbook.md", manifest);
  const chaptersById = new Map(sourceWorkbook.chapters.map((chapter) => [chapter.id, chapter]));
  const selectedWorkspaces = new Set<string>();
  for (const part of selection.parts) {
    await captureSourceFile(sourceTutorialRoot, `parts/${part.id}.md`, manifest);
    for (const lesson of part.lessons) {
      const chapter = chaptersById.get(lesson.id);
      if (!chapter) throw new Error(`Selected lesson '${lesson.id}' does not exist in the authored source tutorial.`);
      const blocks = selectedBlockIds(lesson, chapter.lesson);
      await captureSourceFile(sourceTutorialRoot, `lessons/${lesson.id}/lesson.md`, manifest);
      for (const block of blocks) await captureSourceFile(sourceTutorialRoot, `lessons/${lesson.id}/blocks/${block}.md`, manifest);
      if (chapter.lesson.workspace) selectedWorkspaces.add(chapter.lesson.workspace);
    }
  }
  for (const workspaceId of [...selectedWorkspaces].sort()) await captureSourceTree(sourceTutorialRoot, `workspaces/${workspaceId}`, manifest);
  return manifest;
}

function skipGeneratedOrSessionEntry(name: string): boolean {
  return generatedOrSessionEntryNames.has(name);
}

async function copyDirectoryTree(sourceTutorialRoot: string, materializedRoot: string, sourceRelativeRoot: string, recorder: ProvenanceRecorder, manifest: SourceValidationManifest, dependencies?: AuthoredCurriculumSliceWorkspaceDependencies): Promise<void> {
  requireManifestDirectory(manifest, sourceRelativeRoot);
  async function visit(relativeRoot: string): Promise<void> {
    const sourceRoot = (await requireSourceEntry(sourceTutorialRoot, relativeRoot, "directory")).path;
    await ensureSourcedDirectory(sourceTutorialRoot, materializedRoot, relativeRoot, recorder, manifest);
    const entries = await readdir(sourceRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (skipGeneratedOrSessionEntry(entry.name)) continue;
      const relativePath = `${relativeRoot}/${entry.name}`;
      const source = resolve(sourceTutorialRoot, relativePath);
      const info = await lstat(source);
      if (info.isSymbolicLink()) throw new Error(`Refusing symlinked authored workspace entry: ${relativePath}`);
      if (info.isDirectory()) await visit(relativePath);
      else if (info.isFile()) await copySourceFile(sourceTutorialRoot, materializedRoot, relativePath, recorder, manifest, dependencies);
      else throw new Error(`Refusing to copy unsupported authored workspace entry: ${relativePath}`);
    }
  }
  await visit(sourceRelativeRoot);
}

function manifestEntries(manifest: StructuralManifest): [string, string][] {
  return [...manifest.entries()].sort(([left], [right]) => left.localeCompare(right));
}

async function structuralManifest(root: string, options: { exclude?: (relativePath: string, name: string) => boolean } = {}): Promise<StructuralManifest> {
  const manifest: StructuralManifest = new Map();
  const rootInfo = await lstat(root);
  if (rootInfo.isSymbolicLink()) throw new Error("Structural manifest refuses symlink: .");
  if (!rootInfo.isDirectory()) throw new Error("Structural manifest root must be a directory.");
  const realRoot = await realpath(root);
  manifest.set("./", describeDirectoryIdentity({ type: "directory", dev: rootInfo.dev, ino: rootInfo.ino, nlink: rootInfo.nlink, mode: permissionMode(rootInfo.mode) }));
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      const relativePath = unixRelative(realRoot, path);
      if (options.exclude?.(relativePath, entry.name)) continue;
      const info = await lstat(path);
      if (info.isSymbolicLink()) throw new Error(`Structural manifest refuses symlink: ${relativePath}`);
      const realPath = await realpath(path);
      if (!inside(realRoot, realPath)) throw new Error(`Structural manifest refuses path outside root: ${relativePath}`);
      const mode = permissionMode(info.mode);
      if (info.isDirectory()) {
        manifest.set(`${relativePath}/`, describeDirectoryIdentity({ type: "directory", dev: info.dev, ino: info.ino, nlink: info.nlink, mode }));
        await visit(path);
      } else if (info.isFile()) {
        if (info.nlink !== 1) throw new Error(`Structural manifest refuses hardlinked file: ${relativePath}`);
        const stable = await readStableRegularFile({ root: realRoot, relativePath, labelPrefix: "Structural manifest" });
        manifest.set(relativePath, describeFileIdentity(stable.identity));
      } else {
        throw new Error(`Structural manifest refuses unsupported filesystem node: ${relativePath}`);
      }
    }
  }
  await visit(realRoot);
  return manifest;
}

function excludeGeneratedSessionDependencyOrVcsState(_relativePath: string, name: string): boolean {
  return skipGeneratedOrSessionEntry(name);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertManifestUnchanged(before: StructuralManifest, after: StructuralManifest, context: string, actor: string): void {
  const beforeEntries = manifestEntries(before);
  const afterEntries = manifestEntries(after);
  if (JSON.stringify(beforeEntries) === JSON.stringify(afterEntries)) return;
  const beforeMap = new Map(beforeEntries);
  const afterMap = new Map(afterEntries);
  const changed = new Set([...beforeMap.keys(), ...afterMap.keys()]);
  const examples = [...changed].filter((path) => beforeMap.get(path) !== afterMap.get(path)).sort().slice(0, 5).join(", ");
  throw new Error(`${actor} mutated ${context}; write evaluator state under the session root instead. Changed paths: ${examples}`);
}

async function assertSessionLearnerWorkspaceTreeSafe(session: TutorialSessionPaths): Promise<void> {
  for (const [workspaceId, workspaceRoot] of Object.entries(session.workspaceRoots)) {
    const rootInfo = await lstat(workspaceRoot);
    if (rootInfo.isSymbolicLink()) throw new Error(`Session learner workspace '${workspaceId}' is a symlink.`);
    if (!rootInfo.isDirectory()) throw new Error(`Session learner workspace '${workspaceId}' must be a directory.`);
    const realWorkspace = await realpath(workspaceRoot);
    async function visit(directory: string): Promise<void> {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = resolve(directory, entry.name);
        const relativePath = unixRelative(realWorkspace, path);
        if (relativePath === ".git") continue;
        if (entry.name === ".git") throw new Error(`Session learner workspace '${workspaceId}' contains unexpected Git metadata: ${relativePath}`);
        const info = await lstat(path);
        if (info.isSymbolicLink()) throw new Error(`Session learner workspace '${workspaceId}' contains symlink: ${relativePath}`);
        const realPath = await realpath(path);
        if (!inside(realWorkspace, realPath)) throw new Error(`Session learner workspace '${workspaceId}' contains a path outside the workspace: ${relativePath}`);
        if (info.isDirectory()) await visit(path);
        else if (info.isFile()) {
          if (info.nlink !== 1) throw new Error(`Session learner workspace '${workspaceId}' contains hardlink alias outside internal .git: ${relativePath}`);
        } else {
          throw new Error(`Session learner workspace '${workspaceId}' contains unsupported filesystem node: ${relativePath}`);
        }
      }
    }
    await visit(realWorkspace);
  }
}

async function materializeSlice(options: CreateAuthoredCurriculumSliceWorkspaceOptions, sourceTutorialRoot: string, root: string): Promise<AuthoredSliceProvenance> {
  validateSelection(options.selection);
  const sourceWorkbook = await loadWorkbook(sourceTutorialRoot);
  validateSelectionSourceOrder(options.selection, sourceWorkbook);
  const sourceManifest = await preflightSelectedSourcePaths(sourceTutorialRoot, options.selection, sourceWorkbook);
  const chaptersById = new Map(sourceWorkbook.chapters.map((chapter) => [chapter.id, chapter]));
  const selectedWorkspaces = new Set<string>();
  const recorder: ProvenanceRecorder = { entries: [], seen: new Set() };

  const sourceWorkbookText = await readSourceFile(sourceTutorialRoot, "workbook.md", sourceManifest, options.dependencies);
  const workbook = splitAuthoredFrontMatter(sourceWorkbookText, "workbook.md");
  if (!Array.isArray(workbook.data.parts)) throw new Error("The source authored workbook must declare parts for authored slices.");
  await writeDerivedSourceFile(sourceTutorialRoot, root, "workbook.md", `${workbookFrontMatter(options.selection)}${workbook.bodyWithLeadingNewline}`, recorder, sourceManifest, options.dependencies, derivedWorkbookNote);

  for (const [partIndex, part] of options.selection.parts.entries()) {
    const sourcePartPath = `parts/${part.id}.md`;
    const sourcePartText = await readSourceFile(sourceTutorialRoot, sourcePartPath, sourceManifest, options.dependencies);
    const numbered = renumberPartHeadingIfNeeded(sourcePartText, partIndex + 1);
    if (numbered.changed) await writeDerivedSourceFile(sourceTutorialRoot, root, sourcePartPath, numbered.text, recorder, sourceManifest, options.dependencies, derivedPartOrdinalNote);
    else await copySourceFile(sourceTutorialRoot, root, sourcePartPath, recorder, sourceManifest, options.dependencies);

    for (const lesson of part.lessons) {
      const chapter = chaptersById.get(lesson.id);
      if (!chapter) throw new Error(`Selected lesson '${lesson.id}' does not exist in the authored source tutorial.`);
      const blocks = selectedBlockIds(lesson, chapter.lesson);
      const lessonRelativePath = `lessons/${lesson.id}/lesson.md`;
      if (lesson.blocks === undefined) await copySourceFile(sourceTutorialRoot, root, lessonRelativePath, recorder, sourceManifest, options.dependencies);
      else {
        const sourceLessonText = await readSourceFile(sourceTutorialRoot, lessonRelativePath, sourceManifest, options.dependencies);
        const sourceFront = splitAuthoredFrontMatter(sourceLessonText, lessonRelativePath);
        await writeDerivedSourceFile(sourceTutorialRoot, root, lessonRelativePath, `${lessonFrontMatter(sourceFront.data, blocks)}${sourceFront.bodyWithLeadingNewline}`, recorder, sourceManifest, options.dependencies, derivedLessonBlocksNote);
      }
      if (chapter.lesson.workspace) selectedWorkspaces.add(chapter.lesson.workspace);
      for (const block of blocks) await copySourceFile(sourceTutorialRoot, root, `lessons/${lesson.id}/blocks/${block}.md`, recorder, sourceManifest, options.dependencies);
    }
  }

  for (const workspaceId of [...selectedWorkspaces].sort()) await copyDirectoryTree(sourceTutorialRoot, root, `workspaces/${workspaceId}`, recorder, sourceManifest, options.dependencies);

  const entries = recorder.entries.sort((left, right) => left.materializedRelativePath.localeCompare(right.materializedRelativePath) || left.kind.localeCompare(right.kind));
  return {
    sourceTutorialRoot,
    materializedRoot: root,
    roots: {
      sourceTutorialRoot: { path: sourceTutorialRoot, internal: true, reportable: false },
      materializedRoot: { path: root, internal: true, reportable: false }
    },
    selection: options.selection,
    entries,
    files: entries.filter((entry): entry is AuthoredSliceProvenanceFile => entry.kind === "file")
  };
}

async function writeCleanupDiagnostics(repositoryRoot: string, errors: readonly unknown[]): Promise<void> {
  if (!errors.length) return;
  const message = errors.map((error, index) => {
    if (error instanceof Error) return `${index + 1}. ${error.name}: ${error.message}${error.stack ? `\n${error.stack}` : ""}`;
    return `${index + 1}. ${String(error)}`;
  }).join("\n\n");
  await writeFile(resolve(repositoryRoot, "cleanup-failure.txt"), `${message}\n`, "utf8");
}

export async function createAuthoredCurriculumSliceWorkspace(options: CreateAuthoredCurriculumSliceWorkspaceOptions): Promise<AuthoredCurriculumSliceWorkspace> {
  const sourceTutorialRoot = await assertDirectory(options.sourceTutorialRoot ?? defaultSourceTutorialRoot, "Source tutorial root");
  const runtimeProvision = options.runtimeProvision ? trustRuntimeProvision(options.runtimeProvision) : trustedAuthoredSliceRuntimeProvision(await realpath(defaultRepositoryRoot));
  const repositoryRoot = await mkdtemp(join(options.tempParent ?? tmpdir(), "authored-eval-repository-"));
  const root = resolve(repositoryRoot, "tutorial");
  const webRoot = resolve(repositoryRoot, "web");
  const sessions: TutorialSessionPaths[] = [];
  const servers = new Set<StartedWorkbookServer>();
  const serverCloses = new Map<StartedWorkbookServer, { close: () => Promise<void>; promise?: Promise<void> }>();
  const serverFactory = options.dependencies?.startWorkbookServer ?? startWorkbookServer;
  let closedToNewServers = false;
  let cleanupComplete = false;
  let repositoryRemoved = false;
  let guardedStateFailure: AggregateError | undefined;
  let closePromise: Promise<void> | undefined;

  const closeManagedServer = async (server: StartedWorkbookServer): Promise<void> => {
    const managed = serverCloses.get(server);
    if (!managed) return;
    managed.promise ??= managed.close().finally(() => {
      servers.delete(server);
      serverCloses.delete(server);
    });
    await managed.promise;
  };

  try {
    const realRepositoryRoot = await realpath(repositoryRoot);
    if (inside(realRepositoryRoot, sourceTutorialRoot) || inside(sourceTutorialRoot, realRepositoryRoot)) throw new Error("Source tutorial root and disposable authored evaluator repository must be isolated from each other.");
    const sourceBeforePrerequisites = await structuralManifest(sourceTutorialRoot, { exclude: excludeGeneratedSessionDependencyOrVcsState });
    await mkdir(root, { recursive: true });
    const provenance = await materializeSlice(options, sourceTutorialRoot, root);
    await mkdir(webRoot, { recursive: true });
    await writeFile(resolve(webRoot, "index.html"), webIndex, "utf8");
    const disposableCurriculumBaseline = await structuralManifest(root, { exclude: excludeGeneratedSessionDependencyOrVcsState });
    const collectGuardedStateFailures = async (actor: string): Promise<unknown[]> => {
      const failures: unknown[] = [];
      try { assertManifestUnchanged(sourceBeforePrerequisites, await structuralManifest(sourceTutorialRoot, { exclude: excludeGeneratedSessionDependencyOrVcsState }), "the immutable authored source tutorial", actor); }
      catch (error) { failures.push(error); }
      try { assertManifestUnchanged(disposableCurriculumBaseline, await structuralManifest(root, { exclude: excludeGeneratedSessionDependencyOrVcsState }), "the disposable curriculum content", actor); }
      catch (error) { failures.push(error); }
      return failures;
    };

    const workspace: AuthoredCurriculumSliceWorkspace = {
      repositoryRoot,
      root,
      webRoot,
      sourceTutorialRoot,
      provenance,
      sessions,
      latestSession() {
        const session = sessions.at(-1);
        if (!session) throw new Error("No authored curriculum slice session has started.");
        return session;
      },
      async startServer(serverOptions: Partial<Omit<WorkbookServerOptions, "target" | "webRoot" | "session">> = {}, startOptions: StartAuthoredSliceServerOptions = {}) {
        if (closedToNewServers) throw new Error("Authored curriculum slice workspace is already closing or closed.");
        if (guardedStateFailure) throw guardedStateFailure;
        let session: TutorialSessionPaths;
        try {
          session = await (await SessionWorkspaceManager.create(root)).createSession({ ...(startOptions.session ?? {}), runtimeProvision });
        } catch (error) {
          const guardFailures = await collectGuardedStateFailures("Session materialization");
          if (guardFailures.length) {
            guardedStateFailure = new AggregateError([...guardFailures, error], `Session materialization failed after guarded curriculum state changed: ${[...guardFailures, error].map(errorMessage).join("; ")}`);
            throw guardedStateFailure;
          }
          throw error;
        }
        sessions.push(session);
        const prerequisites = [...(options.prerequisites ?? []), ...(startOptions.prerequisites ?? [])];
        const failures: unknown[] = [];
        try {
          for (const prerequisite of prerequisites) await prerequisite.apply({ contentRoot: root, session });
        } catch (error) {
          failures.push(error);
        }
        try { await assertSessionLearnerWorkspaceTreeSafe(session); }
        catch (error) { failures.push(error); }
        failures.push(...await collectGuardedStateFailures("Evaluator prerequisite"));
        if (failures.length) {
          guardedStateFailure = new AggregateError(failures, `Evaluator prerequisite failed or mutated guarded curriculum state: ${failures.map(errorMessage).join("; ")}`);
          throw guardedStateFailure;
        }
        let server: StartedWorkbookServer;
        try {
          server = await serverFactory({ ...serverOptions, target: root, webRoot, session });
        } catch (error) {
          const guardFailures = await collectGuardedStateFailures("Workbook server factory");
          if (guardFailures.length) {
            guardedStateFailure = new AggregateError([...guardFailures, error], `Workbook server factory failed after guarded curriculum state changed: ${[...guardFailures, error].map(errorMessage).join("; ")}`);
            throw guardedStateFailure;
          }
          throw error;
        }
        servers.add(server);
        serverCloses.set(server, { close: server.close.bind(server) });
        return {
          ...server,
          close: async () => closeManagedServer(server)
        };
      },
      async close() {
        if (closePromise) return closePromise;
        if (cleanupComplete) return;
        closePromise = (async () => {
          closedToNewServers = true;
          const failures: unknown[] = [];
          const closeResults = await Promise.allSettled([...servers].map((server) => closeManagedServer(server)));
          for (const result of closeResults) if (result.status === "rejected") failures.push(result.reason);
          failures.push(...await collectGuardedStateFailures("Evaluator run"));
          if (!options.keepWorkspace && !repositoryRemoved) {
            try { await rm(repositoryRoot, { recursive: true, force: true }); repositoryRemoved = true; }
            catch (error) { failures.push(error); }
          }
          if (options.keepWorkspace && failures.length) {
            try { await writeCleanupDiagnostics(repositoryRoot, failures); }
            catch (error) { failures.push(error); }
          }
          cleanupComplete = true;
          if (failures.length) throw new AggregateError(failures, "Failed to clean authored curriculum slice workspace.");
        })();
        return closePromise;
      }
    };
    return workspace;
  } catch (error) {
    try { await rm(repositoryRoot, { recursive: true, force: true }); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], "Failed to create authored curriculum slice workspace."); }
    throw error;
  }
}
