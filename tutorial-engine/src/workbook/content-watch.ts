import { watch as fsWatch, type FSWatcher } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, relative, resolve, sep } from "node:path";

export interface ContentWatch {
  rescan(): Promise<void>;
  close(): void;
}

export interface ContentWatchSubscription {
  close(): void;
  on?(event: "error", listener: (error: Error) => void): void;
}

export type ContentWatchFactory = (path: string, listener: (eventType: string, filename: string | Buffer | null) => void) => ContentWatchSubscription;

export interface ContentWatchOptions {
  debounceMs?: number;
  watchFactory?: ContentWatchFactory;
}

const DEFAULT_DEBOUNCE_MS = 150;
const MARKDOWN_SUFFIX = ".md";

function defaultWatchFactory(path: string, listener: (eventType: string, filename: string | Buffer | null) => void): ContentWatchSubscription {
  return fsWatch(path, { persistent: true }, listener) as FSWatcher;
}

function isEditorScratchFile(name: string): boolean {
  return name.startsWith(".") || name.startsWith("#") || name.endsWith("~") || /\.(swp|swx|tmp)$/i.test(name);
}

export function isAuthoredWorkbookMarkdown(contentRoot: string, path: string): boolean {
  const root = resolve(contentRoot);
  const absolute = resolve(path);
  const rel = relative(root, absolute).split(sep).join("/");
  if (!rel || rel.startsWith("../") || rel === ".." || rel.startsWith("/")) return false;
  const name = basename(rel);
  if (isEditorScratchFile(name) || !name.endsWith(MARKDOWN_SUFFIX)) return false;
  if (rel === "workbook.md") return true;
  if (rel.startsWith("parts/")) return true;
  const lessonMatch = /^lessons\/[^/]+\/lesson\.md$/.test(rel);
  if (lessonMatch) return true;
  return /^lessons\/[^/]+\/blocks\/[^/]+\.md$/.test(rel);
}

async function existingDirectory(path: string): Promise<boolean> {
  try { return (await stat(path)).isDirectory(); }
  catch (error: any) { if (error?.code === "ENOENT") return false; throw error; }
}

async function listDirectories(path: string): Promise<string[]> {
  let entries;
  try { entries = await readdir(path, { withFileTypes: true }); }
  catch (error: any) { if (error?.code === "ENOENT") return []; throw error; }
  return entries.filter((entry) => entry.isDirectory() && !isEditorScratchFile(entry.name)).map((entry) => resolve(path, entry.name));
}

async function collectWatchDirectories(contentRoot: string): Promise<string[]> {
  const root = resolve(contentRoot);
  const dirs = new Set<string>();
  const add = async (path: string) => { if (await existingDirectory(path)) dirs.add(path); };
  await add(root);
  const partsRoot = resolve(root, "parts");
  await add(partsRoot);
  const partDirs = [partsRoot];
  for (let index = 0; index < partDirs.length; index += 1) {
    const dir = partDirs[index]!;
    for (const child of await listDirectories(dir)) { partDirs.push(child); await add(child); }
  }
  const lessonsRoot = resolve(root, "lessons");
  await add(lessonsRoot);
  for (const lessonDir of await listDirectories(lessonsRoot)) {
    await add(lessonDir);
    await add(resolve(lessonDir, "blocks"));
  }
  return [...dirs];
}

export function watchWorkbookContent(
  contentRoot: string,
  onChange: () => void,
  onError: (error: Error) => void,
  options: ContentWatchOptions = {},
): ContentWatch {
  const root = resolve(contentRoot);
  const watchFactory = options.watchFactory ?? defaultWatchFactory;
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const subscriptions = new Map<string, ContentWatchSubscription>();
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let scanTail: Promise<void> = Promise.resolve();

  const report = (error: unknown) => onError(error instanceof Error ? error : new Error(String(error)));
  const scheduleChange = () => {
    if (closed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      if (!closed) onChange();
    }, debounceMs);
  };

  const subscribe = (path: string) => {
    if (closed || subscriptions.has(path)) return;
    try {
      const subscription = watchFactory(path, (_eventType, filename) => {
        if (closed) return;
        if (filename === null) { scheduleChange(); void rescan(); return; }
        const name = Buffer.isBuffer(filename) ? filename.toString("utf8") : filename;
        const candidate = resolve(path, name);
        void rescan();
        if (isAuthoredWorkbookMarkdown(root, candidate)) scheduleChange();
      });
      subscription.on?.("error", report);
      subscriptions.set(path, subscription);
    } catch (error) {
      report(error);
    }
  };

  const rescan = async (): Promise<void> => {
    scanTail = scanTail.then(async () => {
      if (closed) return;
      for (const dir of await collectWatchDirectories(root)) subscribe(dir);
    }).catch(report);
    return scanTail;
  };

  void rescan();

  return {
    rescan,
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      for (const subscription of subscriptions.values()) subscription.close();
      subscriptions.clear();
    },
  };
}
