#!/usr/bin/env npx tsx
/**
 * Real-browser validation for the workbook's scroll-driven visual affordances.
 *
 * JSDOM has no layout engine, so the unit tests can only exercise the geometry maths against
 * fabricated rects and assert the stylesheet as a string. Neither notices if the selector stops
 * matching, a later rule wins, or the scroll listener never fires. This harness serves the built
 * workbook UI to Chromium and measures what a learner would actually see.
 *
 * It runs the real workbook server against the fixture workbook in test/fixtures/visual-workbook,
 * copied to a temporary directory, with a tutor that answers from a queue instead of a model. The
 * state the browser renders is therefore the server's own projection: a fixture that drifted from
 * what the server emits could otherwise keep these checks passing against a fiction.
 *
 * Screenshots are approval tests. Each one is compared against its .approved.png; a mismatch
 * writes the .received.png beside it and fails, so the two can be opened side by side. Approve a
 * deliberate change with `npm run approve:visual`, which renames received over approved.
 *
 *   npx tsx test/visual-affordances.mts    validate
 */
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import React, { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { startWorkbookServer } from "../src/workbook/server.js";
import type { TerminalPty } from "../src/workbook/terminal.js";
import type { PracticeFeedbackTone } from "../web-workbook/src/practice-feedback-bar.js";
import { QueuedMainTutor } from "./support/fake-tutors.js";

const webRoot = resolve(import.meta.dirname, "../dist/web-workbook");
const fixtureRoot = resolve(import.meta.dirname, "fixtures/visual-workbook");
const approvalRoot = resolve(import.meta.dirname, "visual");

/** A differing pixel must differ by more than this per channel; antialiasing moves by less. */
const CHANNEL_TOLERANCE = 12;
/** Share of pixels allowed to differ before an approved screenshot counts as changed. */
const PIXEL_BUDGET = 0.005;

/** The tutor's verdict on the first editor draft, which the welded feedback panel then shows. */
const EDITOR_FEEDBACK = "Name the acceptance marker in the answer, then pause for another review.";

/** The terminal never runs anything here; it only has to exist and echo. */
class EchoPty implements TerminalPty {
  #data?: (data: string) => void;
  write(data: string): void { this.#data?.(`\r\nran:${data}`); }
  resize(): void {}
  kill(): void {}
  onData(callback: (data: string) => void): void { this.#data = callback; }
  onExit(): void {}
}

type FeedbackViewport = { name: "desktop" | "narrow"; width: number; height: number };

const FEEDBACK_VIEWPORTS: readonly FeedbackViewport[] = [
  { name: "desktop", width: 1280, height: 900 },
  { name: "narrow", width: 390, height: 900 },
];
const EXPECTED_FEEDBACK_STATES = [
  "editor-reviewing", "editor-updating", "editor-feedback", "editor-fatal", "editor-success",
  "terminal-running", "terminal-checking", "terminal-feedback", "terminal-fatal", "terminal-success",
] as const;
const EDITOR_RETAINED_FEEDBACK = "Add the acceptance marker and explain why that proves the change is complete.";
const TERMINAL_FEEDBACK = "Run the command again after fixing the failing assertion.";
const FATAL_MESSAGE = "The AI tutor provider is unavailable. Fix or reconnect the provider, then restart this workbook to continue.";
const VISUAL_EDITOR_PATH = "factory/answer.md";
const TERMINAL_TRANSCRIPT = "$ npm test -- --runInBand\nPASS visual fixture\n";

type PracticeFeedbackBarComponent = typeof import("../web-workbook/src/practice-feedback-bar.js").PracticeFeedbackBar;
let practiceFeedbackBarComponent: PracticeFeedbackBarComponent | undefined;

function feedbackBar(tone: PracticeFeedbackTone, options: { markdown?: string; status?: string; label?: string; title?: string; busy?: boolean; className: string }): ReactNode {
  if (!practiceFeedbackBarComponent) throw new Error("PracticeFeedbackBar was not loaded before rendering the visual state gallery.");
  return createElement(practiceFeedbackBarComponent, { tone, ...options });
}

function editorTarget(): ReactNode {
  return createElement("div", { className: "editor-target" }, createElement("span", null, "Target file"), createElement("code", null, VISUAL_EDITOR_PATH));
}

function editorSurface(): ReactNode {
  return createElement("div", { className: "editor-surface", "aria-label": `Editor for ${VISUAL_EDITOR_PATH}` });
}

function editorLiveVisual(tone: PracticeFeedbackTone, options: { markdown?: string; status?: string; busy?: boolean }, disabled = false): ReactNode {
  return createElement("div", { className: "work-block editor-practice is-active", "aria-disabled": disabled ? "true" : undefined },
    editorTarget(),
    createElement("div", { className: "editor-live-surface has-feedback" },
      editorSurface(),
      feedbackBar(tone, { ...options, className: "live-block-feedback editor-feedback-overlay" }),
    ),
  );
}

function editorSuccessVisual(): ReactNode {
  return createElement("div", { className: "work-block editor-practice" },
    editorTarget(),
    feedbackBar("success", {
      label: "Unlocked",
      title: "Accepted revision unlocked the next step.",
      markdown: "The latest accepted editor draft was written to the target file.",
      className: "success-checkpoint editor-unlocked",
    }),
  );
}

function embeddedTerminalPanel(disabled = false): ReactNode {
  return createElement("div", { className: "embedded-terminal-panel" },
    createElement("span", { className: "terminal-connection-status connected", "aria-label": "Terminal connected" }),
    createElement("div", { className: "embedded-terminal", "aria-label": "Embedded terminal", "aria-disabled": disabled ? "true" : undefined, inert: disabled ? true : undefined }),
  );
}

function terminalLiveVisual(tone: PracticeFeedbackTone, options: { markdown?: string; status?: string; busy?: boolean }, disabled = false): ReactNode {
  return createElement("div", { className: "work-block terminal is-active", "aria-disabled": disabled ? "true" : undefined },
    createElement("div", { className: "terminal-live-surface has-feedback" },
      embeddedTerminalPanel(disabled),
      feedbackBar(tone, { ...options, className: "live-block-feedback terminal-feedback-overlay" }),
    ),
  );
}

function frozenTerminal(): ReactNode {
  return createElement("div", { className: "frozen-terminal", "aria-label": "Frozen terminal session" },
    createElement("pre", { className: "frozen-terminal-output" }, TERMINAL_TRANSCRIPT),
  );
}

function terminalSuccessVisual(): ReactNode {
  return createElement("div", { className: "terminal-history", "aria-label": "Completed terminal output" },
    createElement("div", { className: "terminal-completion-surface has-feedback" },
      frozenTerminal(),
      feedbackBar("success", { markdown: "Terminal accepted — the transcript proves the command passed.", className: "terminal-feedback-overlay terminal-history-complete" }),
    ),
  );
}

function fatalNotice(): ReactNode {
  return createElement("aside", { className: "workbook-fatal-notice visual-feedback-fatal-notice", role: "alert", "aria-label": "Workbook paused" },
    createElement("span", { className: "workbook-fatal-icon", "aria-hidden": "true" }, "!"),
    createElement("div", null,
      createElement("p", { className: "workbook-fatal-eyebrow" }, "Workbook paused"),
      createElement("h2", null, "Tutor unavailable"),
      createElement("p", null, FATAL_MESSAGE),
    ),
  );
}

function fatalVisual(surface: ReactNode): ReactNode {
  return createElement("div", { className: "visual-feedback-fatal-state" }, fatalNotice(), surface);
}

function feedbackCard(state: string, label: string, visual: ReactNode, welded = true): ReactNode {
  return createElement("section", { key: state, className: "visual-feedback-card", "data-feedback-state": state, "data-feedback-welded": welded ? "true" : "false" },
    createElement("p", { className: "visual-feedback-state-label" }, label),
    visual,
  );
}

function editorFeedbackCards(): ReactNode[] {
  return [
    feedbackCard("editor-reviewing", "Editor — reviewing latest revision", editorLiveVisual("status", { busy: true, status: "Reviewing your latest revision…" })),
    feedbackCard("editor-updating", "Editor — retained feedback while updating", editorLiveVisual("updating", { busy: true, markdown: EDITOR_RETAINED_FEEDBACK, status: "Updating feedback…" })),
    feedbackCard("editor-feedback", "Editor — actionable feedback", editorLiveVisual("feedback", { markdown: EDITOR_RETAINED_FEEDBACK })),
    feedbackCard("editor-fatal", "Editor — workbook paused", fatalVisual(editorLiveVisual("feedback", { markdown: EDITOR_RETAINED_FEEDBACK }, true))),
    feedbackCard("editor-success", "Editor — accepted success", editorSuccessVisual(), false),
  ];
}

function terminalFeedbackCards(): ReactNode[] {
  return [
    feedbackCard("terminal-running", "Terminal — command running", terminalLiveVisual("status", { busy: true, status: "Running…" })),
    feedbackCard("terminal-checking", "Terminal — transcript checking", terminalLiveVisual("status", { busy: true, status: "Checking…" })),
    feedbackCard("terminal-feedback", "Terminal — actionable feedback", terminalLiveVisual("feedback", { markdown: TERMINAL_FEEDBACK })),
    feedbackCard("terminal-fatal", "Terminal — workbook paused", fatalVisual(terminalLiveVisual("feedback", { markdown: TERMINAL_FEEDBACK }, true))),
    feedbackCard("terminal-success", "Terminal — accepted success", terminalSuccessVisual()),
  ];
}

function renderFeedbackGallery(): string {
  const cards = [...editorFeedbackCards(), ...terminalFeedbackCards()];
  return renderToStaticMarkup(createElement("div", { className: "shell visual-feedback-gallery-shell" },
    createElement("main", null,
      createElement("article", { className: "page visual-feedback-gallery", "data-feedback-composite": "editor-terminal" },
        createElement("header", null,
          createElement("p", { className: "section-label" }, "Canonical visual state matrix"),
          createElement("h1", null, "Editor and terminal feedback states"),
          createElement("p", { className: "visual-feedback-gallery-subtitle" }, "Feedback bars and fatal banners are photographed directly; none is masked."),
        ),
        createElement("div", { className: "visual-feedback-state-grid" }, cards),
      ),
    ),
  ));
}

const FEEDBACK_GALLERY_STYLE = `
body.visual-feedback-gallery-body {
  background: var(--ground);
}
.visual-feedback-gallery-shell {
  display: block;
  max-width: none;
  min-height: auto;
  margin: 0;
}
.visual-feedback-gallery-shell main {
  min-height: auto;
  padding: 24px;
  background-image: none;
}
.visual-feedback-gallery {
  width: min(1040px, calc(100vw - 48px));
  margin: 0 auto;
  padding: 0;
}
.visual-feedback-gallery header {
  margin-bottom: 16px;
}
.visual-feedback-gallery h1 {
  margin: 0 0 4px;
  color: var(--ink);
  font: 600 1.45rem/1.2 var(--font-display);
}
.visual-feedback-gallery-subtitle {
  margin: 0;
  color: var(--muted);
  font-size: 0.84rem;
}
.visual-feedback-state-grid {
  display: grid;
  gap: 16px;
}
@media (min-width: 900px) {
  .visual-feedback-state-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
.visual-feedback-card {
  display: grid;
  gap: 10px;
  min-width: 0;
  padding: 14px;
  border: 1px solid var(--line);
  border-radius: 13px;
  background: var(--paper);
  box-shadow: var(--shadow);
}
.visual-feedback-state-label {
  margin: 0;
  color: var(--muted);
  font-size: 0.68rem;
  font-weight: 800;
  letter-spacing: 0.11em;
  text-transform: uppercase;
}
.visual-feedback-fatal-state {
  display: grid;
  gap: 10px;
}
.visual-feedback-card .visual-feedback-fatal-notice {
  position: static;
  width: 100%;
  max-width: none;
  box-sizing: border-box;
}
.visual-feedback-card .visual-feedback-fatal-notice h2 {
  font-size: 1rem;
}
.visual-feedback-card .visual-feedback-fatal-notice p:not(.workbook-fatal-eyebrow) {
  font-size: 0.8rem;
}
.visual-feedback-card .work-block {
  margin: 0;
  padding: 0;
  border: 0;
  background: none;
  box-shadow: none;
}
.visual-feedback-card .editor-target {
  margin: 0 0 10px;
}
.visual-feedback-card .editor-surface {
  min-height: 112px;
  margin-top: 0;
}
.visual-feedback-card .editor-surface::before {
  display: block;
  padding: 14px;
  color: var(--muted);
  font: 0.82rem/1.55 var(--font-mono);
  white-space: pre-wrap;
  content: "A deterministic answer draft names the acceptance marker.";
}
.visual-feedback-card .embedded-terminal {
  height: 112px;
  min-height: 112px;
}
.visual-feedback-card .embedded-terminal::before {
  display: block;
  padding: 8px 10px;
  color: #dbe9fb;
  font: 0.82rem/1.45 var(--font-mono);
  white-space: pre-wrap;
  content: "$ npm test\\A PASS visual fixture";
}
.visual-feedback-card .frozen-terminal-output {
  min-height: 112px;
}
.visual-feedback-card .terminal-live-surface .practice-feedback-bar,
.visual-feedback-card .terminal-completion-surface .practice-feedback-bar,
.visual-feedback-card .editor-live-surface .practice-feedback-bar {
  margin-bottom: 0;
}
.visual-feedback-card .editor-unlocked {
  margin: 0;
}
@media (max-width: 840px) {
  .visual-feedback-gallery-shell main {
    padding: 18px;
  }
  .visual-feedback-gallery {
    width: 100%;
  }
  .visual-feedback-card {
    padding: 12px;
  }
}
`;

const failures: string[] = [];
function check(condition: boolean, description: string): void {
  if (!condition) failures.push(description);
}
function expectClose(actual: number, expected: number, slack: number, description: string): void {
  check(Math.abs(actual - expected) <= slack, `${description}: expected ~${expected} (±${slack}), measured ${actual}`);
}

/**
 * Compare in the browser we already have running, so an approval test needs no image dependency:
 * both PNGs go onto canvases and the pixel arrays are differenced.
 *
 * On a mismatch the received file is left on disk next to the approved one, which is what makes
 * the pair openable in a diff tool. On a match it is removed, so a stale received file always
 * means "this one is waiting on you".
 */
async function approve(page: any, name: string, shot: Buffer): Promise<void> {
  await mkdir(approvalRoot, { recursive: true });
  const approvedPath = resolve(approvalRoot, `${name}.approved.png`);
  const receivedPath = resolve(approvalRoot, `${name}.received.png`);
  const reject = async (message: string) => {
    await writeFile(receivedPath, shot);
    failures.push(message);
  };
  const accept = async () => { await rm(receivedPath, { force: true }); };

  let approved: Buffer;
  try { approved = await readFile(approvedPath); }
  catch {
    await reject(`${name}: nothing approved yet — review test/visual/${name}.received.png, then run \`npm run approve:visual\``);
    return;
  }
  const verdict = await page.evaluate(async ([a, b, tolerance]: [string, string, number]) => {
    const load = (data: string) => new Promise<HTMLImageElement>((done, fail) => {
      const image = new Image();
      image.onload = () => done(image); image.onerror = fail; image.src = `data:image/png;base64,${data}`;
    });
    const [expected, actual] = await Promise.all([load(a), load(b)]);
    if (expected.width !== actual.width || expected.height !== actual.height) {
      return { sizeMismatch: `${actual.width}x${actual.height} vs golden ${expected.width}x${expected.height}`, ratio: 1 };
    }
    const pixels = (image: HTMLImageElement) => {
      const canvas = document.createElement("canvas");
      canvas.width = image.width; canvas.height = image.height;
      canvas.getContext("2d")!.drawImage(image, 0, 0);
      return canvas.getContext("2d")!.getImageData(0, 0, image.width, image.height).data;
    };
    const [left, right] = [pixels(expected), pixels(actual)];
    let differing = 0;
    for (let index = 0; index < left.length; index += 4) {
      if (Math.abs(left[index]! - right[index]!) > tolerance
        || Math.abs(left[index + 1]! - right[index + 1]!) > tolerance
        || Math.abs(left[index + 2]! - right[index + 2]!) > tolerance) differing++;
    }
    return { sizeMismatch: undefined, ratio: differing / (left.length / 4) };
  }, [approved.toString("base64"), shot.toString("base64"), CHANNEL_TOLERANCE]);

  if (verdict.sizeMismatch) await reject(`${name}: received ${verdict.sizeMismatch}. Compare test/visual/${name}.received.png with ${name}.approved.png`);
  else if (verdict.ratio > PIXEL_BUDGET) await reject(`${name}: ${(verdict.ratio * 100).toFixed(2)}% of pixels differ (budget ${(PIXEL_BUDGET * 100).toFixed(2)}%). Compare test/visual/${name}.received.png with ${name}.approved.png, then \`npm run approve:visual\` to accept`);
  else await accept();
}

async function showFeedbackGallery(page: any, viewport: FeedbackViewport): Promise<void> {
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
  await page.evaluate((markup: string) => {
    document.body.className = "visual-feedback-gallery-body";
    document.body.innerHTML = markup;
    window.scrollTo(0, 0);
  }, renderFeedbackGallery());
  await page.evaluate(async () => { await document.fonts.ready; });
  await page.waitForTimeout(80);
}

async function assertFeedbackGalleryCoverage(page: any, viewport: FeedbackViewport): Promise<void> {
  const result = await page.evaluate(() => {
    const details = [...document.querySelectorAll<HTMLElement>(".visual-feedback-card")].map((card) => {
      const bar = card.querySelector<HTMLElement>(".practice-feedback-bar");
      const fatal = card.querySelector<HTMLElement>(".workbook-fatal-notice");
      const workSurface = card.querySelector<HTMLElement>(".editor-surface, .embedded-terminal-panel, .frozen-terminal");
      const barRect = bar?.getBoundingClientRect();
      const fatalRect = fatal?.getBoundingClientRect();
      const surfaceRect = workSurface?.getBoundingClientRect();
      return {
        state: card.dataset.feedbackState ?? "",
        welded: card.dataset.feedbackWelded !== "false",
        hasBar: Boolean(bar && barRect && barRect.width > 0 && barRect.height > 0),
        hasFatal: Boolean(fatal && fatalRect && fatalRect.width > 0 && fatalRect.height > 0),
        text: `${fatal?.innerText.trim() ?? ""} ${bar?.innerText.trim() ?? ""}`.trim(),
        gap: barRect && surfaceRect ? Math.round(barRect.top - surfaceRect.bottom) : null,
        widthDelta: barRect && surfaceRect ? Math.round(barRect.width - surfaceRect.width) : null,
        leftDelta: barRect && surfaceRect ? Math.round(barRect.left - surfaceRect.left) : null,
      };
    });
    return { states: details.map((detail) => detail.state), details, viewportWidth: window.innerWidth };
  });

  expectClose(result.viewportWidth, viewport.width, 0, `feedback composite ${viewport.name}: viewport width`);
  for (const expected of EXPECTED_FEEDBACK_STATES) {
    check(result.states.includes(expected), `feedback composite ${viewport.name}: missing state ${expected}`);
  }
  check(result.states.length === EXPECTED_FEEDBACK_STATES.length, `feedback composite ${viewport.name}: expected ${EXPECTED_FEEDBACK_STATES.length} states, found ${result.states.length}`);
  for (const detail of result.details) {
    check(detail.hasBar, `feedback composite ${viewport.name}/${detail.state}: feedback bar is not visible`);
    check(detail.text.length > 0, `feedback composite ${viewport.name}/${detail.state}: learner-visible state text is empty`);
    if (detail.state.endsWith("-fatal")) check(detail.hasFatal, `feedback composite ${viewport.name}/${detail.state}: fatal banner is not visible`);
    if (detail.welded) {
      if (detail.gap === null || detail.widthDelta === null || detail.leftDelta === null) {
        failures.push(`feedback composite ${viewport.name}/${detail.state}: could not compare feedback bar with work surface`);
      } else {
        expectClose(detail.gap, 0, 1, `feedback composite ${viewport.name}/${detail.state}: weld gap`);
        expectClose(detail.widthDelta, 0, 1, `feedback composite ${viewport.name}/${detail.state}: bar width versus surface`);
        expectClose(detail.leftDelta, 0, 1, `feedback composite ${viewport.name}/${detail.state}: bar left edge versus surface`);
      }
    }
  }
}

async function validatePracticeFeedbackVisuals(page: any): Promise<void> {
  await page.addStyleTag({ content: FEEDBACK_GALLERY_STYLE });
  for (const viewport of FEEDBACK_VIEWPORTS) {
    await showFeedbackGallery(page, viewport);
    await assertFeedbackGalleryCoverage(page, viewport);
    const gallery = page.locator('.visual-feedback-gallery[data-feedback-composite="editor-terminal"]');
    await approve(page, `practice-feedback-${viewport.name}`, await gallery.screenshot());
  }
}

async function main(): Promise<void> {
  try { await readFile(resolve(webRoot, "index.html")); }
  catch { throw new Error("Build the workbook UI first: npm run --workspace=tutorial-engine build:web:workbook"); }
  const moduleName = "playwright";
  let playwright: { chromium: { launch(options?: unknown): Promise<any> } };
  try { playwright = await import(moduleName) as typeof playwright; }
  catch { throw new Error("Visual validation needs Playwright. Install it with `npm install --no-save -D playwright`, then `npx playwright install chromium`."); }

  // The TSX runtime used by this Node-side visual harness compiles browser components with the
  // classic React JSX global, while the production Vite build uses the automatic JSX runtime.
  // Load the feedback component after installing that global so its Markdown dependency can render
  // server-side without importing the terminal/editor packages that need a browser bundler.
  (globalThis as typeof globalThis & { React: typeof React }).React = React;
  practiceFeedbackBarComponent = (await import("../web-workbook/src/practice-feedback-bar.js")).PracticeFeedbackBar;

  // The embedded terminal refuses to start without a key. Nothing here reaches a model — the
  // tutors are fakes and the pty only echoes — so a placeholder is what the engine's own server
  // tests use too.
  process.env.OPENCODE_API_KEY ??= "visual-affordances-fixture-key";

  // Copy the fixture so the server's own writes never touch the committed workbook.
  const workspace = await mkdtemp(resolve(tmpdir(), "visual-affordances-"));
  await cp(fixtureRoot, workspace, { recursive: true });
  await mkdir(resolve(workspace, "workspaces/refactor-line/factory"), { recursive: true });
  await writeFile(resolve(workspace, "workspaces/refactor-line/factory/answer.md"), "A first draft of the answer.\n");

  // The first editor draft draws feedback, which is what the welded panel has to show; the second
  // is accepted, which is how the terminal block becomes the active surface.
  const mainTutor = new QueuedMainTutor(
    { outcome: "feedback", message: EDITOR_FEEDBACK },
    { outcome: "accepted", message: "Editor draft accepted." },
  );
  const server = await startWorkbookServer({
    target: workspace,
    webRoot,
    port: 0,
    mainTutor,
        terminalPtyFactory: () => new EchoPty(),
    terminalDebounceMs: 1,
  });
  const browser = await playwright.chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1, reducedMotion: "reduce" });
    // tsx compiles with esbuild's keepNames, which references a __name helper. Functions handed to
    // page.evaluate are serialized without it, so provide it inside the page.
    await page.addInitScript(() => { (globalThis as unknown as { __name: unknown }).__name = (value: unknown) => value; });
    await page.goto(server.url);
    // Golden masters compare pixels, so nothing may still be easing when the shot is taken.
    await page.addStyleTag({ content: "*, *::before, *::after { transition: none !important; animation: none !important; caret-color: transparent !important; }" });
    // Walk the authored preamble with the Continue control, but only until the block after
    // orientation has been revealed. Clicking past that would promote by button and never exercise
    // the reading line, which is the affordance under test.
    const successorSelector = 'section[id$="--editing"]';
    for (let step = 0; step < 6; step++) {
      if (await page.locator(successorSelector).count() > 0) break;
      const button = page.locator("button").filter({ hasText: /^Continue/ }).first();
      if (await button.count() === 0) break;
      await button.click({ force: true });
      await page.waitForTimeout(500);
    }
    check(await page.locator(successorSelector).count() > 0, "reading line: the successor block was never revealed by the Continue control");

    // ---- Affordance 1: the reading line promotes the block it passes -------------------------
    // Completion is read back from the server rather than from a counter in this file, so the
    // assertion is about what was actually recorded.
    // The server records canonical ids (lesson--001-affordances--orientation), not the authored
    // block name, so match on the suffix or the assertion can never be true.
    const orientationCompleted = async (): Promise<boolean> =>
      page.evaluate(async () => ((await (await fetch("api/workbook/state")).json()).progress.completedBlocks ?? [])
        .some((id: string) => id.endsWith("--orientation")));

    await page.evaluate(() => window.scrollTo(0, 0));
    check(!(await orientationCompleted()), "reading line: orientation completed before it reached the reading line");
    // The observer watches the ready successor, not the active block: when the successor's top
    // crosses READING_LINE_TOP_PX (120), the block the learner has scrolled past is completed.
    const successorTop = await page.evaluate((selector: string) => {
      const element = document.querySelector(selector);
      return element ? element.getBoundingClientRect().top + window.scrollY : null;
    }, successorSelector);
    check(successorTop !== null, "reading line: no successor element to scroll past the line");
    await page.evaluate((target: number) => window.scrollTo(0, target), (successorTop ?? 0) - 60);
    const promoted = await page.waitForFunction(() => Boolean(document.querySelector(".current-activity-band")), undefined, { timeout: 10_000 })
      .then(() => true)
      .catch(() => { failures.push("reading line: scrolling the successor past the line did not promote the block behind it"); return false; });
    check(await orientationCompleted(), "reading line: crossing the line did not complete the orientation block");

    // ---- Affordance 2: the activity band expands as it rises ---------------------------------
    // Both practice blocks ride the same band, so the same measurements must hold for each.
    const validateBand = async (label: string) => {
      const layout = await page.evaluate(() => {
        const band = document.querySelector(".current-activity-band") as HTMLElement;
        let top = 0; let current: HTMLElement | null = band;
        while (current) { top += current.offsetTop; current = current.offsetParent as HTMLElement | null; }
        return { bandDocumentTop: top };
      });
      const measure = async () => page.evaluate(() => {
        const band = document.querySelector(".current-activity-band") as HTMLElement | null;
        const main = document.querySelector("main") as HTMLElement | null;
        const work = band?.querySelector(".work-block")?.getBoundingClientRect();
        if (!band || !main || !work) return null;
        const mainRect = main.getBoundingClientRect();
        return {
          expand: Number(getComputedStyle(band).getPropertyValue("--activity-expand")) || 0,
          width: Math.round(work.width), left: Math.round(work.left),
          mainLeft: Math.round(mainRect.left), mainWidth: Math.round(mainRect.width),
        };
      });
      const at = async (naturalTop: number) => {
        await page.evaluate((target: number) => window.scrollTo(0, target), layout.bandDocumentTop - naturalTop);
        await page.waitForTimeout(150);
        const sample = await measure();
        if (!sample) failures.push(`${label} band: could not measure the band at naturalTop ${naturalTop}`);
        return sample;
      };

      const rest = await at(320);
      const rising = [await at(160), await at(100), await at(40)];
      const full = await at(0);

      check(Boolean(rest && full && rising.every(Boolean)), `${label} band: could not measure the band at every sample point`);
      if (rest && full && rising.every(Boolean)) {
        const series = [rest, ...rising as NonNullable<typeof rest>[], full];
        check(rest.expand === 0, `${label} band: expected no expansion at rest, measured --activity-expand ${rest.expand}`);
        check(full.expand === 1, `${label} band: expected full expansion at the top, measured --activity-expand ${full.expand}`);
        for (let index = 1; index < series.length; index++) {
          check(series[index].width > series[index - 1].width, `${label} band: width did not grow between samples ${index - 1} and ${index} (${series[index - 1].width} then ${series[index].width})`);
          check(series[index].left < series[index - 1].left, `${label} band: band did not widen leftwards between samples ${index - 1} and ${index}`);
        }
        // At rest it sits inline; fully expanded it fills main minus the 24px canvas inset.
        expectClose(full.left, full.mainLeft + 24, 1, `${label} band: expanded left edge`);
        expectClose(full.width, full.mainWidth - 48, 2, `${label} band: expanded width`);
        expectClose(full.left + full.width / 2, full.mainLeft + full.mainWidth / 2, 2, `${label} band: expanded centre`);
        for (const sample of series) {
          check(sample.left >= sample.mainLeft - 1, `${label} band: overflowed the left edge of main (${sample.left} < ${sample.mainLeft})`);
          check(sample.left + sample.width <= sample.mainLeft + sample.mainWidth + 1, `${label} band: overflowed the right edge of main`);
        }
        // Scrolling back must undo it, not leave the band stuck wide.
        const returned = await at(320);
        if (returned) {
          check(returned.expand === 0, `${label} band: expansion did not reverse on scroll back (--activity-expand ${returned.expand})`);
          expectClose(returned.width, rest.width, 1, `${label} band: width did not return to its inline size`);
        }
      }

      // Shoot the visible main canvas, not just the band: the affordance is how wide the band sits
      // relative to the column around it, which a crop of the band's own interior cannot show. The
      // lesson rail is outside this affordance, and Chromium can incompletely capture its sticky
      // descendants immediately after a deep scroll, so including it would approve compositor noise.
      // Both work surfaces are masked — xterm's canvas and CodeMirror's caret and selection do not
      // reproduce between runs — which leaves the band's own chrome, including its welded feedback.
      const masked = page.locator(".embedded-terminal, .cm-editor");
      // The band focuses its work surface when it scrolls into view, and :focus-within paints a
      // ring. Whether that has landed by the time the shot is taken depends on how the scroll
      // crossed the observer's margin, so settle on the unfocused state rather than approving a
      // ring that comes and goes. The auto-focus itself stays uncovered: asserting it here failed
      // two runs in three, because jumping the scroll position skips the crossing it waits for.
      const shoot = async () => {
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
        await page.waitForTimeout(80);
        const clip = await page.evaluate(() => {
          const main = document.querySelector("main") as HTMLElement | null;
          if (!main) throw new Error("Cannot screenshot the band without a main canvas");
          const rect = main.getBoundingClientRect();
          const x = Math.max(0, Math.round(rect.left));
          const y = 0;
          const width = Math.max(1, Math.round(window.innerWidth - x));
          const height = Math.max(1, Math.round(window.innerHeight));
          return { x, y, width, height };
        });
        return page.screenshot({ clip, mask: [masked] });
      };
      await at(320);
      await approve(page, `${label}-band-at-rest`, await shoot());
      await at(0);
      await approve(page, `${label}-band-expanded`, await shoot());
    };

    // ---- Affordance 4: the editor rides the same band, and wears the same feedback ------------
    // The band approvals are about the band's geometry inside the main canvas, not about the
    // decorative notebook grid. The grid is anchored to the document, so unrelated content above
    // the practice can require a different absolute scrollY to put the same band at the same
    // viewport position, shifting the 25px grid phase while the band geometry remains correct.
    const bandGridNeutralizer = await page.addStyleTag({ content: "main { background-image: none !important; }" });
    if (promoted) {
      const editorReached = await page.waitForFunction(() => document.querySelector('.current-activity-band[data-activity-type="editor-practice"]') !== null, undefined, { timeout: 10_000 })
        .then(() => true)
        .catch(() => { failures.push("editor band: the editor block never became the active practice surface"); return false; });

      if (editorReached) {
        // Draw the tutor's first queued verdict, so the welded panel has feedback to show.
        await page.locator(".cm-content").fill("A first draft of the answer.");
        await page.waitForFunction(() => Boolean(document.querySelector(".editor-feedback-overlay")?.textContent?.includes("acceptance marker")), undefined, { timeout: 15_000 })
          .catch(() => failures.push("editor feedback: the tutor's review never reached the editor's feedback panel"));
        await validateBand("editor");
        const editorMarkup = await page.evaluate(() => {
          const band = document.querySelector(".current-activity-band") as HTMLElement | null;
          const overlay = band?.querySelector(".editor-feedback-overlay") as HTMLElement | null;
          const surface = band?.querySelector(".editor-surface") as HTMLElement | null;
          if (!band || !overlay || !surface) return null;
          const overlayRect = overlay.getBoundingClientRect();
          const surfaceRect = surface.getBoundingClientRect();
          return {
            weldedBelow: Math.round(overlayRect.top - surfaceRect.bottom),
            sameWidth: Math.round(overlayRect.width - surfaceRect.width),
            background: getComputedStyle(overlay).backgroundColor,
            usesLiveBlockFeedback: overlay.classList.contains("live-block-feedback"),
            statusStrip: Boolean(band.querySelector(".editor-status")),
          };
        });
        check(Boolean(editorMarkup), "editor feedback: could not measure the editor's feedback overlay");
        if (editorMarkup) {
          // The terminal welds its feedback to the bottom of its surface; the editor now does too.
          expectClose(editorMarkup.weldedBelow, 0, 1, "editor feedback: gap between the editor surface and its feedback");
          expectClose(editorMarkup.sameWidth, 0, 1, "editor feedback: overlay width differs from the editor surface");
          check(editorMarkup.usesLiveBlockFeedback, "editor feedback: does not use the shared live-block-feedback treatment");
          check(!editorMarkup.statusStrip, "editor feedback: the separate status strip is still rendered alongside the feedback");
        }

        // The terminal is the block after the editor, so reaching it means getting a draft
        // accepted — the tutor's second queued verdict — and continuing.
        await page.locator(".cm-content").fill("A second draft naming the acceptance marker.");
        // The band unmounts once its checkpoint is accepted, so wait on the server's own state
        // rather than on anything the band renders.
        const accepted = await page.waitForFunction(async () => {
          const next = await (await fetch("api/workbook/state")).json();
          return next.progress.blocks.some((block: any) => block.id.endsWith("--editing") && block.checkpoint?.status === "accepted");
        }, undefined, { timeout: 15_000 })
          .then(() => true)
          .catch(() => { failures.push("terminal band: the editor draft was never accepted, so the terminal block was never reached"); return false; });
        if (accepted) {
          await page.locator("button").filter({ hasText: /^Continue/ }).first().click({ force: true });
          const terminalReached = await page.waitForFunction(() => document.querySelector('.current-activity-band[data-activity-type="terminal-practice"]') !== null, undefined, { timeout: 10_000 })
            .then(() => true)
            .catch(() => { failures.push("terminal band: the terminal block never became the active practice surface"); return false; });
          if (terminalReached) await validateBand("terminal");
        }
      }
    }
    await bandGridNeutralizer.evaluate((style: HTMLElement) => style.remove());

    // ---- Affordance 3: the composer grows with the draft, then caps and scrolls ---------------
    const composer = page.locator(".timeline-composer-textarea");
    const composerHeight = async () => page.evaluate(() => {
      const field = document.querySelector(".timeline-composer-textarea") as HTMLTextAreaElement | null;
      return field ? { height: Math.round(field.getBoundingClientRect().height), overflowY: getComputedStyle(field).overflowY } : null;
    });
    await composer.fill("one line");
    const oneLine = await composerHeight();
    await composer.fill(Array.from({ length: 3 }, (_, index) => `line ${index + 1}`).join("\n"));
    const threeLines = await composerHeight();
    await composer.fill(Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join("\n"));
    const overflowing = await composerHeight();

    check(Boolean(oneLine && threeLines && overflowing), "composer: could not measure the composer textarea");
    if (oneLine && threeLines && overflowing) {
      check(threeLines.height > oneLine.height, `composer: did not grow from one line (${oneLine.height}) to three (${threeLines.height})`);
      // composerMaxHeightPx is 160.
      expectClose(overflowing.height, 160, 2, "composer: capped height");
      check(overflowing.height < 30 * oneLine.height, "composer: grew past its cap instead of scrolling");
      check(overflowing.overflowY === "auto", `composer: expected overflowY auto once capped, measured ${overflowing.overflowY}`);
      check(oneLine.overflowY !== "auto", `composer: expected no scrollbar at one line, measured overflowY ${oneLine.overflowY}`);
    }
    await approve(page, "composer-capped", await composer.screenshot());

    // ---- Task 6 canonical states: the shared feedback bars themselves ------------------------
    // These screenshots are intentionally separate from the band shots above: the old band
    // approvals use masks for xterm/CodeMirror volatility and only captured two scroll positions.
    // The gallery below photographs every relevant editor/terminal feedback state at desktop and
    // narrow widths without masking the bars under test.
    await validatePracticeFeedbackVisuals(page);
  } finally {
    await browser.close();
    await server.close();
    await rm(workspace, { recursive: true, force: true });
  }

  if (failures.length) {
    console.error(`Visual affordance validation failed (${failures.length}):`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log("Visual affordance validation passed: reading-line promotion, activity band expansion, composer auto-resize, practice feedback bar states.");
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
