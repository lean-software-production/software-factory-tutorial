#!/usr/bin/env npx tsx
import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { startWorkbookServer, type StartedWorkbookServer } from "../../src/workbook/server.js";
import type { PracticeCoachOutcome } from "../../src/workbook/practice-coach.js";
import type { TutorDecision } from "../../src/workbook/tutor.js";
import { ENGINE_ROOT, WEB_BUNDLE_DIRECTORY, ensureFreshWebBundle } from "../support/web-bundle.js";
import { QueuedMainTutor, RecordingPracticeCoach } from "../support/fake-tutors.js";
import { analyzeWorkbookVideo, type AnalyzerReport } from "./analyzer.js";
import { createProtocolAwareFakePty } from "./fake-pty.js";
import { MARKER_BITS, MARKER_COLOURS, MARKER_CELL_SIZE, MARKER_GAP, MARKER_TOTAL_CELLS, markerCss, rgbCss } from "./marker-protocol.js";
import { REQUIRED_MOTION_STEP_IDS, REQUIRED_STATE_CHECKPOINT_STEP_IDS, SCROLL_CHECKPOINT_STEP_IDS, WORKBOOK_FACTORY_STEPS, type WorkbookFactoryGeometryState, type WorkbookFactoryStepDeclaration } from "./steps.js";

const RUN_ROOT = resolve(ENGINE_ROOT, "test/.tmp/workbook-factory/latest");
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
const GEOMETRY_TARGETS: Record<WorkbookFactoryGeometryState, { naturalTop: number; minExpand: number; maxExpand: number }> = {
  small: { naturalTop: 285, minExpand: 0, maxExpand: 0.08 },
  mid: { naturalTop: 130, minExpand: 0.25, maxExpand: 0.75 },
  full: { naturalTop: 0, minExpand: 0.92, maxExpand: 1 },
};

const EDITOR_FEEDBACK = {
  small: "EDITOR_FEEDBACK_SMALL_STATE: the small activity band feedback has settled.",
  mid: "EDITOR_FEEDBACK_MID_STATE: the mid-scroll activity band feedback has settled.",
  full: "EDITOR_FEEDBACK_FULL_STATE: the full-width activity band feedback has settled.",
};
const EDITOR_ACCEPTED = "EDITOR_ACCEPTED_FINAL_STATE: accepted draft unlocks the terminal.";
const COACH_FEEDBACK = {
  small: "COACH_FEEDBACK_SMALL_STATE: Practice Coach feedback settled while the terminal band is small.",
  mid: "COACH_FEEDBACK_MID_STATE: Practice Coach feedback settled while the terminal band is mid-scroll.",
  full: "COACH_FEEDBACK_FULL_STATE: Practice Coach feedback settled while the terminal band is full-width.",
};

export interface RectTelemetry { readonly x: number; readonly y: number; readonly width: number; readonly height: number; readonly top: number; readonly right: number; readonly bottom: number; readonly left: number; }
export interface GeometryTelemetry {
  readonly expand: number;
  readonly scrollY: number;
  readonly bandDocumentTop: number;
  readonly bandRect: RectTelemetry;
  readonly workRect: RectTelemetry;
  readonly mainRect: RectTelemetry;
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
export interface FakeCallCounts { readonly mainTutorReviews: number; readonly practiceCoachAssessments: number; readonly fakePtyCommands: number; }
export interface SemanticCheckpoint {
  readonly stepId: number;
  readonly name: string;
  readonly surface: string;
  readonly requestedState?: WorkbookFactoryGeometryState;
  readonly kind: WorkbookFactoryStepDeclaration["kind"];
  readonly requiredMotion: boolean;
  readonly startedAt: string;
  readonly settledAt: string;
  readonly marker: { readonly transitionAt: string; readonly settledAt: string };
  readonly before: GeometryTelemetry;
  readonly after: GeometryTelemetry;
  readonly feedback?: FeedbackTelemetry;
  readonly typedText?: string;
  readonly command?: string;
  readonly fakeCallCounts: FakeCallCounts;
}
export interface WorkbookFactoryWalkthrough {
  readonly generatedAt: string;
  readonly runRoot: string;
  readonly fixtureRoot: string;
  readonly copiedFixtureRoot: string;
  readonly videoPath: string;
  readonly viewport: typeof VIEWPORT & { readonly deviceScaleFactor: 1; readonly reducedMotion: "no-preference" };
  readonly markerProtocol: { readonly bits: number; readonly stateCheckpointStepIds: readonly number[]; readonly scrollCheckpointStepIds: readonly number[]; readonly requiredMotionStepIds: readonly number[] };
  readonly checkpoints: SemanticCheckpoint[];
  readonly fake: { readonly mainTutorReviews: number; readonly practiceCoachAssessments: number; readonly ptyCommands: readonly unknown[] };
  readonly analyzer?: Pick<AnalyzerReport, "ok" | "requiredMotionStepIds" | "markerSamples" | "findings"> & { readonly segmentStepIds: number[]; readonly evidenceFiles: readonly string[]; readonly contactSheet?: string };
  readonly semanticFailures: string[];
}
export interface WorkbookFactoryRecorderOptions {
  readonly runRoot?: string;
  readonly analyze?: boolean;
  readonly headless?: boolean;
}
export interface WorkbookFactoryRecorderResult {
  readonly runRoot: string;
  readonly videoPath: string;
  readonly walkthroughPath: string;
  readonly analysis?: AnalyzerReport;
  readonly walkthrough: WorkbookFactoryWalkthrough;
}

type MarkerPhase = "settled" | "transition";

type Mutable<T> = { -readonly [Property in keyof T]: T[Property] };
type MutableWalkthrough = Mutable<Omit<WorkbookFactoryWalkthrough, "checkpoints" | "semanticFailures" | "fake" | "videoPath">> & {
  checkpoints: SemanticCheckpoint[];
  semanticFailures: string[];
  fake: Mutable<WorkbookFactoryWalkthrough["fake"]>;
  videoPath: string;
  analyzer?: WorkbookFactoryWalkthrough["analyzer"];
};

function isoNow(): string { return new Date().toISOString(); }
function sleep(ms: number): Promise<void> { return new Promise((resolvePromise) => setTimeout(resolvePromise, ms)); }
function rectTelemetry(rect: DOMRect | DOMRectReadOnly): RectTelemetry {
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left };
}
function shell(command: string, cwd = ENGINE_ROOT): string {
  return execFileSync(command, { cwd, shell: "/bin/bash", encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
async function exists(path: string): Promise<boolean> { try { await stat(path); return true; } catch { return false; } }
class SlowRecordingPracticeCoach extends RecordingPracticeCoach {
  override async assess(input: Parameters<RecordingPracticeCoach["assess"]>[0]): ReturnType<RecordingPracticeCoach["assess"]> {
    await sleep(2_000);
    return super.assess(input);
  }
}

async function collectInputMetadata(runRoot: string, bundleStatus: ReturnType<typeof ensureFreshWebBundle>, browserVersion?: string): Promise<Record<string, unknown>> {
  const packageJson = JSON.parse(await readFile(resolve(ENGINE_ROOT, "package.json"), "utf8")) as Record<string, unknown>;
  const packageLock = JSON.parse(await readFile(resolve(ENGINE_ROOT, "../package-lock.json"), "utf8")) as Record<string, unknown>;
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
    package: { name: packageJson.name, version: packageJson.version, playwright: (packageJson.devDependencies as Record<string, string> | undefined)?.playwright, lockfileVersion: packageLock.lockfileVersion },
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
      if (!document.getElementById("workbook-factory-marker-style")) {
        const style = document.createElement("style");
        style.id = "workbook-factory-marker-style";
        style.textContent = css;
        (document.head || root).appendChild(style);
      }
      let marker = document.querySelector<HTMLElement>(".wf-marker");
      if (!marker) {
        marker = document.createElement("div");
        marker.className = "wf-marker";
        marker.setAttribute("aria-hidden", "true");
        for (let index = 0; index < totalCells; index += 1) {
          const cell = document.createElement("div");
          cell.className = "wf-marker-cell";
          cell.dataset.markerCell = String(index);
          cell.style.width = `${cellSize}px`;
          cell.style.height = `${cellSize}px`;
          marker.appendChild(cell);
        }
        (document.body || root).appendChild(marker);
      }
      marker.dataset.markerStep = String(state.stepId);
      marker.dataset.markerPhase = state.phase;
      const cells = Array.from(marker.querySelectorAll<HTMLElement>(".wf-marker-cell"));
      const colourFor = (index: number): string => {
        if (index === 0) return colours.guard;
        if (index === 1) return state.phase === "settled" ? colours.settled : colours.transition;
        return bitFor(state.stepId, index - 2) === 1 ? colours.one : colours.zero;
      };
      cells.forEach((cell, index) => { cell.style.background = colourFor(index); });
    };
    Object.defineProperty(window, "__workbookFactoryMarker", {
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

async function setMarker(page: Page, phase: MarkerPhase, step: WorkbookFactoryStepDeclaration): Promise<string> {
  await page.evaluate(({ phase: nextPhase, stepId }) => {
    const setter = (window as unknown as { __workbookFactoryMarker?: (state: { phase: MarkerPhase; stepId: number }) => void }).__workbookFactoryMarker;
    if (!setter) throw new Error("Workbook factory marker has not been installed.");
    setter({ phase: nextPhase, stepId });
  }, { phase, stepId: step.id });
  return isoNow();
}

async function waitForStableViewport(page: Page): Promise<void> {
  await page.waitForFunction(() => new Promise<boolean>((resolvePromise) => {
    const sample = () => ({ y: window.scrollY, expand: Number(getComputedStyle(document.querySelector(".current-activity-band") as Element).getPropertyValue("--activity-expand")) || 0 });
    let previous = sample();
    let stable = 0;
    const tick = () => requestAnimationFrame(() => {
      const next = sample();
      if (Math.abs(next.y - previous.y) < 0.5 && Math.abs(next.expand - previous.expand) < 0.005) stable += 1;
      else stable = 0;
      previous = next;
      if (stable >= 4) resolvePromise(true);
      else tick();
    });
    tick();
  }), undefined, { timeout: 10_000 });
}

async function measureGeometry(page: Page): Promise<GeometryTelemetry> {
  return page.evaluate(() => {
    const band = document.querySelector<HTMLElement>(".current-activity-band");
    const work = band?.querySelector<HTMLElement>(".work-block");
    const main = document.querySelector<HTMLElement>("main");
    if (!band || !work || !main) throw new Error("Cannot measure activity band geometry because the active work surface is missing.");
    let bandDocumentTop = 0;
    let current: HTMLElement | null = band;
    while (current) { bandDocumentTop += current.offsetTop; current = current.offsetParent as HTMLElement | null; }
    if (bandDocumentTop <= 0) bandDocumentTop = band.getBoundingClientRect().top + window.scrollY;
    const toRect = (rect: DOMRect): RectTelemetry => ({ x: rect.x, y: rect.y, width: rect.width, height: rect.height, top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left });
    return {
      expand: Number(getComputedStyle(band).getPropertyValue("--activity-expand")) || 0,
      scrollY: window.scrollY,
      bandDocumentTop,
      bandRect: toRect(band.getBoundingClientRect()),
      workRect: toRect(work.getBoundingClientRect()),
      mainRect: toRect(main.getBoundingClientRect()),
    };
  });
}

async function positionBand(page: Page, state: WorkbookFactoryGeometryState): Promise<GeometryTelemetry> {
  const target = GEOMETRY_TARGETS[state];
  const before = await measureGeometry(page);
  await page.evaluate(async ({ bandDocumentTop, naturalTop }) => {
    const start = window.scrollY;
    const end = Math.max(0, bandDocumentTop - naturalTop);
    if (Math.abs(end - start) < 1) {
      window.scrollTo(0, end);
      return;
    }
    const durationMs = 900;
    const startedAt = performance.now();
    await new Promise<void>((resolvePromise) => {
      const tick = (now: number) => {
        const progress = Math.min(1, (now - startedAt) / durationMs);
        window.scrollTo(0, start + (end - start) * progress);
        if (progress >= 1) resolvePromise();
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  }, { bandDocumentTop: before.bandDocumentTop, naturalTop: target.naturalTop });
  await waitForStableViewport(page);
  const after = await measureGeometry(page);
  if (after.expand < target.minExpand || after.expand > target.maxExpand) {
    throw new Error(`Activity band ${state} expansion out of range: measured ${after.expand}, expected ${target.minExpand}..${target.maxExpand}`);
  }
  return after;
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

async function clickContinue(page: Page): Promise<void> {
  const button = page.getByRole("button", { name: /^(?:Ready to continue|Continue)/ }).first();
  await button.waitFor({ state: "visible", timeout: 10_000 });
  await button.click();
}

async function revealEditor(page: Page): Promise<void> {
  for (let index = 0; index < 10; index += 1) {
    if (await page.locator('.current-activity-band[data-activity-type="editor-practice"]').count()) return;
    await clickContinue(page);
    await page.waitForTimeout(500);
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

function fakeCounts(mainTutor: QueuedMainTutor, coach: RecordingPracticeCoach, fakePty: ReturnType<typeof createProtocolAwareFakePty>): FakeCallCounts {
  return { mainTutorReviews: mainTutor.reviews.length, practiceCoachAssessments: coach.assessments.length, fakePtyCommands: fakePty.commandCount };
}

async function runScrollCheckpoint(args: {
  page: Page;
  walkthrough: MutableWalkthrough;
  step: WorkbookFactoryStepDeclaration;
  mainTutor: QueuedMainTutor;
  coach: RecordingPracticeCoach;
  fakePty: ReturnType<typeof createProtocolAwareFakePty>;
  position: () => Promise<GeometryTelemetry>;
}): Promise<void> {
  const before = await measureGeometry(args.page);
  const startedAt = isoNow();
  const transitionAt = await setMarker(args.page, "transition", args.step);
  await args.page.waitForTimeout(180);
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
    fakeCallCounts: fakeCounts(args.mainTutor, args.coach, args.fakePty),
  });
}

async function runPreparedCheckpoint(args: {
  page: Page;
  walkthrough: MutableWalkthrough;
  step: WorkbookFactoryStepDeclaration;
  mainTutor: QueuedMainTutor;
  coach: RecordingPracticeCoach;
  fakePty: ReturnType<typeof createProtocolAwareFakePty>;
  prepare: () => Promise<{ typedText?: string; command?: string }>;
  trigger: () => Promise<FeedbackTelemetry>;
}): Promise<void> {
  const startedAt = isoNow();
  const prepared = await args.prepare();
  const before = await measureGeometry(args.page);
  const transitionAt = await setMarker(args.page, "transition", args.step);
  await args.page.waitForTimeout(250);
  const feedback = await args.trigger();
  const after = await measureGeometry(args.page);
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
    fakeCallCounts: fakeCounts(args.mainTutor, args.coach, args.fakePty),
  });
}

function assertCheckpointGeometry(checkpoint: SemanticCheckpoint, failures: string[]): void {
  if (!checkpoint.requestedState) return;
  const range = GEOMETRY_TARGETS[checkpoint.requestedState];
  if (checkpoint.after.expand < range.minExpand || checkpoint.after.expand > range.maxExpand) {
    failures.push(`${checkpoint.name}: measured expand ${checkpoint.after.expand}, expected ${range.minExpand}..${range.maxExpand}`);
  }
  if (checkpoint.feedback && checkpoint.feedback.rect.width <= 50) failures.push(`${checkpoint.name}: feedback rect is too narrow to be visible.`);
  if (checkpoint.feedback && !checkpoint.feedback.safeRegion.insideSafeRegion) failures.push(`${checkpoint.name}: feedback is outside the viewport safe region above the fixed composer.`);
  if (checkpoint.feedback && !checkpoint.feedback.safeRegion.unoccluded) failures.push(`${checkpoint.name}: feedback is occluded at representative points (${JSON.stringify(checkpoint.feedback.safeRegion.occlusionChecks)}).`);
}

export function assertRealJourneyMotionThresholdCalibration(): void {
  // The real workbook journey's mid-to-full expansion produces a smaller visible translation than
  // synthetic fixtures. A scenario floor of 12px remains well above zero/static codec noise while
  // staying below the semantic browser-scroll floor that makes a checkpoint motion-required.
  if (REAL_JOURNEY_MIN_REQUIRED_MOTION_PX <= 0 || REAL_JOURNEY_MIN_REQUIRED_MOTION_PX >= REQUIRED_SCROLL_SEMANTIC_DELTA_MIN_PX) {
    throw new Error(`Real journey motion threshold ${REAL_JOURNEY_MIN_REQUIRED_MOTION_PX}px must be > 0 and < semantic scroll delta ${REQUIRED_SCROLL_SEMANTIC_DELTA_MIN_PX}px.`);
  }
}

function assertRequiredScrollTelemetry(checkpoint: SemanticCheckpoint, failures: string[]): void {
  if (!checkpoint.requiredMotion) return;
  const scrollDelta = Math.abs(checkpoint.after.scrollY - checkpoint.before.scrollY);
  const expandDelta = Math.abs(checkpoint.after.expand - checkpoint.before.expand);
  if (checkpoint.kind !== "scroll") failures.push(`${checkpoint.name}: required-motion checkpoint is not a scroll step.`);
  if (scrollDelta < REQUIRED_SCROLL_SEMANTIC_DELTA_MIN_PX && expandDelta < 0.2) failures.push(`${checkpoint.name}: required scroll telemetry did not move enough (scroll delta ${scrollDelta}, expand delta ${expandDelta}).`);
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

export async function recordWorkbookFactory(options: WorkbookFactoryRecorderOptions = {}): Promise<WorkbookFactoryRecorderResult> {
  assertRealJourneyMotionThresholdCalibration();
  const runRoot = options.runRoot ? resolve(options.runRoot) : RUN_ROOT;
  await rm(runRoot, { recursive: true, force: true });
  await mkdir(resolve(runRoot, "analysis"), { recursive: true });
  await mkdir(resolve(runRoot, "video-raw"), { recursive: true });
  const bundleStatus = ensureFreshWebBundle(ENGINE_ROOT);
  const inputRoot = await copyFixture(runRoot);
  await collectInputMetadata(runRoot, bundleStatus);

  process.env.OPENCODE_API_KEY ??= "workbook-factory-no-model-key";
  const mainTutor = new QueuedMainTutor(
    { outcome: "feedback", message: EDITOR_FEEDBACK.small } satisfies TutorDecision,
    { outcome: "feedback", message: EDITOR_FEEDBACK.mid } satisfies TutorDecision,
    { outcome: "feedback", message: EDITOR_FEEDBACK.full } satisfies TutorDecision,
    { outcome: "accepted", message: EDITOR_ACCEPTED } satisfies TutorDecision,
  );
  const coach = new SlowRecordingPracticeCoach();
  coach.queue.push(
    { outcome: "feedback", text: COACH_FEEDBACK.small } satisfies PracticeCoachOutcome,
    { outcome: "feedback", text: COACH_FEEDBACK.mid } satisfies PracticeCoachOutcome,
    { outcome: "feedback", text: COACH_FEEDBACK.full } satisfies PracticeCoachOutcome,
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
    fake: { mainTutorReviews: 0, practiceCoachAssessments: 0, ptyCommands: [] },
    semanticFailures: [],
  };

  try {
    server = await startWorkbookServer({
      target: inputRoot,
      webRoot: WEB_ROOT,
      port: 0,
      mainTutor,
      practiceCoach: coach,
      terminalPtyFactory: fakePty.factory,
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
    await installVideoMarker(page);
    await page.goto(server.url, { waitUntil: "domcontentloaded" });
    await setMarker(page, "settled", WORKBOOK_FACTORY_STEPS.initial);
    await page.waitForTimeout(600);

    await setMarker(page, "settled", WORKBOOK_FACTORY_STEPS.revealEditor);
    await revealEditor(page);
    await runScrollCheckpoint({ page, walkthrough, mainTutor, coach, fakePty, step: WORKBOOK_FACTORY_STEPS.editorScrollToSmall, position: async () => positionBand(page!, "small") });

    await runPreparedCheckpoint({ page, walkthrough, mainTutor, coach, fakePty, step: WORKBOOK_FACTORY_STEPS.editorSmallFeedback, prepare: async () => {
      const typedText = "Small-state draft: the learner notices compact feedback in the editor.\nThe typed line stays short enough to look like a first revision.";
      await typeEditorRevision(page!, typedText);
      return { typedText };
    }, trigger: async () => feedbackTelemetry(page!, "editor", EDITOR_FEEDBACK.small) });

    await runScrollCheckpoint({ page, walkthrough, mainTutor, coach, fakePty, step: WORKBOOK_FACTORY_STEPS.editorScrollToMid, position: async () => positionBand(page!, "mid") });
    await runPreparedCheckpoint({ page, walkthrough, mainTutor, coach, fakePty, step: WORKBOOK_FACTORY_STEPS.editorMidFeedback, prepare: async () => {
      const typedText = "Mid-scroll draft: the learner revises while the activity band is partially expanded.\nThey add a second visible line before pausing for feedback.\nThe surface should keep its feedback welded during the scroll-linked resize.";
      await typeEditorRevision(page!, typedText);
      return { typedText };
    }, trigger: async () => feedbackTelemetry(page!, "editor", EDITOR_FEEDBACK.mid) });

    await runScrollCheckpoint({ page, walkthrough, mainTutor, coach, fakePty, step: WORKBOOK_FACTORY_STEPS.editorScrollToFull, position: async () => positionBand(page!, "full") });
    await runPreparedCheckpoint({ page, walkthrough, mainTutor, coach, fakePty, step: WORKBOOK_FACTORY_STEPS.editorFullFeedback, prepare: async () => {
      const typedText = "Full-width draft: the learner checks that feedback remains welded to the editor surface.\nThis longer note creates real text texture across the editor viewport.\nThe final visible line names the full-width state before feedback arrives.\nA fourth line keeps the cursor moving like an actual revision.\nA fifth line makes the full-width editor less empty in the recording.\nA sixth line gives the deterministic analyzer text edges to track.";
      await typeEditorRevision(page!, typedText);
      return { typedText };
    }, trigger: async () => feedbackTelemetry(page!, "editor", EDITOR_FEEDBACK.full) });

    await setMarker(page, "settled", WORKBOOK_FACTORY_STEPS.editorAccepted);
    await typeEditorRevision(page, "Accepted final draft: small, mid-scroll, and full-width feedback all stayed stable.");
    await waitForEditorAccepted(page);
    await page.waitForTimeout(450);

    await clickContinue(page);
    await page.locator('.current-activity-band[data-activity-type="terminal-practice"]').waitFor({ state: "attached", timeout: 15_000 });
    await runScrollCheckpoint({ page, walkthrough, mainTutor, coach, fakePty, step: WORKBOOK_FACTORY_STEPS.terminalScrollToSmall, position: async () => positionBand(page!, "small") });
    await runPreparedCheckpoint({ page, walkthrough, mainTutor, coach, fakePty, step: WORKBOOK_FACTORY_STEPS.terminalSmallFeedback, prepare: async () => {
      const command = "printf small-terminal-state";
      await typeTerminalCommand(page!, command, true);
      await waitForTerminalText(page!, "fake terminal 1");
      return { command };
    }, trigger: async () => feedbackTelemetry(page!, "terminal", COACH_FEEDBACK.small) });

    await runScrollCheckpoint({ page, walkthrough, mainTutor, coach, fakePty, step: WORKBOOK_FACTORY_STEPS.terminalScrollToMid, position: async () => positionBand(page!, "mid") });
    await runPreparedCheckpoint({ page, walkthrough, mainTutor, coach, fakePty, step: WORKBOOK_FACTORY_STEPS.terminalMidFeedback, prepare: async () => {
      const command = "printf mid-terminal-state";
      await typeTerminalCommand(page!, command, true);
      await waitForTerminalText(page!, "fake terminal 2");
      return { command };
    }, trigger: async () => feedbackTelemetry(page!, "terminal", COACH_FEEDBACK.mid) });

    await runScrollCheckpoint({ page, walkthrough, mainTutor, coach, fakePty, step: WORKBOOK_FACTORY_STEPS.terminalScrollToFull, position: async () => positionBand(page!, "full") });
    await runPreparedCheckpoint({ page, walkthrough, mainTutor, coach, fakePty, step: WORKBOOK_FACTORY_STEPS.terminalFullFeedback, prepare: async () => {
      const command = "printf full-terminal-state";
      await typeTerminalCommand(page!, command, true);
      await waitForTerminalText(page!, "fake terminal 3");
      return { command };
    }, trigger: async () => feedbackTelemetry(page!, "terminal", COACH_FEEDBACK.full) });

    for (const checkpoint of walkthrough.checkpoints) {
      assertCheckpointGeometry(checkpoint, walkthrough.semanticFailures);
      assertRequiredScrollTelemetry(checkpoint, walkthrough.semanticFailures);
    }
    const seenStateSteps = new Set(walkthrough.checkpoints.map((checkpoint) => checkpoint.stepId));
    for (const stepId of REQUIRED_STATE_CHECKPOINT_STEP_IDS) if (!seenStateSteps.has(stepId)) walkthrough.semanticFailures.push(`Missing semantic checkpoint for marker step ${stepId}.`);
    for (const stepId of SCROLL_CHECKPOINT_STEP_IDS) if (!seenStateSteps.has(stepId)) walkthrough.semanticFailures.push(`Missing scroll checkpoint for marker step ${stepId}.`);
    for (const stepId of REQUIRED_MOTION_STEP_IDS) if (!seenStateSteps.has(stepId)) walkthrough.semanticFailures.push(`Missing required-motion checkpoint for marker step ${stepId}.`);
    if (mainTutor.reviews.length < 4) walkthrough.semanticFailures.push(`Expected at least four Main Tutor editor reviews, saw ${mainTutor.reviews.length}.`);
    if (coach.assessments.length < 3) walkthrough.semanticFailures.push(`Expected three Practice Coach assessments, saw ${coach.assessments.length}.`);
    if (fakePty.commandCount < 3) walkthrough.semanticFailures.push(`Expected three fake PTY commands, saw ${fakePty.commandCount}.`);

    walkthrough.fake = { mainTutorReviews: mainTutor.reviews.length, practiceCoachAssessments: coach.assessments.length, ptyCommands: fakePty.commands };
    await writeFile(resolve(runRoot, WALKTHROUGH_PATH), JSON.stringify(walkthrough, null, 2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    walkthrough.semanticFailures.push(message);
    await writeFile(resolve(runRoot, "recording-error.json"), JSON.stringify({ at: isoNow(), message, stack: error instanceof Error ? error.stack : undefined, walkthrough }, null, 2));
    if (page) await page.screenshot({ path: resolve(runRoot, "recording-error.png"), fullPage: true }).catch(() => undefined);
    throw error;
  } finally {
    videoPath = await finalizeVideo(page, context, runRoot);
    context = undefined;
    if (browser) await browser.close().catch(() => undefined);
    if (server) await server.close().catch(() => undefined);
  }

  if (!videoPath) throw new Error("Playwright did not produce a workbook UX test video.");
  walkthrough.videoPath = videoPath;

  let analysis: AnalyzerReport | undefined;
  if (options.analyze ?? true) {
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

  return { runRoot, videoPath, walkthroughPath: resolve(runRoot, WALKTHROUGH_PATH), analysis, walkthrough };
}

function parseCliOptions(argv: readonly string[]): WorkbookFactoryRecorderOptions {
  const analyze = argv.includes("--record-only") ? false : argv.includes("--analyze") ? true : true;
  const headless = argv.includes("--headed") ? false : true;
  const runRootArg = argv.find((arg) => arg.startsWith("--run-root="));
  return { analyze, headless, runRoot: runRootArg ? resolve(runRootArg.slice("--run-root=".length)) : undefined };
}

if (basename(process.argv[1] ?? "") === "record.mts") {
  recordWorkbookFactory(parseCliOptions(process.argv.slice(2))).then((result) => {
    console.log(`Workbook UX test recording complete: ${result.videoPath}`);
    console.log(`Walkthrough: ${result.walkthroughPath}`);
    if (result.analysis) console.log(`Analysis: ${resolve(result.runRoot, "analysis/motion.json")}`);
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
