#!/usr/bin/env node
// Runs every quality check and prints all of their output, even when an earlier one
// fails. A validator judging several success criteria at once needs the whole picture
// from a single run, not just the first failure. Exits non-zero if any check failed.
//
// Runnable as `node scripts/quality.mjs` as well as through `npm run quality`: it
// resolves each tool itself rather than relying on the PATH that npm sets up, and npm
// appends its own "command failed" block to any non-zero exit, which reads like the
// script broke rather than like the code has findings.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CHECKS = [
  { name: "eslint", args: ["src"], reports: "complexity, size, and duplicated branches" },
  { name: "knip", args: [], reports: "unused files, exports, and dependencies" }
];

// Always measure this package, whatever directory the command was run from: both tools
// resolve their configuration and their targets relative to the working directory.
const packageDirectory = dirname(dirname(fileURLToPath(import.meta.url)));

// Walk up looking for the tool: npm hoists workspace dependencies to the repository root.
function findTool(name) {
  const executable = process.platform === "win32" ? `${name}.cmd` : name;
  let directory = dirname(fileURLToPath(import.meta.url));
  for (let parent = dirname(directory); ; parent = dirname(directory)) {
    const candidate = join(directory, "node_modules", ".bin", executable);
    if (existsSync(candidate)) return candidate;
    if (parent === directory) return undefined;
    directory = parent;
  }
}

const failures = [];
for (const check of CHECKS) {
  console.log(`\n── ${check.name}: ${check.reports} ──`);
  const tool = findTool(check.name);
  if (!tool) {
    console.log(`${check.name} is not installed. Run npm install.`);
    failures.push(check.name);
    continue;
  }
  // Each check reports its own findings; only the closing summary speaks for all of them,
  // so a quiet check stays quiet rather than being announced twice.
  const { status, error } = spawnSync(tool, check.args, { cwd: packageDirectory, stdio: "inherit", shell: process.platform === "win32" });
  if (error) {
    console.log(`${check.name} could not run: ${error.message}`);
    failures.push(check.name);
  } else if (status !== 0) {
    failures.push(check.name);
  }
}

console.log(failures.length === 0
  ? "\nAll quality checks passed."
  : `\nFindings reported by: ${failures.join(", ")}.`);
process.exit(failures.length === 0 ? 0 : 1);
