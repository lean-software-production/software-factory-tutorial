#!/usr/bin/env npx tsx
/**
 * Diagnostic real-browser trace for Continue-button scrolling.
 *
 * This boots the real workbook UI/server against a temporary copy of the visual fixture, clicks
 * the first three authored Continue controls, and prints the resulting scroll/navigation trace as
 * compact JSON. It intentionally does not assert a preferred scroll position: the trace is for
 * inspecting today's behavior before choosing a product policy.
 *
 *   npm run --workspace=tutorial-engine build:web:workbook
 *   cd tutorial-engine && npx tsx test/continue-scroll.mts
 */
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { startWorkbookServer } from "../src/workbook/server.js";
import { QueuedMainTutor, RecordingBlockTutor } from "./support/fake-tutors.js";

const webRoot = resolve(import.meta.dirname, "../dist/web-workbook");
const fixtureRoot = resolve(import.meta.dirname, "fixtures/visual-workbook");
const failures: string[] = [];
const silentLogger = { info() {}, error() {} };

function check(condition: boolean, description: string): void {
  if (!condition) failures.push(description);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function waitFor(condition: () => boolean | Promise<boolean>, description: string, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return true;
    await delay(50);
  }
  failures.push(description);
  return false;
}

async function main(): Promise<void> {
  try { await readFile(resolve(webRoot, "index.html")); }
  catch { throw new Error("Build the workbook UI first: npm run --workspace=tutorial-engine build:web:workbook"); }

  const moduleName = "playwright";
  let playwright: { chromium: { launch(options?: unknown): Promise<any> } };
  try { playwright = await import(moduleName) as typeof playwright; }
  catch { throw new Error("Continue-scroll diagnostic needs Playwright. Install it with `npm install --no-save -D playwright`, then `npx playwright install chromium`."); }

  const workspace = await mkdtemp(resolve(tmpdir(), "continue-scroll-"));
  await cp(fixtureRoot, workspace, { recursive: true });
  await mkdir(resolve(workspace, "factory"), { recursive: true });
  await writeFile(resolve(workspace, "factory/answer.md"), "A draft for the visual fixture.\n");

  const server = await startWorkbookServer({
    target: workspace,
    webRoot,
    port: 0,
    embeddedTerminal: false,
    mainTutor: new QueuedMainTutor(),
    blockTutor: new RecordingBlockTutor(),
    logger: silentLogger,
  });
  const browser = await playwright.chromium.launch();
  const trace: any[] = [];
  let scrollCallCursor = 0;

  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1, reducedMotion: "reduce" });
    await page.addInitScript(() => {
      (globalThis as unknown as { __name: unknown }).__name = (value: unknown) => value;
      const calls: any[] = [];
      (window as any).__scrollIntoViewCalls = calls;
      const original = Element.prototype.scrollIntoView;
      const rectOf = (element: Element) => {
        const rect = element.getBoundingClientRect();
        return {
          top: Math.round(rect.top),
          right: Math.round(rect.right),
          bottom: Math.round(rect.bottom),
          left: Math.round(rect.left),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        };
      };
      const normalizeOptions = (options: any) => {
        if (options === undefined || typeof options === "boolean") return options;
        return { behavior: options.behavior, block: options.block, inline: options.inline };
      };
      Element.prototype.scrollIntoView = function (this: Element, ...args: any[]) {
        const options = args.length === 0 ? undefined : args[0];
        const before = rectOf(this);
        const call = {
          atMs: Math.round(performance.now()),
          target: {
            tagName: this.tagName,
            id: this.id || undefined,
            className: typeof (this as HTMLElement).className === "string" ? (this as HTMLElement).className : undefined,
            text: (this.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 140),
          },
          options: normalizeOptions(options),
          rectBefore: before,
          scrollYBefore: Math.round(window.scrollY),
          scrollHeightBefore: document.documentElement.scrollHeight,
          viewportHeight: window.innerHeight,
          hashBefore: location.hash,
        } as any;
        const result = original.apply(this, args as [arg?: boolean | ScrollIntoViewOptions]);
        call.rectAfter = rectOf(this);
        call.scrollYAfter = Math.round(window.scrollY);
        call.scrollHeightAfter = document.documentElement.scrollHeight;
        call.hashAfter = location.hash;
        calls.push(call);
        return result;
      };
    });

    const snapshot = async (label: string, expectedSuccessor?: any) => {
      const sample = await page.evaluate(async ({ snapshotLabel, fromScrollCall, successor }: { snapshotLabel: string; fromScrollCall: number; successor?: any }) => {
        const rectOf = (element: Element | null) => {
          if (!element) return null;
          const rect = element.getBoundingClientRect();
          return {
            top: Math.round(rect.top),
            right: Math.round(rect.right),
            bottom: Math.round(rect.bottom),
            left: Math.round(rect.left),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          };
        };
        const visible = (element: HTMLElement) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
        };
        const state = await fetch("/api/workbook/state").then((response) => response.json()).catch((error) => ({ error: String(error) }));
        const activeBlock = document.querySelector('[data-active-block="true"]') as HTMLElement | null;
        const candidateButtons = [...document.querySelectorAll('[data-active-block="true"] button')]
          .filter((button): button is HTMLButtonElement => button instanceof HTMLButtonElement)
          .filter((button) => visible(button) && /^(Continue|Ready to continue)/.test((button.textContent ?? "").trim()))
          .map((button) => ({
            text: (button.textContent ?? "").replace(/\s+/g, " ").trim(),
            disabled: button.disabled,
            rect: rectOf(button),
          }));
        const successorElement = successor?.anchorId ? document.getElementById(successor.anchorId) : successor?.id ? document.getElementById(successor.id) : null;
        const activeElement = document.activeElement as HTMLElement | null;
        return {
          label: snapshotLabel,
          atMs: Math.round(performance.now()),
          scrollY: Math.round(window.scrollY),
          documentScrollHeight: document.documentElement.scrollHeight,
          viewportHeight: window.innerHeight,
          maxScrollY: Math.round(document.documentElement.scrollHeight - window.innerHeight),
          hash: location.hash,
          href: location.href,
          active: {
            stateActiveLessonId: state?.progress?.activeLessonId,
            stateActiveBlockId: state?.progress?.activeBlockId,
            stateActiveAnchorId: state?.progress?.activeAnchorId,
            stateReadyBlocks: state?.progress?.readyBlocks,
            stateCanComplete: state?.progress?.canComplete,
            domActiveBlockId: activeBlock?.id || null,
            focused: activeElement ? {
              tagName: activeElement.tagName,
              id: activeElement.id || undefined,
              className: typeof activeElement.className === "string" ? activeElement.className : undefined,
              text: (activeElement.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 100),
            } : null,
          },
          visibleContinueButtons: candidateButtons,
          expectedSuccessor: successor ? { id: successor.id, anchorId: successor.anchorId, kind: successor.kind, title: successor.title } : null,
          successorAnchorRect: rectOf(successorElement),
          scrollIntoViewCallCount: ((window as any).__scrollIntoViewCalls ?? []).length,
          scrollIntoViewCalls: ((window as any).__scrollIntoViewCalls ?? []).slice(fromScrollCall).map((call: any, index: number) => ({ index: fromScrollCall + index, ...call })),
        };
      }, { snapshotLabel: label, fromScrollCall: scrollCallCursor, successor: expectedSuccessor });
      scrollCallCursor = sample.scrollIntoViewCallCount;
      return sample;
    };

    const currentState = async () => page.evaluate(async () => (await (await fetch("/api/workbook/state")).json()));
    const expectedSuccessor = (state: any) => {
      const ordered = state.orderedBlocks ?? [];
      const index = ordered.findIndex((block: any) => block.id === state.progress.activeBlockId);
      return index >= 0 ? ordered[index + 1] : undefined;
    };
    const animationFrame = () => page.evaluate(() => new Promise<void>((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(() => resolveFrame()))));

    await page.goto(server.url);
    await page.waitForSelector(".timeline-composer-textarea", { timeout: 10_000 });
    await animationFrame();
    trace.push(await snapshot("initial"));

    const transitionLabels = [
      "workbook-introduction-to-part-preamble",
      "part-preamble-to-lesson-preamble",
      "lesson-preamble-to-first-substantive-block",
    ];
    const expectedSuccessorKinds = ["part-preamble", "lesson-preamble", "narrative"];

    for (let index = 0; index < transitionLabels.length; index++) {
      const beforeState = await currentState();
      const successor = expectedSuccessor(beforeState);
      const label = transitionLabels[index]!;
      check(Boolean(successor), `${label}: no ordered successor for active block ${beforeState?.progress?.activeBlockId}`);
      if (!successor) break;
      check(successor.kind === expectedSuccessorKinds[index], `${label}: expected successor kind ${expectedSuccessorKinds[index]}, saw ${successor.kind}`);

      const button = page.locator('[data-active-block="true"] button').filter({ hasText: /^(Continue|Ready to continue)/ }).first();
      const buttonCount = await page.locator('[data-active-block="true"] button').filter({ hasText: /^(Continue|Ready to continue)/ }).count();
      check(buttonCount > 0, `${label}: no visible Continue button found in the active block`);
      if (buttonCount === 0) break;
      check(await button.isVisible(), `${label}: selected Continue button was not visible`);

      const before = await snapshot(`${label}:before-click`, successor);
      check(before.visibleContinueButtons.length > 0, `${label}: snapshot did not capture a visible Continue button`);
      check(Boolean(before.visibleContinueButtons[0]?.rect), `${label}: snapshot did not capture Continue button geometry`);
      check(typeof before.scrollY === "number" && typeof before.documentScrollHeight === "number", `${label}: before snapshot lacks scroll/document geometry`);

      const clickIssuedAtMs = await page.evaluate(() => Math.round(performance.now()));
      await button.click();
      await page.waitForFunction(async (expectedBlockId: string) => {
        const state = await (await fetch("/api/workbook/state")).json();
        return state.progress.activeBlockId === expectedBlockId;
      }, successor.id, { timeout: 10_000 });
      const stateTransitionObservedAtMs = await page.evaluate(() => Math.round(performance.now()));
      await waitFor(async () => {
        const activeId = await page.evaluate(() => (document.querySelector('[data-active-block="true"]') as HTMLElement | null)?.id ?? null);
        return activeId === successor.anchorId || activeId === successor.id;
      }, `${label}: DOM active block did not become ${successor.anchorId ?? successor.id}`);
      await animationFrame();
      const afterFramesAtMs = await page.evaluate(() => Math.round(performance.now()));

      const after = await snapshot(`${label}:after-click`, successor);
      check(after.active.stateActiveBlockId === successor.id, `${label}: state active block did not transition to ${successor.id}`);
      check(after.active.domActiveBlockId === (successor.anchorId ?? successor.id), `${label}: DOM active block did not transition to ${successor.anchorId ?? successor.id}`);
      check(Boolean(after.successorAnchorRect), `${label}: successor anchor geometry was unavailable`);
      check(Array.isArray(after.scrollIntoViewCalls), `${label}: scrollIntoView trace was unavailable`);
      const successorAnchorId = successor.anchorId ?? successor.id;
      const successorScrollCalls = after.scrollIntoViewCalls.filter((call: any) => call.target?.id === successorAnchorId);
      const scrollPolicyKeys = new Set<string>(successorScrollCalls.map((call: any) => JSON.stringify(call.options ?? null)));
      const scrollPolicies = [...scrollPolicyKeys].map((policy) => JSON.parse(policy));
      trace.push({
        transition: label,
        hrefEquivalentForLaterComparison: `#${successorAnchorId}`,
        from: beforeState.progress.activeBlockId,
        to: successor.id,
        summary: {
          currentHandlerAlreadyScrolledSuccessorAnchor: successorScrollCalls.length > 0,
          successorAnchorId,
          observedScrollIntoViewPoliciesForSuccessor: scrollPolicies,
          allScrollIntoViewTargetsAfterClick: after.scrollIntoViewCalls.map((call: any) => ({ index: call.index, id: call.target?.id, options: call.options, atMs: call.atMs, relativeToClickMs: call.atMs - clickIssuedAtMs })),
          timing: {
            clickIssuedAtMs,
            stateTransitionObservedAtMs,
            afterAnimationFramesAtMs: afterFramesAtMs,
            stateTransitionLatencyMs: stateTransitionObservedAtMs - clickIssuedAtMs,
            afterFramesLatencyMs: afterFramesAtMs - clickIssuedAtMs,
          },
          positionDelta: {
            beforeScrollY: before.scrollY,
            afterScrollY: after.scrollY,
            deltaScrollY: after.scrollY - before.scrollY,
            beforeHash: before.hash,
            afterHash: after.hash,
            successorRectAfter: after.successorAnchorRect,
          },
        },
        before,
        after,
      });
    }
  } finally {
    await browser.close();
    await server.close();
    await rm(workspace, { recursive: true, force: true });
  }

  console.log(JSON.stringify({ diagnostic: "continue-scroll", failures, trace }));
  if (failures.length) process.exitCode = 1;
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
