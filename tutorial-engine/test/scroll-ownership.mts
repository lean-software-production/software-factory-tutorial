#!/usr/bin/env npx tsx
/**
 * Scroll-ownership diagnostic for the workbook.
 *
 * Drives the journey fixture through the situations the 2026-09-01 play-test complained about and
 * records, for each one, who moved the viewport: every programmatic scroll and focus call with its
 * caller, every resulting scroll event, and where the active surface ended up. It asserts the
 * scroll contract the workbook is meant to keep and prints a compact verdict per scenario, then
 * writes the full trace to test/.tmp/scroll-ownership/<label>.json.
 *
 *   cd tutorial-engine && npx tsx test/scroll-ownership.mts [--label=<name>] [--headed]
 *
 * The contract it checks:
 *   1. Continue brings the successor into view, and the page settles where the navigation put it.
 *   2. Typing in the editor or terminal does not move the page, at any band position.
 *   3. Feedback arriving — welded to the surface or as a tutor reply — does not move the page.
 *   4. The page never overflows horizontally, at desktop or narrow widths.
 */
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, type Page } from "playwright";
import { startWorkbookServer } from "../src/workbook/server.js";
import type { TutorDecision } from "../src/workbook/tutor.js";
import { ENGINE_ROOT, WEB_BUNDLE_DIRECTORY, ensureFreshWebBundle } from "./support/web-bundle.js";
import { QueuedMainTutor } from "./support/fake-tutors.js";
import { applicationScrollCalls, applicationScrollEvents, harnessScrollTo, installScrollTelemetry, maxScrollExcursion, readScrollTelemetry, scrollTelemetryLength, type ScrollTelemetryEntry } from "./support/scroll-telemetry.js";
import { createProtocolAwareFakePty } from "./workbook-ux/fake-pty.js";

const RUN_ROOT = resolve(ENGINE_ROOT, "test/.tmp/scroll-ownership");
const FIXTURE_ROOT = resolve(ENGINE_ROOT, "test/fixtures/journey-workbook");
const WEB_ROOT = resolve(ENGINE_ROOT, WEB_BUNDLE_DIRECTORY);
const VIEWPORT = { width: 1280, height: 900 } as const;
const NARROW_VIEWPORTS = [{ width: 1024, height: 768 }, { width: 390, height: 844 }] as const;
/** How long a smooth scroll and its layout settle can take before we read the outcome. */
const SETTLE_MS = 1500;
/** The editor review debounce is 750ms; typing then scrolling away inside it reproduces "feedback while away". */
const EDITOR_REVIEW_DEBOUNCE_MS = 750;
const BAND_INFLOW_TOP_PX = 285;

const FEEDBACK = {
  seeded: "SEEDED: the seeded draft is ready for the learner's first revision.",
  inflow: "FEEDBACK_INFLOW: feedback while the band sits in the flow of the page.",
  inflowOverflow: "FEEDBACK_INFLOW_OVERFLOW: feedback after typing past the fold with the band in flow.",
  docked: "FEEDBACK_DOCKED: feedback while the band is docked at the top.",
  overflow: "FEEDBACK_OVERFLOW: feedback after the draft outgrew the editor.",
  shortViewport: "FEEDBACK_SHORT_VIEWPORT: feedback after the docked draft outgrew a 720px viewport.",
  away: "FEEDBACK_AWAY: feedback while the learner had scrolled away.",
  accepted: "ACCEPTED: the draft is accepted; the terminal is next.",
  terminalDocked: "TERMINAL_DOCKED: terminal feedback while docked.",
  terminalAway: "TERMINAL_AWAY: terminal feedback while the learner had scrolled away.",
} as const;
const TUTOR_REPLY = Array.from({ length: 5 }, (_, index) => `Tutor reply paragraph ${index + 1}: long enough to land below the fold when the learner is reading the top of the block.`).join("\n\n");

type Rect = { top: number; bottom: number; left: number; right: number; width: number; height: number } | null;
interface Measure {
  scrollY: number; scrollX: number; innerHeight: number; innerWidth: number; scrollWidth: number; clientWidth: number; overflowing: string[]; hash: string; composerTop: number;
  band: Rect; bandType: string | null; bandStuck: boolean; activeBlock: Rect; activeBlockId: string | null; focused: string | null;
}
interface Observation {
  readonly scenario: string;
  readonly label: string;
  readonly ok: boolean;
  readonly detail: Record<string, unknown>;
  readonly before: Measure;
  readonly after: Measure;
  readonly applicationScrollCalls: ScrollTelemetryEntry[];
  readonly applicationScrollEvents: ScrollTelemetryEntry[];
  readonly telemetry: ScrollTelemetryEntry[];
}

const observations: Observation[] = [];

async function measure(page: Page): Promise<Measure> {
  return page.evaluate(() => {
    const rect = (element: Element | null) => {
      if (!element) return null;
      const r = element.getBoundingClientRect();
      return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width), height: Math.round(r.height) };
    };
    const band = document.querySelector<HTMLElement>(".current-activity-band");
    const composer = document.querySelector(".timeline-composer-dock");
    const active = document.querySelector<HTMLElement>('[data-active-block="true"]');
    const focused = document.activeElement as HTMLElement | null;
    const clientWidth = document.documentElement.clientWidth;
    const describe = (element: Element) => `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ""}${typeof element.className === "string" && element.className ? `.${element.className.trim().split(/\s+/).slice(0, 3).join(".")}` : ""}`;
    const overflowing = document.documentElement.scrollWidth > clientWidth
      ? Array.from(document.body.querySelectorAll<HTMLElement>("*"))
        .filter((element) => getComputedStyle(element).position !== "fixed")
        .map((element) => ({ element, right: element.getBoundingClientRect().right }))
        .filter(({ right }) => right > clientWidth + 0.5)
        .sort((left, right) => right.right - left.right)
        .slice(0, 6)
        .map(({ element, right }) => `${describe(element)} right=${right.toFixed(0)}`)
      : [];
    return {
      scrollY: Math.round(window.scrollY),
      scrollX: Math.round(window.scrollX),
      innerHeight: window.innerHeight,
      innerWidth: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth,
      overflowing,
      hash: location.hash,
      composerTop: composer ? Math.round(composer.getBoundingClientRect().top) : window.innerHeight,
      band: rect(band),
      bandType: band?.getAttribute("data-activity-type") ?? null,
      bandStuck: Boolean(band && getComputedStyle(band).position === "sticky" && Math.round(band.getBoundingClientRect().top) <= Number.parseFloat(getComputedStyle(band).top || "0") + 1),
      activeBlock: rect(active),
      activeBlockId: active?.id ?? null,
      focused: focused && focused !== document.body ? `${focused.tagName.toLowerCase()}${typeof focused.className === "string" && focused.className ? "." + focused.className.trim().split(/\s+/).slice(0, 2).join(".") : ""}` : null,
    };
  });
}

/** How many times the window reversed direction across these scroll events: 0 or 1 is a scroll, more is a bounce. */
function directionChanges(entries: readonly ScrollTelemetryEntry[]): number {
  let previousY: number | undefined;
  let previousDirection = 0;
  let changes = 0;
  for (const entry of entries) {
    if (entry.kind !== "scroll-event" || entry.target !== "document") continue;
    if (previousY !== undefined) {
      const direction = Math.sign(entry.scrollY - previousY);
      if (direction !== 0 && previousDirection !== 0 && direction !== previousDirection) changes += 1;
      if (direction !== 0) previousDirection = direction;
    }
    previousY = entry.scrollY;
  }
  return changes;
}

function inView(rect: Rect, measure: Measure): boolean {
  return Boolean(rect && rect.top >= -1 && rect.top < Math.min(measure.composerTop, measure.innerHeight));
}

async function observe(page: Page, scenario: string, label: string, run: (before: Measure) => Promise<{ ok: boolean; detail?: Record<string, unknown> }>): Promise<Observation> {
  const start = await scrollTelemetryLength(page);
  const before = await measure(page);
  const verdict = await run(before);
  const after = await measure(page);
  const telemetry = await readScrollTelemetry(page, start);
  const observation: Observation = {
    scenario, label, ok: verdict.ok,
    detail: { ...verdict.detail, horizontalOverflow: after.scrollWidth > after.clientWidth, ...(after.overflowing.length ? { overflowing: after.overflowing } : {}) },
    before, after,
    applicationScrollCalls: applicationScrollCalls(telemetry),
    applicationScrollEvents: applicationScrollEvents(telemetry),
    telemetry,
  };
  observations.push(observation);
  const calls = observation.applicationScrollCalls.map((call) => `${call.kind}${call.target ? `(${call.target})` : ""}${call.options && (call.options as unknown[]).length ? ` ${JSON.stringify(call.options)}` : ""}`);
  console.log(`${verdict.ok ? "ok  " : "FAIL"} ${scenario} · ${label}`);
  console.log(`     scrollY ${before.scrollY} -> ${after.scrollY}${observation.detail.horizontalOverflow ? " · HORIZONTAL OVERFLOW" : ""}; app scroll calls: ${calls.length ? calls.join("; ") : "none"}`);
  for (const [key, value] of Object.entries(verdict.detail ?? {})) console.log(`     ${key}: ${typeof value === "object" ? JSON.stringify(value) : String(value)}`);
  return observation;
}

async function currentState(page: Page): Promise<any> {
  return page.evaluate(async () => (await (await fetch("api/workbook/state")).json()));
}

async function positionBand(page: Page, viewportTop: number): Promise<void> {
  const bandDocumentTop = await page.evaluate(() => {
    const band = document.querySelector<HTMLElement>(".current-activity-band");
    if (!band) throw new Error("No activity band to position.");
    // Measure the band's natural document position by scrolling to the top of its section first,
    // where sticky positioning cannot have displaced it.
    const section = band.closest("section") as HTMLElement;
    const sectionTop = section.getBoundingClientRect().top + window.scrollY;
    return { sectionTop, offset: band.getBoundingClientRect().top - section.getBoundingClientRect().top, stuck: getComputedStyle(band).position === "sticky" };
  });
  // Scroll so the section top is at the viewport top, then measure the band's true offset.
  await harnessScrollTo(page, bandDocumentTop.sectionTop);
  await page.waitForTimeout(120);
  const naturalTop = await page.evaluate(() => {
    const band = document.querySelector<HTMLElement>(".current-activity-band")!;
    return band.getBoundingClientRect().top + window.scrollY;
  });
  await harnessScrollTo(page, Math.max(0, naturalTop - viewportTop));
  await page.waitForTimeout(250);
}

async function typeIntoEditor(page: Page, text: string, { selectAll = false } = {}): Promise<void> {
  const content = page.locator('.current-activity-band .cm-content[contenteditable="true"]').first();
  await content.waitFor({ state: "visible", timeout: 10_000 });
  if (await page.evaluate(() => !document.activeElement?.classList.contains("cm-content"))) await content.click();
  if (selectAll) await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
  await page.keyboard.type(text, { delay: 12 });
}

async function waitForFeedback(page: Page, surface: "editor" | "terminal", text: string): Promise<void> {
  const selector = surface === "editor" ? ".editor-feedback-overlay" : ".terminal-feedback-overlay";
  await page.waitForFunction(({ selector: target, expected }) => document.querySelector(target)?.textContent?.includes(expected), { selector, expected: text }, { timeout: 20_000 });
}

async function clickContinueAndSettle(page: Page, duringScroll?: () => Promise<void>): Promise<{ successor: any; state: any }> {
  const state = await currentState(page);
  const ordered = state.orderedBlocks ?? [];
  const index = ordered.findIndex((block: any) => block.id === state.progress.activeBlockId);
  const successor = ordered[index + 1];
  const button = page.getByRole("button", { name: /^(?:Ready to continue|Continue)/ }).first();
  await button.waitFor({ state: "visible", timeout: 10_000 });
  await button.click();
  await page.waitForFunction(async (expected: string) => (await (await fetch("api/workbook/state")).json()).progress.activeBlockId === expected, successor.id, { timeout: 10_000 });
  if (duringScroll) await duringScroll();
  await page.waitForTimeout(SETTLE_MS);
  return { successor, state };
}

function continueVerdict(successor: any, after: Measure, rect: Rect): { ok: boolean; detail: Record<string, unknown> } {
  const landed = inView(rect, after);
  return { ok: landed && after.hash === `#${successor.anchorId}`, detail: { successor: successor.anchorId, successorTop: rect?.top ?? null, successorInView: landed, hash: after.hash, bandType: after.bandType } };
}

async function rectOfId(page: Page, id: string): Promise<Rect> {
  return page.evaluate((target) => {
    const element = document.getElementById(target);
    if (!element) return null;
    const r = element.getBoundingClientRect();
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width), height: Math.round(r.height) };
  }, id);
}

async function main(): Promise<void> {
  const label = process.argv.find((arg) => arg.startsWith("--label="))?.slice("--label=".length) ?? "latest";
  const headed = process.argv.includes("--headed");
  ensureFreshWebBundle();
  const runRoot = resolve(RUN_ROOT, label);
  await rm(runRoot, { recursive: true, force: true });
  await mkdir(runRoot, { recursive: true });
  const inputRoot = resolve(runRoot, "input");
  await cp(FIXTURE_ROOT, inputRoot, { recursive: true });
  process.env.OPENCODE_API_KEY ??= "scroll-ownership-no-model-key";

  const mainTutor = new QueuedMainTutor(
    { outcome: "feedback", message: FEEDBACK.seeded } satisfies TutorDecision,
    { outcome: "feedback", message: FEEDBACK.inflow } satisfies TutorDecision,
    { outcome: "feedback", message: FEEDBACK.inflowOverflow } satisfies TutorDecision,
    { outcome: "feedback", message: FEEDBACK.docked } satisfies TutorDecision,
    { outcome: "feedback", message: FEEDBACK.overflow } satisfies TutorDecision,
    { outcome: "feedback", message: FEEDBACK.shortViewport } satisfies TutorDecision,
    { outcome: "feedback", message: FEEDBACK.away } satisfies TutorDecision,
    { outcome: "accepted", message: FEEDBACK.accepted } satisfies TutorDecision,
    { outcome: "feedback", message: FEEDBACK.terminalDocked } satisfies TutorDecision,
    { outcome: "feedback", message: FEEDBACK.terminalAway } satisfies TutorDecision,
  );
  mainTutor.replyQueue.push(TUTOR_REPLY);
  const fakePty = createProtocolAwareFakePty({ outputForCommand: (command, index) => `\r\nfake terminal ${index}: observed ${command}\r\n` });
  const server = await startWorkbookServer({ target: inputRoot, webRoot: WEB_ROOT, port: 0, mainTutor, terminalPtyFactory: fakePty.create, logger: { info() {}, error() {} } });
  const browser = await chromium.launch({ headless: !headed });
  try {
    const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1, reducedMotion: "no-preference" });
    const page = await context.newPage();
    await installScrollTelemetry(page);
    await page.goto(server.url, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".timeline-composer-textarea", { timeout: 10_000 });
    await page.waitForTimeout(800);

    // 1. Continue through the structural blocks up to the editor. Each landing must show the successor.
    for (let step = 0; step < 10; step += 1) {
      if (await page.locator('.current-activity-band[data-activity-type="editor-practice"]').count()) break;
      const state = await currentState(page);
      const ordered = state.orderedBlocks ?? [];
      const successor = ordered[ordered.findIndex((block: any) => block.id === state.progress.activeBlockId) + 1];
      const nudged = successor?.kind === "editor-practice";
      await observe(page, "continue", `structural step ${step + 1}${nudged ? " with a trackpad nudge during the scroll" : ""}`, async () => {
        const { successor: target } = await clickContinueAndSettle(page, nudged ? async () => { await page.waitForTimeout(180); await page.mouse.wheel(0, -90); } : undefined);
        const after = await measure(page);
        return continueVerdict(target, after, await rectOfId(page, target.anchorId));
      });
    }
    await waitForFeedback(page, "editor", FEEDBACK.seeded);
    await page.waitForTimeout(300);

    // 1b. The learner scrolls the band into view with the wheel, then pages down with the keyboard.
    await positionBand(page, 620);
    await observe(page, "focus", "PageDown after the band scrolls into view", async () => {
      await page.locator(".timeline-authored-content").first().click({ position: { x: 5, y: 5 } }).catch(() => undefined);
      await page.mouse.wheel(0, 240);
      await page.waitForTimeout(400);
      const settled = await measure(page);
      await page.keyboard.press("PageDown");
      await page.waitForTimeout(500);
      const after = await measure(page);
      return { ok: after.scrollY > settled.scrollY + 100, detail: { focusedBeforeKey: settled.focused, scrolledByKeyPx: after.scrollY - settled.scrollY, focusedAfterKey: after.focused } };
    });

    // 2. Typing with the band in the flow of the page, then feedback.
    await positionBand(page, BAND_INFLOW_TOP_PX);
    await observe(page, "typing", "editor in flow: type two lines", async (before) => {
      const start = await scrollTelemetryLength(page);
      await typeIntoEditor(page, "In-flow draft line one.\nIn-flow draft line two.", { selectAll: true });
      const excursion = maxScrollExcursion(applicationScrollEvents(await readScrollTelemetry(page, start)), before.scrollY);
      return { ok: excursion < 1, detail: { maxExcursionPx: excursion, bandTopBefore: before.band?.top } };
    });
    await observe(page, "feedback", "editor in flow: feedback arrives", async (before) => {
      await waitForFeedback(page, "editor", FEEDBACK.inflow);
      await page.waitForTimeout(600);
      const after = await measure(page);
      return { ok: Math.abs(after.scrollY - before.scrollY) < 1, detail: { scrollDelta: after.scrollY - before.scrollY, feedbackInView: inView(await page.locator(".editor-feedback-overlay").first().evaluate((el) => { const r = el.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: 0, right: 0, width: Math.round(r.width), height: Math.round(r.height) }; }), after) } };
    });

    // 2b. The band sits half below the fold and the learner types past it.
    await positionBand(page, 450);
    await observe(page, "typing", "editor half below the fold: type 18 lines", async (before) => {
      const start = await scrollTelemetryLength(page);
      const lines = Array.from({ length: 18 }, (_, index) => `In-flow overflow line ${index + 1} moves the cursor below the fold.`).join("\n");
      await typeIntoEditor(page, lines, { selectAll: true });
      await page.waitForTimeout(400);
      const events = applicationScrollEvents(await readScrollTelemetry(page, start));
      const after = await measure(page);
      const cursor = await page.evaluate(() => { const r = document.querySelector(".current-activity-band .cm-cursor")?.getBoundingClientRect(); return r ? Math.round(r.top) : null; });
      return { ok: directionChanges(events) <= 1 && (cursor === null || cursor < after.innerHeight), detail: { scrollDelta: after.scrollY - before.scrollY, directionChanges: directionChanges(events), scrollEvents: events.length, cursorTop: cursor, bandTopAfter: after.band?.top, bandHeightAfter: after.band?.height } };
    });
    await observe(page, "feedback", "editor half below the fold: feedback arrives", async (before) => {
      await waitForFeedback(page, "editor", FEEDBACK.inflowOverflow);
      await page.waitForTimeout(600);
      const after = await measure(page);
      return { ok: Math.abs(after.scrollY - before.scrollY) < 1, detail: { scrollDelta: after.scrollY - before.scrollY } };
    });

    // 3. Typing with the band docked at the top, including outgrowing the editor.
    await positionBand(page, 0);
    await observe(page, "typing", "editor docked: type two lines", async (before) => {
      const start = await scrollTelemetryLength(page);
      await typeIntoEditor(page, "Docked draft line one.\nDocked draft line two.", { selectAll: true });
      const excursion = maxScrollExcursion(applicationScrollEvents(await readScrollTelemetry(page, start)), before.scrollY);
      return { ok: excursion < 1, detail: { maxExcursionPx: excursion, bandStuck: before.bandStuck, bandTopBefore: before.band?.top } };
    });
    await observe(page, "feedback", "editor docked: feedback arrives", async (before) => {
      await waitForFeedback(page, "editor", FEEDBACK.docked);
      await page.waitForTimeout(600);
      const after = await measure(page);
      return { ok: Math.abs(after.scrollY - before.scrollY) < 1, detail: { scrollDelta: after.scrollY - before.scrollY } };
    });
    await observe(page, "typing", "editor docked: draft outgrows the editor (18 lines)", async (before) => {
      const start = await scrollTelemetryLength(page);
      const lines = Array.from({ length: 18 }, (_, index) => `Overflow line ${index + 1} keeps the cursor moving down the editor.`).join("\n");
      await typeIntoEditor(page, lines, { selectAll: true });
      const excursion = maxScrollExcursion(applicationScrollEvents(await readScrollTelemetry(page, start)), before.scrollY);
      const after = await measure(page);
      return { ok: excursion < 1 && after.scrollWidth <= after.clientWidth, detail: { maxExcursionPx: excursion, bandHeightBefore: before.band?.height, bandHeightAfter: after.band?.height, bandBottomAfter: after.band?.bottom, composerTop: after.composerTop } };
    });
    await observe(page, "feedback", "editor docked: feedback arrives after overflow", async (before) => {
      await waitForFeedback(page, "editor", FEEDBACK.overflow);
      await page.waitForTimeout(600);
      const after = await measure(page);
      return { ok: Math.abs(after.scrollY - before.scrollY) < 1, detail: { scrollDelta: after.scrollY - before.scrollY } };
    });

    // 3b. A shorter window: the docked editor outgrows the viewport while the learner keeps typing.
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.waitForTimeout(300);
    await positionBand(page, 0);
    await observe(page, "typing", "1280x720 docked: draft outgrows the viewport (30 lines)", async (before) => {
      const start = await scrollTelemetryLength(page);
      const lines = Array.from({ length: 30 }, (_, index) => `Short viewport line ${index + 1} keeps typing past the bottom of the window.`).join("\n");
      await typeIntoEditor(page, lines, { selectAll: true });
      await page.waitForTimeout(400);
      const events = applicationScrollEvents(await readScrollTelemetry(page, start));
      const after = await measure(page);
      const cursor = await page.evaluate(() => { const r = document.querySelector(".current-activity-band .cm-cursor")?.getBoundingClientRect(); return r ? Math.round(r.top) : null; });
      return { ok: maxScrollExcursion(events, before.scrollY) < 1 && (cursor === null || cursor < after.innerHeight), detail: { maxExcursionPx: maxScrollExcursion(events, before.scrollY), scrollEvents: events.length, cursorTop: cursor, innerHeight: after.innerHeight, bandBottomAfter: after.band?.bottom, bandStuck: after.bandStuck } };
    });
    await observe(page, "feedback", "1280x720 docked: feedback arrives after overflow", async (before) => {
      await waitForFeedback(page, "editor", FEEDBACK.shortViewport);
      await page.waitForTimeout(600);
      const after = await measure(page);
      return { ok: Math.abs(after.scrollY - before.scrollY) < 1, detail: { scrollDelta: after.scrollY - before.scrollY } };
    });
    await page.setViewportSize(VIEWPORT);
    await page.waitForTimeout(300);
    await positionBand(page, 0);

    // 4. Type, scroll away before the review lands, and let feedback arrive while the band is off-screen.
    await observe(page, "feedback", "editor away: learner scrolls up before feedback lands", async () => {
      await typeIntoEditor(page, "Away draft: the learner scrolls up to reread while this is reviewed.", { selectAll: true });
      await harnessScrollTo(page, Math.max(0, (await measure(page)).scrollY - 700));
      const parked = await measure(page);
      await page.waitForTimeout(EDITOR_REVIEW_DEBOUNCE_MS);
      await waitForFeedback(page, "editor", FEEDBACK.away);
      await page.waitForTimeout(600);
      const after = await measure(page);
      return { ok: Math.abs(after.scrollY - parked.scrollY) < 1, detail: { parkedScrollY: parked.scrollY, scrollDelta: after.scrollY - parked.scrollY, bandTopWhenParked: parked.band?.top } };
    });

    // 5. A tutor reply arrives below the fold while the learner reads the docked block.
    await positionBand(page, 0);
    await observe(page, "reply", "tutor reply arrives below the fold", async (before) => {
      await page.locator(".timeline-composer-textarea").click();
      await page.keyboard.type("Is my draft heading the right way?", { delay: 8 });
      const replies = await page.locator(".timeline-message.tutor:not(.thinking)").count();
      await page.keyboard.press("Enter");
      await page.waitForFunction((count) => document.querySelectorAll(".timeline-message.tutor:not(.thinking)").length > count, replies, { timeout: 10_000 });
      await page.waitForTimeout(600);
      const after = await measure(page);
      const replyRect = await page.locator(".timeline-message.tutor:not(.thinking)").last().evaluate((el) => { const r = el.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: 0, right: 0, width: Math.round(r.width), height: Math.round(r.height) }; });
      const chip = await page.locator(".conversation-unseen-chip, [data-unseen-below]").count();
      return { ok: Math.abs(after.scrollY - before.scrollY) < 1, detail: { scrollDelta: after.scrollY - before.scrollY, replyTop: replyRect.top, replyInView: inView(replyRect, after), unseenChipRendered: chip > 0 } };
    });

    // 6. Accept the draft, then Continue into the terminal. The terminal must land in view.
    await positionBand(page, 0);
    await typeIntoEditor(page, "Final draft: accepted.", { selectAll: true });
    await page.waitForFunction(async () => (await (await fetch("api/workbook/state")).json()).progress.blocks.some((block: any) => block.id.endsWith("--editor-draft") && block.checkpoint?.status === "accepted"), undefined, { timeout: 20_000 });
    await page.waitForTimeout(500);
    await observe(page, "continue", "accepted editor -> terminal", async () => {
      const { successor } = await clickContinueAndSettle(page);
      const after = await measure(page);
      return continueVerdict(successor, after, await rectOfId(page, successor.anchorId));
    });

    // 7. Terminal typing while docked, then feedback; then feedback while away.
    await page.locator(".terminal-connection-status.connected").waitFor({ state: "attached", timeout: 15_000 });
    await positionBand(page, 0);
    await observe(page, "typing", "terminal docked: type a command", async (before) => {
      const start = await scrollTelemetryLength(page);
      await page.locator(".current-activity-band .embedded-terminal").click({ position: { x: 40, y: 40 } });
      await page.locator(".current-activity-band .xterm-helper-textarea").first().focus();
      for (const char of "printf docked") await page.keyboard.type(char, { delay: 30 });
      const excursion = maxScrollExcursion(applicationScrollEvents(await readScrollTelemetry(page, start)), before.scrollY);
      return { ok: excursion < 1, detail: { maxExcursionPx: excursion, bandStuck: before.bandStuck } };
    });
    await observe(page, "feedback", "terminal docked: feedback arrives", async (before) => {
      await page.keyboard.press("Enter");
      await waitForFeedback(page, "terminal", FEEDBACK.terminalDocked);
      await page.waitForTimeout(600);
      const after = await measure(page);
      return { ok: Math.abs(after.scrollY - before.scrollY) < 1, detail: { scrollDelta: after.scrollY - before.scrollY } };
    });
    await observe(page, "feedback", "terminal away: learner scrolls up before feedback lands", async () => {
      for (const char of "printf away") await page.keyboard.type(char, { delay: 20 });
      await page.keyboard.press("Enter");
      await harnessScrollTo(page, Math.max(0, (await measure(page)).scrollY - 700));
      const parked = await measure(page);
      await waitForFeedback(page, "terminal", FEEDBACK.terminalAway);
      await page.waitForTimeout(600);
      const after = await measure(page);
      return { ok: Math.abs(after.scrollY - parked.scrollY) < 1, detail: { parkedScrollY: parked.scrollY, scrollDelta: after.scrollY - parked.scrollY } };
    });

    // 8. Narrow viewports: the docked band must not overflow the page horizontally.
    for (const viewport of NARROW_VIEWPORTS) {
      await page.setViewportSize(viewport);
      await page.waitForTimeout(400);
      await positionBand(page, 0);
      await observe(page, "overflow", `viewport ${viewport.width}x${viewport.height} with the band docked`, async () => {
        const after = await measure(page);
        return { ok: after.scrollWidth <= after.clientWidth, detail: { scrollWidth: after.scrollWidth, clientWidth: after.clientWidth, bandLeft: after.band?.left, bandRight: after.band?.right } };
      });
    }
    await page.setViewportSize(VIEWPORT);
  } finally {
    await browser.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }

  await writeFile(resolve(runRoot, "observations.json"), JSON.stringify({ generatedAt: new Date().toISOString(), viewport: VIEWPORT, observations }, null, 2));
  const failures = observations.filter((observation) => !observation.ok);
  console.log(`\n${observations.length - failures.length}/${observations.length} scenarios held the scroll contract. Trace: ${resolve(runRoot, "observations.json")}`);
  if (failures.length) process.exitCode = 1;
}

main().catch((error) => { console.error(error instanceof Error ? error.stack ?? error.message : error); process.exitCode = 1; });
