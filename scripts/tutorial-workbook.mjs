#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { stderr } from "node:process";
import { pathToFileURL, fileURLToPath } from "node:url";

export const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
export const tutorialDirectory = resolve(repositoryRoot, "tutorial");
export const tutorialEngineDirectory = resolve(repositoryRoot, "tutorial-engine");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const WORKBOOK_USAGE = "Usage: tutorial-workbook [--session <id> | --lesson <id>] [--port 4310] [--host 0.0.0.0] [--watch] [--no-open]";

export function trustedNodeRuntimeProvision(root = repositoryRoot) {
  return {
    mounts: [
      { source: resolve(root, "node_modules"), target: "node_modules", readonly: true }
    ]
  };
}

export function tutorialWorkbookArguments(argumentsForEngine) {
  return [tutorialDirectory, ...argumentsForEngine];
}

function wantsHelp(argumentsForEngine) {
  return argumentsForEngine.includes("--help") || argumentsForEngine.includes("-h");
}

function runNpmScript(script) {
  const build = spawnSync(npmCommand, ["run", "--workspace=tutorial-engine", script], {
    cwd: repositoryRoot,
    stdio: "inherit"
  });
  if (build.error) throw new Error(`Unable to run ${script}: ${build.error.message}`);
  if (build.status !== 0) {
    process.exitCode = build.status ?? 1;
    return false;
  }
  return true;
}

function buildWorkbookRuntime() {
  return runNpmScript("build");
}

export async function main(argumentsForEngine = process.argv.slice(2)) {
  if (wantsHelp(argumentsForEngine)) { console.log(WORKBOOK_USAGE); return undefined; }
  if (!buildWorkbookRuntime()) return undefined;
  const { runWorkbookCli } = await import(pathToFileURL(resolve(tutorialEngineDirectory, "dist/workbook/cli.js")).href);
  return runWorkbookCli(tutorialWorkbookArguments(argumentsForEngine), {
    packageDirectory: tutorialEngineDirectory,
    runtimeProvision: trustedNodeRuntimeProvision(repositoryRoot)
  });
}

if (import.meta.main) {
  await main().catch((error) => {
    stderr.write(`Unable to start the workbook tutorial: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
