#!/usr/bin/env node
/**
 * Approve the screenshots the visual check last rejected.
 *
 * Approval testing keeps two files per case: the .approved.png committed to the repository, and
 * the .received.png a failing run leaves beside it. Approving is just renaming one over the other,
 * after you have looked at them — this script does the renaming, not the looking.
 */
import { readdir, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const visualRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../tutorial-engine/test/visual");

let entries;
try { entries = await readdir(visualRoot); }
catch { console.log("Nothing to approve: no test/visual directory yet."); process.exit(0); }

const received = entries.filter((entry) => entry.endsWith(".received.png"));
if (received.length === 0) {
  console.log("Nothing to approve: no received screenshots are waiting.");
  process.exit(0);
}

for (const file of received) {
  const approved = file.replace(/\.received\.png$/, ".approved.png");
  await rename(resolve(visualRoot, file), resolve(visualRoot, approved));
  console.log(`Approved ${approved}`);
}
console.log(`\n${received.length} screenshot(s) approved. Commit them with the change that caused them.`);
