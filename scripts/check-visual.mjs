#!/usr/bin/env node
/**
 * Runs the real-browser visual affordance validation, but only when it can tell you something.
 *
 * The check needs Chromium and a built workbook bundle, which is too much to spend on every
 * `npm run check`. Most changes cannot move a pixel of the workbook UI, so this compares the
 * branch against its merge base and runs the validation only when the visual surface changed.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Everything that decides what the screenshots contain.
 *
 * The test this gates serves the *real* workbook server to Chromium, so the visual surface is
 * wider than the client. It is the client, the server code that composes the text the client
 * renders, the fixture that text is composed from, the configuration that builds the bundle, the
 * image that supplies the fonts and Chromium's system libraries, and the pinned versions of the
 * libraries that do the drawing.
 *
 * The test to apply when extending this list is therefore not "is this UI code?" but "could
 * changing this move a pixel in an approved screenshot?". If it could, it belongs here — a skipped
 * run is supposed to mean nothing visual changed, not that one directory was left alone.
 */
const VISUAL_SURFACE = [
  // The client under test: components, styles, and the scroll behaviour itself.
  "tutorial-engine/web-workbook/",
  // The harness, the approved screenshots, and the workbook the fixture server is fed.
  "tutorial-engine/test/visual-affordances.mts",
  "tutorial-engine/test/visual/",
  "tutorial-engine/test/fixtures/visual-workbook/",
  "tutorial-engine/test/support/fake-tutors.ts",
  // The server's text composition. The harness calls startWorkbookServer, so what the browser
  // shows is the server's own projection: change how a block's markdown is loaded, composed, or
  // ordered and the screenshot changes with no diff under web-workbook/ at all.
  "tutorial-engine/src/workbook/authored-text.ts",
  "tutorial-engine/src/workbook/workbook-blocks.ts",
  "tutorial-engine/src/workbook/load.ts",
  "tutorial-engine/src/workbook/workflow.ts",
  // Build configuration for the bundle the browser loads.
  "tutorial-engine/vite.config.ts",
  // Fonts and Chromium's shared libraries decide how text rasterises.
  ".devcontainer/Dockerfile",
  // The libraries that draw: @xterm/xterm the terminal band, @codemirror/view the editor band,
  // highlight.js and rehype-highlight the code colours, react-dom the DOM, mermaid the diagrams,
  // and playwright which Chromium takes the shot. They are pinned to exact versions in this file
  // so that bumping one is an edit here, which this guard sees, rather than a change confined to
  // package-lock.json, which it deliberately does not watch: listing the lockfile would fire the
  // suite on every dependency change, and most of them cannot move a pixel.
  "tutorial-engine/package.json",
  // The guard itself: a change to what counts as visual is worth one confirming run.
  "scripts/check-visual.mjs",
];

function git(args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

function changedFiles() {
  try { git(["rev-parse", "--git-dir"]); }
  catch { return { files: undefined, reason: "not a git repository" }; }

  let base;
  for (const candidate of ["origin/main", "main"]) {
    try { base = git(["merge-base", "HEAD", candidate]); break; }
    catch { /* try the next candidate */ }
  }
  const files = new Set();
  // Committed on this branch, plus anything not yet committed.
  if (base) for (const file of git(["diff", "--name-only", `${base}...HEAD`]).split("\n")) if (file) files.add(file);
  for (const file of git(["status", "--porcelain"]).split("\n")) {
    const path = file.slice(3).trim().split(" -> ").pop();
    if (path) files.add(path);
  }
  return { files: [...files], reason: base ? undefined : "no merge base against main; judging by uncommitted changes alone" };
}

const { files, reason } = changedFiles();
if (reason) console.log(`Visual check: ${reason}.`);

// This check is a heavyweight, optional-dependency gate. If relevance cannot be established there
// is nothing to be gained by running it, and a clone without git history should still be able to
// run `npm run check`.
if (!files) {
  console.log("Visual check skipped: cannot tell what changed.");
  process.exit(0);
}

const touched = files.filter((file) => VISUAL_SURFACE.some((prefix) => file.startsWith(prefix)));
if (touched.length === 0) {
  console.log("Visual check skipped: no change to the workbook's visual surface.");
  process.exit(0);
}
console.log(`Visual check: ${touched.length} file(s) on the visual surface changed.`);

if (process.env.SKIP_VISUAL_CHECK) {
  console.log("Visual check skipped: SKIP_VISUAL_CHECK is set.");
  process.exit(0);
}

const engine = resolve(root, "tutorial-engine");
try { await import("playwright"); }
catch {
  console.error([
    "Visual check needs Playwright, and the workbook's visual surface changed.",
    "  npm install --no-save -D playwright && npx playwright install chromium",
    "Set SKIP_VISUAL_CHECK=1 to bypass this deliberately.",
  ].join("\n"));
  process.exit(1);
}

if (!existsSync(resolve(engine, "dist/web-workbook/index.html"))) {
  console.log("Visual check: building the workbook bundle first.");
  execFileSync("npm", ["run", "--workspace=tutorial-engine", "build:web:workbook"], { cwd: root, stdio: "inherit" });
}

execFileSync("npx", ["tsx", "test/visual-affordances.mts", ...process.argv.slice(2)], { cwd: engine, stdio: "inherit" });
