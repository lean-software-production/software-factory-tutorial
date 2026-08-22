#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadWorkbook, type LoadedWorkbook } from "./load.js";

// This file lives at tutorial-engine/src/workbook/check.ts; the workbook is
// authored at the repository root, three directories up from here. Resolving
// the default target from this file's own location (rather than from
// `process.cwd()`) means `check:workbook` finds workbook.md no matter which
// directory `npm run` was invoked from, including from the tutorial-engine
// workspace itself.
const REPOSITORY_ROOT = resolve(fileURLToPath(import.meta.url), "../../../..");

export interface WorkbookCheckDependencies {
  load?: (target: string) => Promise<LoadedWorkbook>;
  writeLine?: (message: string) => void;
  writeError?: (message: string) => void;
}

/**
 * One-shot structural check for a workbook. It wraps `loadWorkbook()` — the
 * same loader the server uses — so no validation is duplicated here: a
 * malformed workbook fails exactly where the server would fail to load it.
 */
export async function runWorkbookCheck(argv: readonly string[], dependencies: WorkbookCheckDependencies = {}): Promise<number> {
  const load = dependencies.load ?? loadWorkbook;
  const writeLine = dependencies.writeLine ?? console.log;
  const writeError = dependencies.writeError ?? console.error;

  const target = argv[0] ?? REPOSITORY_ROOT;
  let workbook: LoadedWorkbook;
  try {
    workbook = await load(target);
  } catch (error) {
    writeError(error instanceof Error ? error.message : String(error));
    return 1;
  }

  const partCount = new Set(
    workbook.chapters.map((chapter) => chapter.partNumber).filter((partNumber): partNumber is number => partNumber !== undefined),
  ).size;
  writeLine(`${workbook.identity.title}: ${workbook.chapters.length} lesson(s), ${partCount} part(s).`);
  return 0;
}

async function main(): Promise<void> {
  process.exitCode = await runWorkbookCheck(process.argv.slice(2));
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath && resolve(fileURLToPath(import.meta.url)) === invokedPath) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
