#!/usr/bin/env npx tsx
import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { startWorkbookServer, type StartedWorkbookServer } from "../../src/workbook/server.js";
import type { TutorDecision } from "../../src/workbook/tutor.js";
import { ENGINE_ROOT, WEB_BUNDLE_DIRECTORY, ensureFreshWebBundle } from "../support/web-bundle.js";
import { QueuedMainTutor } from "../support/fake-tutors.js";
import { applicationScrollCalls, applicationScrollEvents, installScrollTelemetry, maxScrollExcursion, readScrollTelemetry, SCROLL_TELEMETRY_NOTE_GLOBAL, scrollTelemetryLength, type ScrollTelemetryEntry } from "../support/scroll-telemetry.js";
import { analyzeWorkbookVideo, type AnalyzerReport } from "./analyzer.js";
import { createProtocolAwareFakePty } from "./fake-pty.js";
import { MARKER_BITS, MARKER_COLOURS, MARKER_CELL_SIZE, MARKER_GAP, MARKER_TOTAL_CELLS, markerCss, rgbCss } from "./marker-protocol.js";
import { checkpointProgressEvent, createWorkbookUxProgressLogger, WORKBOOK_UX_SEMANTIC_CHECKPOINT_TOTAL, type WorkbookUxProgressSink } from "./progress.js";
import { REQUIRED_MOTION_STEP_IDS, REQUIRED_STATE_CHECKPOINT_STEP_IDS, SCROLL_CHECKPOINT_STEP_IDS, WORKBOOK_UX_TEST_STEPS, type WorkbookUxTestGeometryState, type WorkbookUxTestStepDeclaration } from "./steps.js";

const RUN_ROOT = resolve(ENGINE_ROOT, "test/.tmp/workbook-ux/latest");
const FIXTURE_ROOT = resolve(ENGINE_ROOT, "test/fixtures/journey-workbook");
const WEB_ROOT = resolve(ENGINE_ROOT, WEB_BUNDLE_DIRECTORY);
const VIEWPORT = { width: 1280, height: 900 } as const;
const VIDEO_PATH = "walkthrough.webm";
const WALKTHROUGH_PATH = "walkthrough.json";
const INPUT_METADATA_PATH = "input-metadata.json";
export const REQUIRED_SCROLL_SEMANTIC_DELTA_MIN_PX = 20;
export const REAL_JOURNEY_MIN_REQUIRED_MOTION_PX = 12;
export const REAL_JOURNEY_OBSERVED_SPARSE_EDITOR_TEXTURE_FLOOR = 3.862;
// The real provider-free journey deliberately samples a mostly white CodeMirror editor ROI.
// Clean runs have measured that sparse editor at and above 3.862, so 3 keeps a healthy
// scenario-specific margin without weakening the generic analyzer's texture default.
export const REAL_JOURNEY_MIN_TEXTURE_SCORE = 3;
/** The page may drift this much while feedback lands or the learner types before it counts as moved. */
export const PAGE_HOLD_TOLERANCE_PX = 1;
/** Where the band sits, from the top of the viewport, when it is "in flow". */
export const BAND_INFLOW_TOP_PX = 285;
/** How far below the bottom of the viewport the band is parked when the learner has scrolled "away". */
export const BAND_AWAY_MARGIN_PX = 120;
/** How long a review is held back so feedback lands after the learner has scrolled away from the band. */
const AWAY_REVIEW_DELAY_MS = 1_200;

const GEOMETRY_TARGETS: Record<WorkbookUxTestGeometryState, { readonly description: string; readonly viewportTop: (viewportHeight: number) => number; readonly durationMs: number }> = {
  inflow: { description: `band top within 24px of ${BAND_INFLOW_TOP_PX}px`, viewportTop: () => BAND_INFLOW_TOP_PX, durationMs: 900 },
  docked: { description: "band stuck at the top of the viewport and fitting above the composer", viewportTop: () => 0, durationMs: 900 },
  away: { description: "band entirely below the fold", viewportTop: (viewportHeight) => viewportHeight + BAND_AWAY_MARGIN_PX, durationMs: 300 },
};

const EDITOR_FEEDBACK = {
  inflow: "EDITOR_FEEDBACK_INFLOW_STATE: feedback settled with the band in the flow of the page.",
  docked: "EDITOR_FEEDBACK_DOCKED_STATE: feedback settled with the band docked at the top.",
  away: "EDITOR_FEEDBACK_AWAY_STATE: feedback settled while the band was below the fold.",
};
const EDITOR_ACCEPTED = "EDITOR_ACCEPTED_FINAL_STATE: accepted draft unlocks the terminal.";
const TERMINAL_FEEDBACK = {
  inflow: "TERMINAL_FEEDBACK_INFLOW_STATE: Main Tutor feedback settled with the terminal band in flow.",
  docked: "TERMINAL_FEEDBACK_DOCKED_STATE: Main Tutor feedback settled with the terminal band docked.",
  away: "TERMINAL_FEEDBACK_AWAY_STATE: Main Tutor feedback settled while the terminal band was below the fold.",
};

export interface RectTelemetry { readonly x: number; readonly y: number; readonly width: number; readonly height: number; readonly top: number; readonly right: number; readonly bottom: number; readonly left: number; }
export interface GeometryTelemetry {
  readonly scrollY: number;
  readonly viewportHeight: number;
  /** Where the band would sit in the document if nothing were sticking it: measured with its section at the top. */
  readonly bandDocumentTop: number;
  readonly bandRect: RectTelemetry;
  readonly bandStuck: boolean;
  readonly workRect: RectTelemetry;
  readonly mainRect: RectTelemetry;
  readonly composerTop: number;
  readonly scrollWidth: number;
  readonly clientWidth: number;
  /** Elements whose right edge passes the viewport when the page overflows horizontally; empty otherwise. */
  readonly overflowing: readonly string[];
}
export interface FeedbackSafeRegionTelemetry {
  readonly viewport: { readonly width: number; readonly height: number };
  readonly composerRect?: RectTelemetry;
  readonly safeBottom: number;
  readonly insideSafeRegion: boolean;
  readonly occlusionChecks: readonly { readonly x: number; readonly y: number; readonly topElement: string; readonly targetContainsTopElement: boolean }[];
  readonly unoccluded: boolean;
}
export interface FeedbackTelemetry { readonly text: string; readonly rect: RectTelemetry; readonly safeRegion: FeedbackSafeRegionTelemetry; }
export interface FakeCallCounts { readonly mainTutorReviews: number; readonly fakePtyCommands: number; }
/** Who moved the page during a checkpoint, from the scroll telemetry probe. */
export interface ScrollOwnershipTelemetry {
  /** Programmatic scroll calls the application made (the recorder's own positioning is excluded). */
  readonly applicationScrollCalls: readonly ScrollTelemetryEntry[];
  /** Window scroll events not caused by the recorder's own positioning. */
  readonly applicationScrollEvents: number;
  /** The furthest the page moved from where it was when the checkpoint started, excluding recorder positioning. */
  readonly maxExcursionPx: number;
  /** For feedback checkpoints: how far the page moved while the learner typed, before feedback was awaited. */
  readonly typingExcursionPx?: number;
}
/** Where a Continue left the successor block, measured once the navigation settled. */
export interface ContinueLanding {
  readonly from: string;
  readonly to: string;
  readonly scrollYBefore: number;
  readonly scrollYAfter: number;
  readonly successorTop: number;
  readonly composerTop: number;
  readonly inView: boolean;
}
export interface SemanticCheckpoint {
  readonly stepId: number;
  readonly name: string;
  readonly surface: string;
  readonly requestedState?: WorkbookUxTestGeometryState;
  readonly kind: WorkbookUxTestStepDeclaration["kind"];
  readonly requiredMotion: boolean;
  readonly startedAt: string;
  readonly settledAt: string;
  readonly marker: { readonly transitionAt: string; readonly settledAt: string };
  readonly before: GeometryTelemetry;
  readonly after: GeometryTelemetry;
  readonly feedback?: FeedbackTelemetry;
  readonly typedText?: string;
  readonly command?: string;
  readonly landing?: ContinueLanding;
  readonly scroll: ScrollOwnershipTelemetry;
  readonly fakeCallCounts: FakeCallCounts;
}
export interface WorkbookUxTestWalkthrough {
  readonly generatedAt: string;
  readonly runRoot: string;
  readonly fixtureRoot: string;
  readonly copiedFixtureRoot: string;
  readonly videoPath: string;
  readonly viewport: typeof VIEWPORT & { readonly deviceScaleFactor: 1; readonly reducedMotion: "no-preference" };
  readonly markerProtocol: { readonly bits: number; readonly stateCheckpointStepIds: readonly number[]; readonly scrollCheckpointStepIds: readonly number[]; readonly requiredMotionStepIds: readonly number[] };
  readonly checkpoints: SemanticCheckpoint[];
  /** Every Continue the recorder pressed, and where it left the successor. */
  readonly landings: ContinueLanding[];
  readonly fake: { readonly mainTutorReviews: number; readonly ptyCommands: readonly unknown[] };
  readonly analyzer?: Pick<AnalyzerReport, "ok" | "requiredMotionStepIds" | "markerSamples" | "findings"> & { readonly segmentStepIds: number[]; readonly evidenceFiles: readonly string[]; readonly contactSheet?: string };
  readonly semanticFailures: string[];
}
export interface WorkbookUxTestRecorderOptions {
  readonly runRoot?: string;
  readonly analyze?: boolean;
  readonly headless?: boolean;
  readonly progress?: WorkbookUxProgressSink;
}
export interface WorkbookUxTestRecorderResult {
  readonly runRoot: string;
  readonly videoPath: string;
  readonly walkthroughPath: string;
  readonly analysis?: AnalyzerReport;
  readonly walkthrough: WorkbookUxTestWalkthrough;
}

type MarkerPhase = "settled" | "transition";

type Mutable<T> = { -readonly [Property in keyof T]: T[Property] };
type MutableWalkthrough = Mutable<Omit<WorkbookUxTestWalkthrough, "checkpoints" | "landings" | "semanticFailures" | "fake" | "videoPath">> & {
  checkpoints: SemanticCheckpoint[];
  landings: ContinueLanding[];
  semanticFailures: string[];
  fake: Mutable<WorkbookUxTestWalkthrough["fake"]>;
  videoPath: string;
  analyzer?: WorkbookUxTestWalkthrough["analyzer"];
};

function isoNow(): string { return new Date().toISOString(); }
function shell(command: string, cwd = ENGINE_ROOT): string {
  return execFileSync(command, { cwd, shell: "/bin/bash", encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
async function exists(path: string): Promise<boolean> { try { await stat(path); return true; } catch { return false; } }
function delay(ms: number): Promise<void> { return new Promise((resolvePromise) => setTimeout(resolvePromise, ms)); }

async function collectInputMetadata(runRoot: string, bundleStatus: ReturnType<typeof ensureFreshWebBundle>, browserVersion?: string): Promise<Record<string, unknown>> {
  const packageJson = JSON.parse(await readFile(resolve(ENGINE_ROOT, "package.json"), "utf8")) as Record<string, unknown>;
  const status = shell("git status --short", resolve(ENGINE_ROOT, "..")).split("\n").filter(Boolean);
  const metadata = {
    generatedAt: isoNow(),
    git: {
      sha: shell("git rev-parse HEAD", resolve(ENGINE_ROOT, "..")),
      shortSha: shell("git rev-parse --short HEAD", resolve(ENGINE_ROOT, "..")),
      dirty: status.length > 0,
      status,
    },
    engine: { root: ENGINE_ROOT, fixtureRoot: FIXTURE_ROOT, runRoot, webBundle: bundleStatus },
    package: { name: packageJson.name, version: packageJson.version, playwright: (packageJson.devDependencies as Record<string, string> | undefined)?.playwright },
    browser: { name: "playwright chromium", version: browserVersion },
    viewport: { ...VIEWPORT, deviceScaleFactor: 1, reducedMotion: "no-preference" },
  };
  await writeFile(resolve(runRoot, INPUT_METADATA_PATH), JSON.stringify(metadata, null, 2));
  return metadata;
}

async function installVideoMarker(page: Page): Promise<void> {
  await page.addInitScript(({ css, markerBits, totalCells, cellSize, gap, colours }) => {
    (globalThis as unknown as { __name: unknown }).__name = (value: unknown) => value;
    type Phase = "settled" | "transition";
    const state = { phase: "settled" as Phase, stepId: 1 };
    const bitFor = (stepId: number, index: number) => (stepId >> (markerBits - index - 1)) & 1;
    const ensure = () => {
      const root = document.documentElement;
      if (!root) return;
      if (!document.getElementById("workbook-ux-marker-style")) {
        const style = document.createElement("style");
        style.id = "workbook-ux-marker-style";
        style.textContent = css;
        (document.head || root).appendChild(style);
      }
      let marker = document.querySelector<HTMLElement>(".wux-marker");
      if (!marker) {
        marker = document.createElement("div");
        marker.className = "wux-marker";
        marker.setAttribute("aria-hidden", "true");
        for (let index = 0; index < totalCells; index += 1) {
          const cell = document.createElement("div");
          cell.className = "wux-marker-cell";
          cell.dataset.markerCell = String(index);
          cell.style.width = `${cellSize}px`;
          cell.style.height = `${cellSize}px`;
          marker.appendChild(cell);
        }
        (document.body || root).appendChild(marker);
      }
      marker.dataset.markerStep = String(state.stepId);
      marker.dataset.markerPhase = state.phase;
      const cells = Array.from(marker.querySelectorAll<HTMLElement>(".wux-marker-cell"));
      const colourFor = (index: number): string => {
        if (index === 0) return colours.guard;
        if (index === 1) return state.phase === "settled" ? colours.settled : colours.transition;
        return bitFor(state.stepId, index - 2) === 1 ? colours.one : colours.zero;
      };
      cells.forEach((cell, index) => { cell.style.background = colourFor(index); });
    };
    Object.defineProperty(window, "__workbookUxTestMarker", {
      value: (next: { phase: Phase; stepId: number }) => {
        state.phase = next.phase;
        state.stepId = next.stepId;
        ensure();
      },
      configurable: true,
    });
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", ensure, { once: true });
    ensure();
  }, {
    css: markerCss(),
    markerBits: MARKER_BITS,
    totalCells: MARKER_TOTAL_CELLS,
    cellSize: MARKER_CELL_SIZE,
    gap: MARKER_GAP,
    colours: {
      guard: rgbCss(MARKER_COLOURS.guard),
      settled: rgbCss(MARKER_COLOURS.phase.settled),
      transition: rgbCss(MARKER_COLOURS.phase.transition),
      one: rgbCss(MARKER_COLOURS.bit.one),
      zero: rgbCss(MARKER_COLOURS.bit.zero),
    },
  });
}

async function setMarker(page: Page, phase: MarkerPhase, step: WorkbookUxTestStepDeclaration): Promise<string> {
  await page.evaluate(({ phase: nextPhase, stepId }) => {
    const setter = (window as unknown as { __workbookUxTestMarker?: (state: { phase: MarkerPhase; stepId: number }) => void }).__workbookUxTestMarker;
    if (!setter) throw new Error("Workbook UX test marker has not been installed.");
    setter({ phase: nextPhase, stepId });
  }, { phase, stepId: step.id });
  return isoNow();
}

async function waitForStableViewport(page: Page): Promise<void> {
  await page.waitForFunction(() => new Promise<boolean>((resolvePromise) => {
    const sample = () => ({ y: window.scrollY, top: document.querySelector(".current-activity-band")?.getBoundingClientRect().top ?? 0 });
    let previous = sample();
    let stable = 0;
    const tick = () => requestAnimationFrame(() => {
      const next = sample();
      if (Math.abs(next.y - previous.y) < 0.5 && Math.abs(next.top - previous.top) < 0.5) stable += 1;
      else stable = 0;
      previous = next;
      if (stable >= 4) resolvePromise(true);
      else tick();
    });
    tick();
  }), undefined, { timeout: 10_000 });
}

/** An instant scroll issued by the recorder, marked so the telemetry never attributes it to the application. */
async function recorderScrollTo(page: Page, top: number): Promise<void> {
  await page.evaluate(({ noteName, target }) => {
    const host = window as unknown as Record<string, unknown>;
    host[noteName] = "harness";
    try { window.scrollTo({ top: target, left: window.scrollX, behavior: "instant" }); }
    finally { host[noteName] = undefined; }
  }, { noteName: SCROLL_TELEMETRY_NOTE_GLOBAL, target: top });
}

/**
 * The band's natural document position. Sticky positioning displaces the band once it is stuck,
 * so the honest measurement scrolls its own section to the top of the viewport first, reads the
 * band there, and scrolls back.
 */
async function measureBandDocumentTop(page: Page): Promise<number> {
  const original = await page.evaluate(() => window.scrollY);
  const sectionTop = await page.evaluate(() => {
    const band = document.querySelector<HTMLElement>(".current-activity-band");
    const section = band?.closest("section");
    if (!band || !section) throw new Error("Cannot measure the activity band's document position because the active work surface is missing.");
    return section.getBoundingClientRect().top + window.scrollY;
  });
  await recorderScrollTo(page, sectionTop);
  const naturalTop = await page.evaluate(() => document.querySelector<HTMLElement>(".current-activity-band")!.getBoundingClientRect().top + window.scrollY);
  await recorderScrollTo(page, original);
  return naturalTop;
}

async function measureGeometry(page: Page, bandDocumentTop?: number): Promise<GeometryTelemetry> {
  const documentTop = bandDocumentTop ?? await measureBandDocumentTop(page);
  return page.evaluate((measuredDocumentTop) => {
    const band = document.querySelector<HTMLElement>(".current-activity-band");
    const work = band?.querySelector<HTMLElement>(".work-block");
    const main = document.querySelector<HTMLElement>("main");
    const composer = document.querySelector<HTMLElement>(".timeline-composer-dock");
    if (!band || !work || !main) throw new Error("Cannot measure activity band geometry because the active work surface is missing.");
    const toRect = (rect: DOMRect): RectTelemetry => ({ x: rect.x, y: rect.y, width: rect.width, height: rect.height, top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left });
    const bandRect = band.getBoundingClientRect();
    const stickyTop = Number.parseFloat(getComputedStyle(band).top) || 0;
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
      scrollY: window.scrollY,
      viewportHeight: window.innerHeight,
      bandDocumentTop: measuredDocumentTop,
      bandRect: toRect(bandRect),
      // Stuck: sticky positioning is holding the band at its offset, which is the case from the
      // moment its natural position reaches that offset.
      bandStuck: getComputedStyle(band).position === "sticky" && Math.abs(bandRect.top - stickyTop) < 1 && measuredDocumentTop - window.scrollY <= stickyTop + 0.5,
      workRect: toRect(work.getBoundingClientRect()),
      mainRect: toRect(main.getBoundingClientRect()),
      composerTop: composer ? composer.getBoundingClientRect().top : window.innerHeight,
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth,
      overflowing,
    };
  }, documentTop);
}

/** The scroll the learner would make with the wheel: animated, and marked as the recorder's own. */
async function positionBand(page: Page, state: WorkbookUxTestGeometryState): Promise<GeometryTelemetry> {
  const target = GEOMETRY_TARGETS[state];
  const bandDocumentTop = await measureBandDocumentTop(page);
  const viewportHeight = await page.evaluate(() => window.innerHeight);
  const end = Math.max(0, bandDocumentTop - target.viewportTop(viewportHeight));
  await page.evaluate(async ({ noteName, end: endY, durationMs }) => {
    const host = window as unknown as Record<string, unknown>;
    const start = window.scrollY;
    host[noteName] = "harness";
    try {
      if (Math.abs(endY - start) < 1) {
        window.scrollTo({ top: endY, behavior: "instant" });
        return;
      }
      const startedAt = performance.now();
      await new Promise<void>((resolvePromise) => {
        const tick = (now: number) => {
          const progress = Math.min(1, (now - startedAt) / durationMs);
          window.scrollTo({ top: start + (endY - start) * progress, behavior: "instant" });
          if (progress >= 1) resolvePromise();
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
    } finally {
      host[noteName] = undefined;
    }
  }, { noteName: SCROLL_TELEMETRY_NOTE_GLOBAL, end, durationMs: target.durationMs });
  await waitForStableViewport(page);
  const after = await measureGeometry(page, bandDocumentTop);
  const failure = geometryStateFailure(state, after);
  if (failure) throw new Error(`Activity band could not be placed ${state}: ${failure}`);
  return after;
}

export function geometryStateFailure(state: WorkbookUxTestGeometryState, geometry: GeometryTelemetry): string | undefined {
  const top = geometry.bandRect.top;
  if (state === "inflow") return Math.abs(top - BAND_INFLOW_TOP_PX) <= 24 ? undefined : `expected ${GEOMETRY_TARGETS.inflow.description}, measured band top ${top.toFixed(1)}`;
  if (state === "docked") {
    if (Math.abs(top) > 2) return `expected ${GEOMETRY_TARGETS.docked.description}, measured band top ${top.toFixed(1)}`;
    if (!geometry.bandStuck) return "expected the band to be stuck at the top, but it is in flow";
    if (geometry.bandRect.bottom > geometry.composerTop + 1) return `expected the docked band to fit above the composer (bottom ${geometry.bandRect.bottom.toFixed(1)} > composer top ${geometry.composerTop.toFixed(1)})`;
    return undefined;
  }
  return top >= geometry.viewportHeight ? undefined : `expected ${GEOMETRY_TARGETS.away.description}, measured band top ${top.toFixed(1)} in a ${geometry.viewportHeight}px viewport`;
}

async function feedbackTelemetry(page: Page, surface: "editor" | "terminal", expectedText: string): Promise<FeedbackTelemetry> {
  const selector = surface === "editor" ? ".editor-feedback-overlay" : ".terminal-feedback-overlay";
  await page.waitForFunction(({ selector: targetSelector, expected }) => document.querySelector(targetSelector)?.textContent?.includes(expected), { selector, expected: expectedText }, { timeout: 20_000 });
  await waitForStableViewport(page);
  return page.locator(selector).last().evaluate((element) => {
    const toRect = (rect: DOMRect): RectTelemetry => ({ x: rect.x, y: rect.y, width: rect.width, height: rect.height, top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left });
    const rect = element.getBoundingClientRect();
    const composer = document.querySelector<HTMLElement>(".timeline-composer-dock.fixed-composer, .timeline-composer-dock");
    const composerRect = composer ? composer.getBoundingClientRect() : undefined;
    const safeBottom = composerRect ? Math.max(0, composerRect.top - 8) : window.innerHeight;
    const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
    const points = [
      { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
      { x: rect.left + rect.width * 0.25, y: rect.top + rect.height / 2 },
      { x: rect.left + rect.width * 0.75, y: rect.top + rect.height / 2 },
    ].map((point) => ({ x: clamp(point.x, 0, window.innerWidth - 1), y: clamp(point.y, 0, window.innerHeight - 1) }));
    const occlusionChecks = points.map((point) => {
      const topElement = document.elementsFromPoint(point.x, point.y).find((candidate) => !(candidate instanceof HTMLElement) || candidate.style.pointerEvents !== "none");
      return {
        x: point.x,
        y: point.y,
        topElement: topElement ? `${topElement.tagName.toLowerCase()}${topElement.id ? `#${topElement.id}` : ""}${topElement.className && typeof topElement.className === "string" ? `.${topElement.className.trim().replace(/\s+/g, ".")}` : ""}` : "",
        targetContainsTopElement: topElement ? element.contains(topElement) || topElement.contains(element) : false,
      };
    });
    return {
      text: element.textContent ?? "",
      rect: toRect(rect),
      safeRegion: {
        viewport: { width: window.innerWidth, height: window.innerHeight },
        composerRect: composerRect ? toRect(composerRect) : undefined,
        safeBottom,
        insideSafeRegion: rect.top >= 0 && rect.left >= 0 && rect.right <= window.innerWidth && rect.bottom <= safeBottom,
        occlusionChecks,
        unoccluded: occlusionChecks.every((check) => check.targetContainsTopElement),
      },
    };
  });
}

async function currentState(page: Page): Promise<{ progress: { activeBlockId: string; activeAnchorId?: string; blocks: Array<{ id: string; checkpoint?: { status?: string } }> }; orderedBlocks?: Array<{ id: string; anchorId: string }> }> {
  return page.evaluate(async () => (await (await fetch("api/workbook/state")).json()));
}

/**
 * Press Continue as a learner would, wait for the server and the instant navigation, and record
 * where the successor block landed. The successor must be in the reading area: that is the
 * "newly revealed steps did not come into view" failure from the play-test, measured directly.
 */
async function clickContinue(page: Page): Promise<ContinueLanding> {
  const before = await currentState(page);
  const ordered = before.orderedBlocks ?? [];
  const index = ordered.findIndex((block) => block.id === before.progress.activeBlockId);
  const successor = ordered[index + 1];
  if (!successor) throw new Error(`No ordered successor after ${before.progress.activeBlockId} to continue into.`);
  const scrollYBefore = await page.evaluate(() => window.scrollY);
  const button = page.getByRole("button", { name: /^(?:Ready to continue|Continue)/ }).first();
  await button.waitFor({ state: "visible", timeout: 10_000 });
  await button.click();
  await page.waitForFunction(async (expected: string) => (await (await fetch("api/workbook/state")).json()).progress.activeBlockId === expected, successor.id, { timeout: 10_000 });
  await page.waitForTimeout(400);
  await waitForStableViewport(page).catch(() => undefined);
  const landing = await page.evaluate(({ from, to, anchorId, scrollYBeforeClick }) => {
    const element = document.getElementById(anchorId);
    const composer = document.querySelector<HTMLElement>(".timeline-composer-dock");
    const composerTop = composer ? composer.getBoundingClientRect().top : window.innerHeight;
    const top = element ? element.getBoundingClientRect().top : Number.POSITIVE_INFINITY;
    return { from, to, scrollYBefore: scrollYBeforeClick, scrollYAfter: window.scrollY, successorTop: top, composerTop, inView: top >= -1 && top < Math.min(composerTop, window.innerHeight) };
  }, { from: before.progress.activeBlockId, to: successor.id, anchorId: successor.anchorId, scrollYBeforeClick: scrollYBefore });
  return landing;
}

async function advanceToTerminal(page: Page, walkthrough: MutableWalkthrough): Promise<ContinueLanding | undefined> {
  const terminalBand = page.locator('.current-activity-band[data-activity-type="terminal-practice"]');
  if (await terminalBand.count() > 0) return undefined;
  const landing = await clickContinue(page);
  walkthrough.landings.push(landing);
  return landing;
}

async function revealEditor(page: Page, walkthrough: MutableWalkthrough): Promise<ContinueLanding | undefined> {
  let last: ContinueLanding | undefined;
  for (let index = 0; index < 10; index += 1) {
    if (await page.locator('.current-activity-band[data-activity-type="editor-practice"]').count()) return last;
    last = await clickContinue(page);
    walkthrough.landings.push(last);
  }
  throw new Error("The recorder could not reveal the editor activity band through visible Continue controls.");
}

async function waitForEditorAccepted(page: Page): Promise<void> {
  await page.waitForFunction(async () => {
    const state = await (await fetch("api/workbook/state")).json();
    return state.progress.blocks.some((block: any) => block.id.endsWith("--editor-draft") && block.checkpoint?.status === "accepted");
  }, undefined, { timeout: 20_000 });
}

async function typeEditorRevision(page: Page, text: string): Promise<void> {
  const content = page.locator('.current-activity-band .cm-content[contenteditable="true"]').first();
  await content.waitFor({ state: "visible", timeout: 10_000 });
  await content.click();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
  await page.keyboard.type(text, { delay: 25 });
}

async function focusTerminal(page: Page): Promise<void> {
  await page.locator(".terminal-connection-status.connected").waitFor({ state: "attached", timeout: 15_000 });
  await page.locator(".current-activity-band .embedded-terminal").click({ position: { x: 40, y: 40 } });
  const helper = page.locator(".current-activity-band .xterm-helper-textarea").first();
  await helper.waitFor({ state: "attached", timeout: 10_000 });
  await helper.focus();
}

async function typeTerminalCommand(page: Page, command: string, submit = true): Promise<void> {
  await focusTerminal(page);
  for (const char of command) await page.keyboard.type(char, { delay: 45 });
  if (submit) await page.keyboard.press("Enter");
}

async function waitForTerminalText(page: Page, expectedText: string): Promise<void> {
  await page.waitForFunction((expected) => document.querySelector(".current-activity-band .embedded-terminal")?.textContent?.includes(expected), expectedText, { timeout: 10_000 });
  await waitForStableViewport(page);
}

function fakeCounts(mainTutor: QueuedMainTutor, fakePty: ReturnType<typeof createProtocolAwareFakePty>): FakeCallCounts {
  return { mainTutorReviews: mainTutor.reviews.length, fakePtyCommands: fakePty.commandCount };
}

async function scrollOwnership(page: Page, sinceIndex: number, fromScrollY: number, typingExcursionPx?: number): Promise<ScrollOwnershipTelemetry> {
  const entries = await readScrollTelemetry(page, sinceIndex);
  const events = applicationScrollEvents(entries);
  return { applicationScrollCalls: applicationScrollCalls(entries), applicationScrollEvents: events.length, maxExcursionPx: maxScrollExcursion(events, fromScrollY), typingExcursionPx };
}

async function runScrollCheckpoint(args: {
  page: Page;
  walkthrough: MutableWalkthrough;
  step: WorkbookUxTestStepDeclaration;
  mainTutor: QueuedMainTutor;
  fakePty: ReturnType<typeof createProtocolAwareFakePty>;
  /** Learner work done before the scroll, such as a revision typed while docked. */
  prepare?: () => Promise<{ typedText?: string; command?: string }>;
  position: () => Promise<GeometryTelemetry>;
  landing?: ContinueLanding;
  progress?: WorkbookUxProgressSink;
}): Promise<void> {
  const telemetryStart = await scrollTelemetryLength(args.page);
  const before = await measureGeometry(args.page);
  const startedAt = isoNow();
  const transitionAt = await setMarker(args.page, "transition", args.step);
  await args.page.waitForTimeout(180);
  const prepared = await args.prepare?.() ?? {};
  const after = await args.position();
  const settledMarkerAt = await setMarker(args.page, "settled", args.step);
  await args.page.waitForTimeout(450);
  args.walkthrough.checkpoints.push({
    stepId: args.step.id,
    name: args.step.name,
    surface: args.step.surface,
    requestedState: args.step.requestedState,
    kind: args.step.kind,
    requiredMotion: args.step.requiredMotion,
    startedAt,
    settledAt: isoNow(),
    marker: { transitionAt, settledAt: settledMarkerAt },
    before,
    after,
    typedText: prepared.typedText,
    command: prepared.command,
    landing: args.landing,
    scroll: await scrollOwnership(args.page, telemetryStart, before.scrollY),
    fakeCallCounts: fakeCounts(args.mainTutor, args.fakePty),
  });
  args.progress?.(checkpointProgressEvent(args.walkthrough.checkpoints.length, WORKBOOK_UX_SEMANTIC_CHECKPOINT_TOTAL, args.step));
}

async function runPreparedCheckpoint(args: {
  page: Page;
  walkthrough: MutableWalkthrough;
  step: WorkbookUxTestStepDeclaration;
  mainTutor: QueuedMainTutor;
  fakePty: ReturnType<typeof createProtocolAwareFakePty>;
  prepare: () => Promise<{ typedText?: string; command?: string }>;
  trigger: () => Promise<FeedbackTelemetry>;
  progress?: WorkbookUxProgressSink;
}): Promise<void> {
  const startedAt = isoNow();
  const telemetryStart = await scrollTelemetryLength(args.page);
  const beforeTyping = await measureGeometry(args.page);
  const prepared = await args.prepare();
  const typingEntries = await readScrollTelemetry(args.page, telemetryStart);
  const typingExcursionPx = maxScrollExcursion(applicationScrollEvents(typingEntries), beforeTyping.scrollY);
  const before = await measureGeometry(args.page, beforeTyping.bandDocumentTop);
  const transitionAt = await setMarker(args.page, "transition", args.step);
  await args.page.waitForTimeout(250);
  const feedback = await args.trigger();
  const after = await measureGeometry(args.page, beforeTyping.bandDocumentTop);
  const settledMarkerAt = await setMarker(args.page, "settled", args.step);
  await args.page.waitForTimeout(450);
  args.walkthrough.checkpoints.push({
    stepId: args.step.id,
    name: args.step.name,
    surface: args.step.surface,
    requestedState: args.step.requestedState,
    kind: args.step.kind,
    requiredMotion: args.step.requiredMotion,
    startedAt,
    settledAt: isoNow(),
    marker: { transitionAt, settledAt: settledMarkerAt },
    before,
    after,
    feedback,
    typedText: prepared.typedText,
    command: prepared.command,
    scroll: await scrollOwnership(args.page, telemetryStart, beforeTyping.scrollY, typingExcursionPx),
    fakeCallCounts: fakeCounts(args.mainTutor, args.fakePty),
  });
  args.progress?.(checkpointProgressEvent(args.walkthrough.checkpoints.length, WORKBOOK_UX_SEMANTIC_CHECKPOINT_TOTAL, args.step));
}

export function assertCheckpointGeometry(checkpoint: SemanticCheckpoint, failures: string[]): void {
  if (checkpoint.after.scrollWidth > checkpoint.after.clientWidth) failures.push(`${checkpoint.name}: the page overflows horizontally (scrollWidth ${checkpoint.after.scrollWidth} > clientWidth ${checkpoint.after.clientWidth}; widest: ${checkpoint.after.overflowing.join(", ") || "unattributed"}).`);
  if (checkpoint.requestedState) {
    const failure = geometryStateFailure(checkpoint.requestedState, checkpoint.after);
    if (failure) failures.push(`${checkpoint.name}: ${failure}.`);
  }
  if (checkpoint.landing && !checkpoint.landing.inView) failures.push(`${checkpoint.name}: Continue left ${checkpoint.landing.to} out of view (top ${checkpoint.landing.successorTop.toFixed(1)}, composer top ${checkpoint.landing.composerTop.toFixed(1)}).`);
  if (checkpoint.kind !== "feedback") return;
  // The whole of the play-test's "typing bounce" and "feedback moved the page" is this check.
  const held = Math.abs(checkpoint.after.scrollY - checkpoint.before.scrollY);
  if (held > PAGE_HOLD_TOLERANCE_PX) failures.push(`${checkpoint.name}: the page moved ${held.toFixed(1)}px while feedback arrived (scrollY ${checkpoint.before.scrollY.toFixed(1)} -> ${checkpoint.after.scrollY.toFixed(1)}).`);
  if ((checkpoint.scroll.typingExcursionPx ?? 0) > PAGE_HOLD_TOLERANCE_PX) failures.push(`${checkpoint.name}: the page moved ${checkpoint.scroll.typingExcursionPx?.toFixed(1)}px while the learner typed.`);
  if (checkpoint.scroll.applicationScrollCalls.length > 0) failures.push(`${checkpoint.name}: the application scrolled the page on its own (${checkpoint.scroll.applicationScrollCalls.map((call) => call.kind).join(", ")}).`);
  if (checkpoint.feedback && checkpoint.feedback.rect.width <= 50) failures.push(`${checkpoint.name}: feedback rect is too narrow to be visible.`);
  if (checkpoint.requestedState === "away") return;
  if (checkpoint.feedback && !checkpoint.feedback.safeRegion.insideSafeRegion) failures.push(`${checkpoint.name}: feedback is outside the viewport safe region above the fixed composer.`);
  if (checkpoint.feedback && !checkpoint.feedback.safeRegion.unoccluded) failures.push(`${checkpoint.name}: feedback is occluded at representative points (${JSON.stringify(checkpoint.feedback.safeRegion.occlusionChecks)}).`);
}

export function assertRealJourneyMotionThresholdCalibration(): void {
  // The real workbook journey's shortest required scroll is the in-flow to docked move, a few
  // hundred pixels of visible translation. A scenario floor of 12px remains well above zero/static
  // codec noise while staying below the semantic browser-scroll floor that makes a checkpoint
  // motion-required.
  if (REAL_JOURNEY_MIN_REQUIRED_MOTION_PX <= 0 || REAL_JOURNEY_MIN_REQUIRED_MOTION_PX >= REQUIRED_SCROLL_SEMANTIC_DELTA_MIN_PX) {
    throw new Error(`Real journey motion threshold ${REAL_JOURNEY_MIN_REQUIRED_MOTION_PX}px must be > 0 and < semantic scroll delta ${REQUIRED_SCROLL_SEMANTIC_DELTA_MIN_PX}px.`);
  }
}

export function assertRequiredScrollTelemetry(checkpoint: SemanticCheckpoint, failures: string[]): void {
  if (!checkpoint.requiredMotion) return;
  const scrollDelta = Math.abs(checkpoint.after.scrollY - checkpoint.before.scrollY);
  if (checkpoint.kind !== "scroll") failures.push(`${checkpoint.name}: required-motion checkpoint is not a scroll step.`);
  if (scrollDelta < REQUIRED_SCROLL_SEMANTIC_DELTA_MIN_PX) failures.push(`${checkpoint.name}: required scroll telemetry did not move enough (scroll delta ${scrollDelta}).`);
}

/** Between one checkpoint settling and the next starting, nothing but the recorder may move the page. */
export function assertPageHeldBetweenCheckpoints(checkpoints: readonly SemanticCheckpoint[], failures: string[]): void {
  for (let index = 1; index < checkpoints.length; index += 1) {
    const previous = checkpoints[index - 1]!;
    const next = checkpoints[index]!;
    if (next.kind !== "feedback") continue;
    const moved = Math.abs(next.before.scrollY - previous.after.scrollY);
    if (moved > PAGE_HOLD_TOLERANCE_PX) failures.push(`${next.name}: the page moved ${moved.toFixed(1)}px between "${previous.name}" settling and this checkpoint starting.`);
  }
}

export function assertContinueLandings(landings: readonly ContinueLanding[], failures: string[]): void {
  if (landings.length === 0) failures.push("The recorder pressed no Continue control, so nothing tested where a successor lands.");
  for (const landing of landings) {
    if (!landing.inView) failures.push(`Continue from ${landing.from} left ${landing.to} out of view (top ${landing.successorTop.toFixed(1)}, composer top ${landing.composerTop.toFixed(1)}).`);
  }
}

async function copyFixture(runRoot: string): Promise<string> {
  const inputRoot = resolve(runRoot, "input");
  await cp(FIXTURE_ROOT, inputRoot, { recursive: true });
  return inputRoot;
}

async function finalizeVideo(page: Page | undefined, context: BrowserContext | undefined, runRoot: string): Promise<string | undefined> {
  const video = page?.video();
  if (context) await context.close().catch(() => undefined);
  if (!video) return undefined;
  const source = await video.path().catch(() => undefined);
  if (!source || !(await exists(source))) return undefined;
  const target = resolve(runRoot, VIDEO_PATH);
  await rm(target, { force: true });
  await rename(source, target);
  return target;
}

export function formatWorkbookUxPreparationMessage(headless: boolean | undefined): string {
  if (headless === false) return "Preparing fixture, local server, and headed browser...";
  return "Preparing fixture, local server, and headless browser...";
}

export async function recordWorkbookUxTest(options: WorkbookUxTestRecorderOptions = {}): Promise<WorkbookUxTestRecorderResult> {
  assertRealJourneyMotionThresholdCalibration();
  const progress = options.progress;
  const runRoot = options.runRoot ? resolve(options.runRoot) : RUN_ROOT;
  progress?.({ type: "stage", phase: "prepare", message: formatWorkbookUxPreparationMessage(options.headless) });
  await rm(runRoot, { recursive: true, force: true });
  await mkdir(resolve(runRoot, "analysis"), { recursive: true });
  await mkdir(resolve(runRoot, "video-raw"), { recursive: true });
  const bundleStatus = ensureFreshWebBundle(ENGINE_ROOT);
  const inputRoot = await copyFixture(runRoot);
  await collectInputMetadata(runRoot, bundleStatus);

  process.env.OPENCODE_API_KEY ??= "workbook-ux-no-model-key";
  const delayed = (decision: TutorDecision): (() => Promise<TutorDecision>) => async () => { await delay(AWAY_REVIEW_DELAY_MS); return decision; };
  const mainTutor = new QueuedMainTutor(
    // The authored workspace seeds a non-empty draft, so opening the editor deliberately triggers
    // one review before the three recorded learner revisions. Keep that review explicit so it
    // cannot consume the first named checkpoint decision while retained feedback is visible.
    { outcome: "feedback", message: "The seeded draft is ready for the learner's first revision." } satisfies TutorDecision,
    { outcome: "feedback", message: EDITOR_FEEDBACK.inflow } satisfies TutorDecision,
    { outcome: "feedback", message: EDITOR_FEEDBACK.docked } satisfies TutorDecision,
    // Held back so the feedback lands after the learner has scrolled away from the band.
    delayed({ outcome: "feedback", message: EDITOR_FEEDBACK.away }),
    { outcome: "accepted", message: EDITOR_ACCEPTED } satisfies TutorDecision,
    { outcome: "feedback", message: TERMINAL_FEEDBACK.inflow } satisfies TutorDecision,
    { outcome: "feedback", message: TERMINAL_FEEDBACK.docked } satisfies TutorDecision,
    delayed({ outcome: "feedback", message: TERMINAL_FEEDBACK.away }),
  );
  const fakePty = createProtocolAwareFakePty({ outputForCommand: (command, index) => `\r\nfake terminal ${index}: observed ${command}\r\nworkspace: refactor-line\r\nstatus: deterministic protocol marker received\r\nnext: read the feedback below\r\n` });

  let server: StartedWorkbookServer | undefined;
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let page: Page | undefined;
  let videoPath: string | undefined;
  const walkthrough: MutableWalkthrough = {
    generatedAt: isoNow(),
    runRoot,
    fixtureRoot: FIXTURE_ROOT,
    copiedFixtureRoot: inputRoot,
    videoPath: resolve(runRoot, VIDEO_PATH),
    viewport: { ...VIEWPORT, deviceScaleFactor: 1, reducedMotion: "no-preference" },
    markerProtocol: { bits: MARKER_BITS, stateCheckpointStepIds: REQUIRED_STATE_CHECKPOINT_STEP_IDS, scrollCheckpointStepIds: SCROLL_CHECKPOINT_STEP_IDS, requiredMotionStepIds: REQUIRED_MOTION_STEP_IDS },
    checkpoints: [],
    landings: [],
    fake: { mainTutorReviews: 0, ptyCommands: [] },
    semanticFailures: [],
  };

  try {
    server = await startWorkbookServer({
      target: inputRoot,
      webRoot: WEB_ROOT,
      port: 0,
      mainTutor,
      terminalPtyFactory: fakePty.create,
      logger: createWorkbookUxProgressLogger(progress),
    });
    browser = await chromium.launch({ headless: options.headless ?? true });
    await collectInputMetadata(runRoot, bundleStatus, browser.version());
    context = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: 1,
      reducedMotion: "no-preference",
      recordVideo: { dir: resolve(runRoot, "video-raw"), size: VIEWPORT },
    });
    page = await context.newPage();
    await installScrollTelemetry(page);
    await installVideoMarker(page);
    progress?.({ type: "stage", phase: "record", message: `Recording browser journey (${WORKBOOK_UX_SEMANTIC_CHECKPOINT_TOTAL} checkpoints)...` });
    await page.goto(server.url, { waitUntil: "domcontentloaded" });
    await setMarker(page, "settled", WORKBOOK_UX_TEST_STEPS.initial);
    await page.waitForTimeout(600);

    await setMarker(page, "settled", WORKBOOK_UX_TEST_STEPS.revealEditor);
    const editorLanding = await revealEditor(page, walkthrough);
    await runScrollCheckpoint({ page, walkthrough, mainTutor, fakePty, progress, step: WORKBOOK_UX_TEST_STEPS.editorScrollToInflow, landing: editorLanding, position: async () => positionBand(page!, "inflow") });

    await runPreparedCheckpoint({ page, walkthrough, mainTutor, fakePty, progress, step: WORKBOOK_UX_TEST_STEPS.editorInflowFeedback, prepare: async () => {
      const typedText = "In-flow draft: the learner notices compact feedback in the editor.\nThe typed line stays short enough to look like a first revision.";
      await typeEditorRevision(page!, typedText);
      return { typedText };
    }, trigger: async () => feedbackTelemetry(page!, "editor", EDITOR_FEEDBACK.inflow) });

    await runScrollCheckpoint({ page, walkthrough, mainTutor, fakePty, progress, step: WORKBOOK_UX_TEST_STEPS.editorScrollToDocked, position: async () => positionBand(page!, "docked") });
    await runPreparedCheckpoint({ page, walkthrough, mainTutor, fakePty, progress, step: WORKBOOK_UX_TEST_STEPS.editorDockedFeedback, prepare: async () => {
      const typedText = "Docked draft: the learner revises while the band is stuck at the top of the window.\nThey add a second visible line before pausing for feedback.\nThe surface must keep its feedback welded, and the page must not move under their hands.";
      await typeEditorRevision(page!, typedText);
      return { typedText };
    }, trigger: async () => feedbackTelemetry(page!, "editor", EDITOR_FEEDBACK.docked) });

    await runScrollCheckpoint({ page, walkthrough, mainTutor, fakePty, progress, step: WORKBOOK_UX_TEST_STEPS.editorScrollAway, prepare: async () => {
      const typedText = "Away draft: the learner types this, then scrolls back up to reread the orientation while the review runs.\nThe feedback must land on the surface without pulling the page back down.";
      await typeEditorRevision(page!, typedText);
      return { typedText };
    }, position: async () => positionBand(page!, "away") });
    await runPreparedCheckpoint({ page, walkthrough, mainTutor, fakePty, progress, step: WORKBOOK_UX_TEST_STEPS.editorAwayFeedback, prepare: async () => ({}), trigger: async () => feedbackTelemetry(page!, "editor", EDITOR_FEEDBACK.away) });

    await setMarker(page, "settled", WORKBOOK_UX_TEST_STEPS.editorAccepted);
    await positionBand(page, "docked");
    await typeEditorRevision(page, "Accepted final draft: in-flow, docked, and away feedback all left the page where the learner put it.");
    await waitForEditorAccepted(page);
    await page.waitForTimeout(450);

    const terminalLanding = await advanceToTerminal(page, walkthrough);
    await page.locator('.current-activity-band[data-activity-type="terminal-practice"]').waitFor({ state: "attached", timeout: 15_000 });
    await runScrollCheckpoint({ page, walkthrough, mainTutor, fakePty, progress, step: WORKBOOK_UX_TEST_STEPS.terminalScrollToInflow, landing: terminalLanding, position: async () => positionBand(page!, "inflow") });
    await runPreparedCheckpoint({ page, walkthrough, mainTutor, fakePty, progress, step: WORKBOOK_UX_TEST_STEPS.terminalInflowFeedback, prepare: async () => {
      const command = "printf inflow-terminal-state";
      await typeTerminalCommand(page!, command, true);
      await waitForTerminalText(page!, "fake terminal 1");
      return { command };
    }, trigger: async () => feedbackTelemetry(page!, "terminal", TERMINAL_FEEDBACK.inflow) });

    await runScrollCheckpoint({ page, walkthrough, mainTutor, fakePty, progress, step: WORKBOOK_UX_TEST_STEPS.terminalScrollToDocked, position: async () => positionBand(page!, "docked") });
    await runPreparedCheckpoint({ page, walkthrough, mainTutor, fakePty, progress, step: WORKBOOK_UX_TEST_STEPS.terminalDockedFeedback, prepare: async () => {
      const command = "printf docked-terminal-state";
      await typeTerminalCommand(page!, command, true);
      await waitForTerminalText(page!, "fake terminal 2");
      return { command };
    }, trigger: async () => feedbackTelemetry(page!, "terminal", TERMINAL_FEEDBACK.docked) });

    await runScrollCheckpoint({ page, walkthrough, mainTutor, fakePty, progress, step: WORKBOOK_UX_TEST_STEPS.terminalScrollAway, prepare: async () => {
      const command = "printf away-terminal-state";
      await typeTerminalCommand(page!, command, true);
      await waitForTerminalText(page!, "fake terminal 3");
      return { command };
    }, position: async () => positionBand(page!, "away") });
    await runPreparedCheckpoint({ page, walkthrough, mainTutor, fakePty, progress, step: WORKBOOK_UX_TEST_STEPS.terminalAwayFeedback, prepare: async () => ({}), trigger: async () => feedbackTelemetry(page!, "terminal", TERMINAL_FEEDBACK.away) });

    for (const checkpoint of walkthrough.checkpoints) {
      assertCheckpointGeometry(checkpoint, walkthrough.semanticFailures);
      assertRequiredScrollTelemetry(checkpoint, walkthrough.semanticFailures);
    }
    assertPageHeldBetweenCheckpoints(walkthrough.checkpoints, walkthrough.semanticFailures);
    assertContinueLandings(walkthrough.landings, walkthrough.semanticFailures);
    const seenStateSteps = new Set(walkthrough.checkpoints.map((checkpoint) => checkpoint.stepId));
    for (const stepId of REQUIRED_STATE_CHECKPOINT_STEP_IDS) if (!seenStateSteps.has(stepId)) walkthrough.semanticFailures.push(`Missing semantic checkpoint for marker step ${stepId}.`);
    for (const stepId of SCROLL_CHECKPOINT_STEP_IDS) if (!seenStateSteps.has(stepId)) walkthrough.semanticFailures.push(`Missing scroll checkpoint for marker step ${stepId}.`);
    for (const stepId of REQUIRED_MOTION_STEP_IDS) if (!seenStateSteps.has(stepId)) walkthrough.semanticFailures.push(`Missing required-motion checkpoint for marker step ${stepId}.`);
    if (mainTutor.reviews.length < 8) walkthrough.semanticFailures.push(`Expected at least eight Main Tutor reviews (one seeded editor draft, four editor revisions, three terminal attempts), saw ${mainTutor.reviews.length}.`);
    if (fakePty.commandCount < 3) walkthrough.semanticFailures.push(`Expected three fake PTY commands, saw ${fakePty.commandCount}.`);

    walkthrough.fake = { mainTutorReviews: mainTutor.reviews.length, ptyCommands: fakePty.commands };
    await writeFile(resolve(runRoot, WALKTHROUGH_PATH), JSON.stringify(walkthrough, null, 2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    walkthrough.semanticFailures.push(message);
    await writeFile(resolve(runRoot, "recording-error.json"), JSON.stringify({ at: isoNow(), message, stack: error instanceof Error ? error.stack : undefined, walkthrough }, null, 2));
    if (page) await page.screenshot({ path: resolve(runRoot, "recording-error.png"), fullPage: true }).catch(() => undefined);
    throw error;
  } finally {
    if (page || context) progress?.({ type: "stage", phase: "finalize-video", message: "Finalizing recorded video..." });
    videoPath = await finalizeVideo(page, context, runRoot);
    context = undefined;
    if (browser) await browser.close().catch(() => undefined);
    if (server) await server.close().catch(() => undefined);
  }

  if (!videoPath) throw new Error("Playwright did not produce a workbook UX test video.");
  walkthrough.videoPath = videoPath;
  progress?.({ type: "detail", source: "recorder", message: `  video finalized: ${videoPath}` });

  let analysis: AnalyzerReport | undefined;
  if (options.analyze ?? true) {
    progress?.({ type: "stage", phase: "decode", message: "Decoding and analysing recorded video (this can take several minutes)..." });
    analysis = await analyzeWorkbookVideo({
      videoPath,
      outputDir: resolve(runRoot, "analysis"),
      requiredMotionStepIds: REQUIRED_MOTION_STEP_IDS,
      sampleHz: 11,
      roi: { x: 360, y: 90, width: 720, height: 700 },
      maxMotionWidth: 240,
      thresholds: {
        minRequiredMotionPx: REAL_JOURNEY_MIN_REQUIRED_MOTION_PX,
        minTextureScore: REAL_JOURNEY_MIN_TEXTURE_SCORE,
      },
    });
    progress?.({ type: "detail", source: "analyzer", message: `  decoded video duration: ${analysis.video.duration.toFixed(2)}s` });
    const segmentStepIds = analysis.segments.map((segment) => segment.stepId);
    const missingSegmentIds = REQUIRED_STATE_CHECKPOINT_STEP_IDS.filter((stepId) => !segmentStepIds.includes(stepId));
    for (const stepId of missingSegmentIds) walkthrough.semanticFailures.push(`Analyzer did not decode a marker transition segment for state checkpoint ${stepId}.`);
    for (const stepId of REQUIRED_MOTION_STEP_IDS) {
      const segment = analysis.segments.find((candidate) => candidate.stepId === stepId);
      if (!segment) {
        walkthrough.semanticFailures.push(`Analyzer did not decode a marker transition segment for required-motion step ${stepId}.`);
      } else if (segment.totalAbsShiftPx < analysis.thresholds.minRequiredMotionPx) {
        walkthrough.semanticFailures.push(`Analyzer decoded required-motion step ${stepId} with only ${segment.totalAbsShiftPx.toFixed(1)} px of motion.`);
      }
    }
    if (!analysis.evidence.contactSheet) walkthrough.semanticFailures.push("Analyzer did not write a contact sheet.");
    if (!(await exists(resolve(runRoot, "analysis/motion.json")))) walkthrough.semanticFailures.push("Analyzer did not write analysis/motion.json.");
    walkthrough.analyzer = {
      ok: analysis.ok,
      requiredMotionStepIds: analysis.requiredMotionStepIds,
      markerSamples: analysis.markerSamples,
      findings: analysis.findings,
      segmentStepIds,
      evidenceFiles: analysis.evidence.frames,
      contactSheet: analysis.evidence.contactSheet,
    };
  }

  await writeFile(resolve(runRoot, WALKTHROUGH_PATH), JSON.stringify(walkthrough, null, 2));
  const failures = [...walkthrough.semanticFailures, ...(analysis?.findings.map((finding) => `${finding.code}${finding.stepId === undefined ? "" : ` step ${finding.stepId}`}: ${finding.message}`) ?? [])];
  if (failures.length > 0) {
    await writeFile(resolve(runRoot, "recording-error.json"), JSON.stringify({ at: isoNow(), message: "Workbook UX deterministic run failed.", failures, walkthrough }, null, 2));
    throw new Error(`Workbook UX deterministic run failed:\n${failures.map((failure) => ` - ${failure}`).join("\n")}`);
  }

  progress?.((options.analyze ?? true)
    ? { type: "status", phase: "deterministic", status: "passed", message: "Deterministic recording and analysis passed." }
    : { type: "status", phase: "record", status: "complete", message: "Recording complete." });
  return { runRoot, videoPath, walkthroughPath: resolve(runRoot, WALKTHROUGH_PATH), analysis, walkthrough };
}

function parseCliOptions(argv: readonly string[]): WorkbookUxTestRecorderOptions {
  const analyze = argv.includes("--record-only") ? false : argv.includes("--analyze") ? true : true;
  const headless = argv.includes("--headed") ? false : true;
  const runRootArg = argv.find((arg) => arg.startsWith("--run-root="));
  return { analyze, headless, runRoot: runRootArg ? resolve(runRootArg.slice("--run-root=".length)) : undefined };
}

const consoleProgress: WorkbookUxProgressSink = (event) => console.log(event.message);

if (basename(process.argv[1] ?? "") === "record.mts") {
  recordWorkbookUxTest({ ...parseCliOptions(process.argv.slice(2)), progress: consoleProgress }).then((result) => {
    console.log("Recording verdict: PASS");
    console.log(`Video: ${result.videoPath}`);
    console.log(`Walkthrough: ${result.walkthroughPath}`);
    if (result.analysis) console.log(`Analysis: ${resolve(result.runRoot, "analysis/motion.json")}`);
  }).catch((error) => {
    console.error("Recording verdict: FAIL");
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
