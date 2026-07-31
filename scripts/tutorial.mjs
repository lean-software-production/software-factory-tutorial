#!/usr/bin/env node
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { stderr } from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

export function tutorialArguments(argumentsForEngine) {
  return ["run", "--workspace=tutorial-engine", "dev", "--", ".", ...argumentsForEngine];
}

async function main() {
  const child = spawn(npmCommand, tutorialArguments(process.argv.slice(2)), {
    cwd: repositoryRoot,
    stdio: "inherit"
  });
  child.once("error", (error) => {
    stderr.write(`Unable to start the tutorial: ${error.message}\n`);
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => { process.exitCode = signal ? 1 : code ?? 1; });
}

if (import.meta.main) await main();
