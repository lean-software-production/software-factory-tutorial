#!/usr/bin/env node
// Runs every quality check and prints all of their output, even when an earlier one
// fails. A reviewer judging several success criteria at once needs the whole picture
// from a single run, not just the first failure. Exits non-zero if any check failed.
import { spawnSync } from "node:child_process";

const CHECKS = [
  { name: "eslint", command: "eslint", args: ["src"], reports: "complexity, size, and duplicated branches" },
  { name: "knip", command: "knip", args: [], reports: "unused files, exports, and dependencies" }
];

const failures = [];
for (const check of CHECKS) {
  console.log(`\n── ${check.name}: ${check.reports} ──`);
  // npm run puts node_modules/.bin on PATH; Windows needs a shell to find the .cmd shim.
  const { status, error } = spawnSync(check.command, check.args, { stdio: "inherit", shell: process.platform === "win32" });
  if (error) {
    console.log(`${check.name} could not run: ${error.message}`);
    failures.push(check.name);
  } else if (status !== 0) {
    failures.push(check.name);
  } else {
    console.log(`${check.name}: no findings.`);
  }
}

console.log(failures.length === 0
  ? "\nAll quality checks passed."
  : `\nFindings reported by: ${failures.join(", ")}. Each finding names a seam worth refactoring.`);
process.exit(failures.length === 0 ? 0 : 1);
