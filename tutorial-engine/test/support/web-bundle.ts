/**
 * Freshness of the built workbook browser bundle.
 *
 * The browser tests serve `dist/web-workbook/`, and a built bundle says nothing about which sources
 * produced it. Inside `npm run check` that is harmless, because `build:web:workbook` runs
 * immediately before. Run on its own — which is exactly what someone debugging a failure does — a
 * browser test used to drive whatever bundle happened to be on disk, so it could fail an assertion
 * that the current sources satisfy and only the old bundle breaks. That has already cost a real
 * afternoon: a bundle built before the polling-to-SSE rework failed the assertion that polling had
 * stopped, and read as a regression in freshly merged work.
 *
 * Modification times answer the only question worth asking before serving the bundle: was it built
 * after the last change to the files vite reads?
 */
import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** This file lives at `tutorial-engine/test/support/web-bundle.ts`. */
export const ENGINE_ROOT = resolve(fileURLToPath(import.meta.url), "../../..");

/** Where `npm run build:web:workbook` writes, relative to the engine root. */
export const WEB_BUNDLE_DIRECTORY = "dist/web-workbook";

/**
 * What vite reads to produce that bundle, relative to the engine root.
 *
 * `src/` is listed whole rather than as the handful of modules `web-workbook/` imports today,
 * because an import added tomorrow must not quietly fall outside this comparison. The cost of the
 * wider net is a rebuild that was not strictly needed; the cost of the narrower one is the false
 * failure this exists to prevent.
 */
export const WEB_BUNDLE_SOURCES = ["web-workbook", "src", "vite.config.ts", "package.json"] as const;

export type WebBundleStatus = "missing" | "stale" | "fresh";

export interface WebBundleReport {
  readonly status: WebBundleStatus;
  /** Absolute path of the bundle directory this report describes. */
  readonly bundle: string;
  /** One line naming the staleness, suitable for printing before anything else runs. */
  readonly message: string;
  readonly builtAtMs?: number;
  /** Engine-relative path of the source that outdates the bundle, when one does. */
  readonly changedSource?: string;
}

export interface EnsureWebBundleDependencies {
  readonly inspect?: (engineRoot: string) => WebBundleReport;
  readonly build?: (engineRoot: string) => void;
  readonly writeLine?: (message: string) => void;
}

interface FileTime {
  readonly path: string;
  readonly mtimeMs: number;
}

function walk(path: string, visit: (file: string, mtimeMs: number) => void): void {
  let entry;
  try { entry = statSync(path); } catch { return; }
  if (entry.isFile()) { visit(path, entry.mtimeMs); return; }
  if (!entry.isDirectory()) return;
  for (const child of readdirSync(path)) walk(join(path, child), visit);
}

function extremeFileTime(paths: readonly string[], preferCandidate: (candidateMs: number, incumbentMs: number) => boolean): FileTime | undefined {
  let found: FileTime | undefined;
  for (const path of paths) {
    walk(path, (file, mtimeMs) => {
      if (!found || preferCandidate(mtimeMs, found.mtimeMs)) found = { path: file, mtimeMs };
    });
  }
  return found;
}

/** Reports whether `dist/web-workbook/` exists and was built after every source vite reads. */
export function inspectWebBundle(engineRoot: string = ENGINE_ROOT): WebBundleReport {
  const bundle = resolve(engineRoot, WEB_BUNDLE_DIRECTORY);
  // The oldest file in the bundle dates the build. Vite empties the directory first, so every file
  // in it was written by the same run, and the minimum cannot overstate how recent that run was.
  const built = extremeFileTime([bundle], (candidateMs, incumbentMs) => candidateMs < incumbentMs);
  if (!built) return { status: "missing", bundle, message: `No workbook bundle at ${bundle}.` };

  const sources = WEB_BUNDLE_SOURCES.map((entry) => resolve(engineRoot, entry));
  const changed = extremeFileTime(sources, (candidateMs, incumbentMs) => candidateMs > incumbentMs);
  if (changed && changed.mtimeMs > built.mtimeMs) {
    const changedSource = relative(engineRoot, changed.path);
    return {
      status: "stale",
      bundle,
      builtAtMs: built.mtimeMs,
      changedSource,
      message: `The workbook bundle in ${WEB_BUNDLE_DIRECTORY} is stale: it was built at ${new Date(built.mtimeMs).toISOString()}, and ${changedSource} changed at ${new Date(changed.mtimeMs).toISOString()}.`,
    };
  }

  return {
    status: "fresh",
    bundle,
    builtAtMs: built.mtimeMs,
    message: `The workbook bundle in ${WEB_BUNDLE_DIRECTORY} was built at ${new Date(built.mtimeMs).toISOString()}, after every source vite reads.`,
  };
}

function buildWebBundle(engineRoot: string): void {
  execFileSync("npm", ["run", "build:web:workbook"], { cwd: engineRoot, stdio: "inherit" });
}

/**
 * Guarantees the caller is about to serve a bundle built from the current sources.
 *
 * A fresh bundle costs one directory sweep and no build, which is why `npm run check` — where
 * `build:web:workbook` has just run — still builds the bundle exactly once.
 */
export function ensureFreshWebBundle(engineRoot: string = ENGINE_ROOT, dependencies: EnsureWebBundleDependencies = {}): WebBundleReport {
  const inspect = dependencies.inspect ?? inspectWebBundle;
  const build = dependencies.build ?? buildWebBundle;
  const writeLine = dependencies.writeLine ?? ((message: string) => { console.log(message); });

  const before = inspect(engineRoot);
  if (before.status === "fresh") return before;

  writeLine(`${before.message} Building it first, so this run tests the current sources.`);
  build(engineRoot);

  const after = inspect(engineRoot);
  if (after.status !== "fresh") throw new Error(`The workbook bundle is still not current after building it. ${after.message}`);
  writeLine(`Built the workbook bundle in ${WEB_BUNDLE_DIRECTORY}.`);
  return after;
}
