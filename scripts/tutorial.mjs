#!/usr/bin/env node
import { stderr } from "node:process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { npmCommand, runWithTutorialEnvironment } from "./run-command.mjs";

export function tutorialArguments(argumentsForEngine) {
  return ["run", "--workspace=tutorial-engine", "dev", "--", ".", ...argumentsForEngine];
}

async function main() {
  const exitCode = await runWithTutorialEnvironment(npmCommand, tutorialArguments(process.argv.slice(2))).catch((error) => {
    stderr.write(`Unable to start the tutorial: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  });
  process.exitCode = exitCode;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
