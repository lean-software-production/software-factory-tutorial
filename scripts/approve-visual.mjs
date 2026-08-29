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
import { pathToFileURL, fileURLToPath } from "node:url";
import { devcontainerState } from "../tutorial-engine/scripts/test-visual.mjs";

export const APPROVAL_ENVIRONMENT_MESSAGE =
  "Refusing to approve visual screenshots outside the repository devcontainer. Open a devcontainer terminal, then run `npm run approve:visual`.";

export function visualApprovalRoot(scriptDirectory = dirname(fileURLToPath(import.meta.url))) {
  return resolve(scriptDirectory, "../tutorial-engine/test/visual");
}

export function assertCanonicalApprovalEnvironment(state = devcontainerState()) {
  if (!state.canonical) throw new Error(APPROVAL_ENVIRONMENT_MESSAGE);
}

export async function approveVisual({ visualRoot = visualApprovalRoot(), state = devcontainerState(), log = console.log } = {}) {
  assertCanonicalApprovalEnvironment(state);

  let entries;
  try {
    entries = await readdir(visualRoot);
  } catch {
    log("Nothing to approve: no test/visual directory yet.");
    return 0;
  }

  const received = entries.filter((entry) => entry.endsWith(".received.png"));
  if (received.length === 0) {
    log("Nothing to approve: no received screenshots are waiting.");
    return 0;
  }

  for (const file of received) {
    const approved = file.replace(/\.received\.png$/, ".approved.png");
    await rename(resolve(visualRoot, file), resolve(visualRoot, approved));
    log(`Approved ${approved}`);
  }
  log(`\n${received.length} screenshot(s) approved. Commit them with the change that caused them.`);
  return received.length;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await approveVisual();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
