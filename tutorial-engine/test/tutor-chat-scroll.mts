#!/usr/bin/env npx tsx
/**
 * Real-browser contract for tutor-chat reply scrolling.
 *
 * This boots the real workbook UI/server against the visual fixture and checks observable scroll
 * outcomes rather than incidental DOM API calls:
 *   1. a reply that is already fully visible above the fixed composer leaves scrollY stable;
 *   2. a reply inserted below/behind the fixed composer is revealed by the minimum needed movement.
 *
 *   npm run --workspace=tutorial-engine build:web:workbook
 *   cd tutorial-engine && npx tsx test/tutor-chat-scroll.mts
 */
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { startWorkbookServer } from "../src/workbook/server.js";
import { QueuedMainTutor } from "./support/fake-tutors.js";

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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolver) => { resolve = resolver; });
  return { promise, resolve };
}

function longLearnerMessage(): string {
  return Array.from({ length: 8 }, (_, index) =>
    `Diagnostic learner message paragraph ${index + 1}: `
    + "This deliberately verbose sentence is repeated so the local echo becomes tall enough to make the reply insertion geometry measurable in Chromium."
  ).join("\n\n");
}

function obscuredTutorReply(): string {
  return Array.from({ length: 6 }, (_, index) =>
    `Diagnostic obscured tutor reply paragraph ${index + 1}: `
    + "This fake response is intentionally tall enough to begin below the fixed composer, but short enough to fit within the safe reading region after one minimal scroll."
  ).join("\n\n");
}

async function main(): Promise<void> {
  try { await readFile(resolve(webRoot, "index.html")); }
  catch { throw new Error("Build the workbook UI first: npm run --workspace=tutorial-engine build:web:workbook"); }

  const moduleName = "playwright";
  let playwright: { chromium: { launch(options?: unknown): Promise<any> } };
  try { playwright = await import(moduleName) as typeof playwright; }
  catch { throw new Error("Tutor-chat scroll contract needs Playwright. Install it with `npm install --no-save -D playwright`, then `npx playwright install chromium`."); }

  const workspace = await mkdtemp(resolve(tmpdir(), "tutor-chat-scroll-"));
  await cp(fixtureRoot, workspace, { recursive: true });
  await mkdir(resolve(workspace, "factory"), { recursive: true });
  await writeFile(resolve(workspace, "factory/answer.md"), "A draft for the visual fixture.\n");

  const mainTutor = new QueuedMainTutor();
  const server = await startWorkbookServer({
    target: workspace,
    webRoot,
    port: 0,
    embeddedTerminal: false,
    mainTutor,
        logger: silentLogger,
  });
  const browser = await playwright.chromium.launch();
  const trace: any[] = [];

  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, reducedMotion: "reduce" });
    await page.addInitScript(() => {
      (globalThis as unknown as { __name: unknown }).__name = (value: unknown) => value;
    });

    const snapshot = async (label: string) => page.evaluate(async (snapshotLabel: string) => {
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
      const state = await fetch("/api/workbook/state").then((response) => response.json()).catch((error) => ({ error: String(error) }));
      const messages = [...document.querySelectorAll(".timeline-message")];
      const learnerMessages = [...document.querySelectorAll(".timeline-message.learner")];
      const tutorMessages = [...document.querySelectorAll(".timeline-message.tutor:not(.thinking)")];
      const latest = messages.at(-1) as HTMLElement | undefined;
      const composer = document.querySelector(".timeline-composer-dock") as HTMLElement | null;
      const textarea = document.querySelector(".timeline-composer-textarea") as HTMLTextAreaElement | null;
      const activeBlock = document.querySelector('[data-active-block="true"]') as HTMLElement | null;
      const replyScrollGap = Number.parseFloat(getComputedStyle(latest ?? document.documentElement).getPropertyValue("--timeline-reply-scroll-gap"));
      return {
        label: snapshotLabel,
        atMs: Math.round(performance.now()),
        scrollY: Math.round(window.scrollY),
        documentScrollHeight: document.documentElement.scrollHeight,
        viewportHeight: window.innerHeight,
        maxScrollY: Math.round(document.documentElement.scrollHeight - window.innerHeight),
        replyScrollGapPx: Number.isFinite(replyScrollGap) ? replyScrollGap : 14,
        latestConversationItem: latest ? {
          tagName: latest.tagName,
          id: latest.id || undefined,
          className: latest.className,
          text: latest.textContent?.replace(/\s+/g, " ").trim().slice(0, 160),
          rect: rectOf(latest),
        } : null,
        conversationSummary: messages.map((message) => ({
          className: (message as HTMLElement).className,
          height: Math.round(message.getBoundingClientRect().height),
          bottom: Math.round(message.getBoundingClientRect().bottom),
          text: message.textContent?.replace(/\s+/g, " ").trim().slice(0, 70),
        })),
        conversationCounts: {
          learner: learnerMessages.length,
          tutor: tutorMessages.length,
          thinking: document.querySelectorAll(".timeline-message.tutor.thinking").length,
        },
        composer: {
          dockRect: rectOf(composer),
          textareaRect: rectOf(textarea),
          textareaDisabled: Boolean(textarea?.disabled),
          textareaValueLength: textarea?.value.length ?? null,
        },
        active: {
          stateActiveLessonId: state?.progress?.activeLessonId,
          stateActiveBlockId: state?.progress?.activeBlockId,
          stateActiveAnchorId: state?.progress?.activeAnchorId,
          domActiveBlockId: activeBlock?.id || null,
          hash: location.hash,
          href: location.href,
        },
      };
    }, label);

    const placeLatestLearnerBottomAt = async (viewportBottom: number) => page.evaluate((targetBottom: number) => {
      const learners = [...document.querySelectorAll(".timeline-message.learner")];
      const latestLearner = learners.at(-1) as HTMLElement | undefined;
      if (!latestLearner) return { ok: false, reason: "missing latest learner" };
      const before = latestLearner.getBoundingClientRect();
      const max = document.documentElement.scrollHeight - window.innerHeight;
      const target = Math.max(0, Math.min(max, window.scrollY + before.bottom - targetBottom));
      window.scrollTo({ top: target, left: window.scrollX, behavior: "instant" });
      const after = latestLearner.getBoundingClientRect();
      return {
        ok: true,
        requestedBottom: targetBottom,
        scrollY: Math.round(window.scrollY),
        maxScrollY: Math.round(max),
        learnerBottomBefore: Math.round(before.bottom),
        learnerBottomAfter: Math.round(after.bottom),
      };
    }, viewportBottom);

    const sendMessageAndWaitForLearner = async (text: string, expectedLearnerCount: number, expectedReplyRequestCount: number, snippet: string) => {
      await page.locator(".timeline-composer-textarea").fill(text);
      await page.waitForFunction(() => !((document.querySelector(".round-send") as HTMLButtonElement | null)?.disabled), undefined, { timeout: 5_000 });
      await page.locator(".round-send").click();
      await waitFor(() => mainTutor.replies.length === expectedReplyRequestCount, `api: fake main tutor did not receive learner message ${expectedReplyRequestCount}`);
      const learnerRendered = await page.waitForFunction(({ count, textSnippet }: { count: number; textSnippet: string }) => {
        const learners = [...document.querySelectorAll(".timeline-message.learner")];
        return learners.length === count
          && learners.at(-1)?.textContent?.includes(textSnippet)
          && !document.querySelector(".timeline-message.tutor.thinking");
      }, { count: expectedLearnerCount, textSnippet: snippet }, { timeout: 10_000 }).then(() => true).catch(() => false);
      check(learnerRendered, `ui: persisted learner record ${expectedLearnerCount} did not render before tutor reply`);
      await page.waitForTimeout(150);
    };

    await page.goto(server.url);
    await page.waitForSelector(".timeline-composer-textarea", { timeout: 10_000 });

    for (let step = 0; step < 6; step++) {
      const state = await page.evaluate(async () => (await (await fetch("/api/workbook/state")).json()).progress);
      if (String(state.activeBlockId).endsWith("--editing")) break;
      const button = page.locator("button").filter({ hasText: /^Continue/ }).first();
      if (await button.count() === 0) break;
      await button.click({ force: true });
      await page.waitForTimeout(350);
    }

    const reachedEditor = await page.waitForFunction(
      async () => String((await (await fetch("/api/workbook/state")).json()).progress.activeBlockId).endsWith("--editing"),
      undefined,
      { timeout: 10_000 },
    ).then(() => true).catch(() => false);
    check(reachedEditor, "setup: editor block did not become active");

    const composerReady = await page.waitForFunction(() => {
      const textarea = document.querySelector(".timeline-composer-textarea") as HTMLTextAreaElement | null;
      return Boolean(textarea && !textarea.disabled);
    }, undefined, { timeout: 10_000 }).then(() => true).catch(() => false);
    check(composerReady, "setup: tutor composer was not editable");

    const visibleReply = deferred<string>();
    mainTutor.replyQueue.push(visibleReply.promise);
    const visibleLearnerMessage = "Diagnostic visible learner question: can you confirm this short setup?";
    const visibleTutorReply = "Diagnostic visible tutor reply: yes, this card is already fully in the reading region.";
    await sendMessageAndWaitForLearner(visibleLearnerMessage, 1, 1, "Diagnostic visible learner question");
    const visibleSetup = await placeLatestLearnerBottomAt(430);
    check(Boolean((visibleSetup as any).ok), `setup: could not position visible learner (${JSON.stringify(visibleSetup)})`);
    await page.waitForTimeout(100);
    const beforeVisibleReply = await snapshot("visible-before-reply");
    trace.push({ ...beforeVisibleReply, positioning: visibleSetup });

    visibleReply.resolve(visibleTutorReply);
    const visibleTutorRendered = await page.waitForFunction((snippet: string) => document.body.textContent?.includes(snippet), "Diagnostic visible tutor reply", { timeout: 10_000 }).then(() => true).catch(() => false);
    check(visibleTutorRendered, "ui: visible tutor reply did not render");
    await page.waitForTimeout(500);
    const afterVisibleReply = await snapshot("visible-after-reply");
    trace.push(afterVisibleReply);

    const visibleScrollDelta = afterVisibleReply.scrollY - beforeVisibleReply.scrollY;
    check(Math.abs(visibleScrollDelta) <= 1, `scroll: already-visible tutor reply changed scrollY by ${visibleScrollDelta}px (${JSON.stringify({ before: beforeVisibleReply.scrollY, after: afterVisibleReply.scrollY })})`);
    const visibleReplyRect = afterVisibleReply.latestConversationItem?.rect;
    const visibleComposerTop = afterVisibleReply.composer.dockRect?.top;
    if (visibleReplyRect && visibleComposerTop !== undefined) {
      const safeBottom = visibleComposerTop - afterVisibleReply.replyScrollGapPx;
      check(visibleReplyRect.top >= 0 && visibleReplyRect.bottom <= safeBottom + 2, `scroll: visible tutor reply was not fully above the composer (${JSON.stringify({ visibleReplyRect, visibleComposerTop, safeBottom })})`);
    } else {
      check(false, `scroll: missing visible tutor reply or composer geometry (${JSON.stringify(afterVisibleReply.latestConversationItem)}, ${JSON.stringify(afterVisibleReply.composer)})`);
    }

    const hiddenReply = deferred<string>();
    mainTutor.replyQueue.push(hiddenReply.promise);
    const hiddenLearnerMessage = longLearnerMessage();
    const hiddenTutorReply = obscuredTutorReply();
    await sendMessageAndWaitForLearner(hiddenLearnerMessage, 2, 2, "Diagnostic learner message paragraph 1");
    const composerTopBeforeHidden = (await snapshot("obscured-position-reference")).composer.dockRect?.top ?? 790;
    const hiddenSetup = await placeLatestLearnerBottomAt(composerTopBeforeHidden - 24);
    check(Boolean((hiddenSetup as any).ok), `setup: could not position obscured learner (${JSON.stringify(hiddenSetup)})`);
    await page.waitForTimeout(100);
    const beforeHiddenReply = await snapshot("obscured-before-reply");
    trace.push({ ...beforeHiddenReply, positioning: hiddenSetup });

    hiddenReply.resolve(hiddenTutorReply);
    const hiddenTutorRendered = await page.waitForFunction((snippet: string) => document.body.textContent?.includes(snippet), "Diagnostic obscured tutor reply paragraph 1", { timeout: 10_000 }).then(() => true).catch(() => false);
    check(hiddenTutorRendered, "ui: obscured tutor reply did not render");
    await page.waitForTimeout(500);
    const afterHiddenReply = await snapshot("obscured-after-reply");
    trace.push(afterHiddenReply);

    const hiddenScrollDelta = afterHiddenReply.scrollY - beforeHiddenReply.scrollY;
    check(hiddenScrollDelta > 20, `scroll: obscured tutor reply should have moved down enough to reveal it, moved ${hiddenScrollDelta}px`);
    const hiddenReplyRect = afterHiddenReply.latestConversationItem?.rect;
    const hiddenComposerTop = afterHiddenReply.composer.dockRect?.top;
    if (hiddenReplyRect && hiddenComposerTop !== undefined) {
      const targetGap = afterHiddenReply.replyScrollGapPx;
      const safeBottom = hiddenComposerTop - targetGap;
      const finalGap = hiddenComposerTop - hiddenReplyRect.bottom;
      const impliedInitialBottom = hiddenReplyRect.bottom + hiddenScrollDelta;
      const minimalDelta = Math.max(0, Math.round(impliedInitialBottom - safeBottom));
      check(hiddenReplyRect.top >= 0, `scroll: obscured tutor reply top should remain visible after minimal reveal (${JSON.stringify({ hiddenReplyRect, hiddenComposerTop })})`);
      check(hiddenReplyRect.bottom <= safeBottom + 2, `scroll: obscured tutor reply bottom should be above the composer (${JSON.stringify({ hiddenReplyRect, hiddenComposerTop, safeBottom })})`);
      check(Math.abs(finalGap - targetGap) <= 3, `scroll: obscured tutor reply should stop at the safe-region edge, not overscroll (${JSON.stringify({ finalGap, targetGap, hiddenReplyRect, hiddenComposerTop })})`);
      check(Math.abs(hiddenScrollDelta - minimalDelta) <= 3, `scroll: obscured tutor reply movement was not minimal (${JSON.stringify({ hiddenScrollDelta, minimalDelta, impliedInitialBottom, safeBottom })})`);
      check(afterHiddenReply.scrollY < afterHiddenReply.maxScrollY - 2, `scroll: obscured tutor reply check was clamped at page bottom (${JSON.stringify({ scrollY: afterHiddenReply.scrollY, maxScrollY: afterHiddenReply.maxScrollY })})`);
    } else {
      check(false, `scroll: missing obscured tutor reply or composer geometry (${JSON.stringify(afterHiddenReply.latestConversationItem)}, ${JSON.stringify(afterHiddenReply.composer)})`);
    }

    check(mainTutor.replies[0]?.learnerMessage.text === visibleLearnerMessage.trim(), "api: fake main tutor received unexpected first learner message text");
    check(mainTutor.replies[1]?.learnerMessage.text === hiddenLearnerMessage.trim(), "api: fake main tutor received unexpected second learner message text");
  } finally {
    await browser.close();
    await server.close();
    await rm(workspace, { recursive: true, force: true });
  }

  console.log(JSON.stringify({ diagnostic: "tutor-chat-scroll", failures, trace }));
  if (failures.length) process.exitCode = 1;
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
