#!/usr/bin/env node
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { stderr } from "node:process";
import { fileURLToPath } from "node:url";
import { runWithTutorialEnvironment } from "./run-command.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

async function main() {
  await access(resolve(repositoryRoot, "node_modules/.bin/pi"));
  return runWithTutorialEnvironment("bash", ["factory/factory.sh"]);
}

const exitCode = await main().catch((error) => {
  const message = error && typeof error === "object" && error.code === "ENOENT"
    ? "Project-local Pi is unavailable. Run 'npm install'."
    : error instanceof Error ? error.message : String(error);
  stderr.write(`Unable to start the factory: ${message}\n`);
  return 1;
});
process.exitCode = exitCode;
