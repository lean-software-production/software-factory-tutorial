#!/usr/bin/env npx tsx
/**
 * Diagnostic real-browser trace for tutor-chat submit scrolling.
 *
 * This boots the real workbook UI/server against the visual fixture, sends one delayed fake-tutor
 * chat message, and prints the scroll/layout trace as JSON. It asserts the simplified chat scroll
 * contract: the persisted learner record appears once without scrolling, then the persisted tutor
 * reply receives exactly one deterministic auto/end scroll that leaves the reply above the fixed composer.
 *
 *   npm run --workspace=tutorial-engine build:web:workbook
 *   cd tutorial-engine && npx tsx test/tutor-chat-scroll.mts
 */
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { startWorkbookServer } from "../src/workbook/server.js";
import { QueuedMainTutor, RecordingPracticeCoach } from "./support/fake-tutors.js";

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
  return Array.from({ length: 14 }, (_, index) =>
    `Diagnostic learner message paragraph ${index + 1}: `
    + "This deliberately verbose sentence is repeated so the local echo becomes tall enough to affect the document scroll position and make scrollIntoView behavior measurable in Chromium."
  ).join("\n\n");
}

function longTutorReply(): string {
  return Array.from({ length: 12 }, (_, index) =>
    `Diagnostic tutor reply paragraph ${index + 1}: `
    + "This fake response is intentionally long, but neutral; it exists only to make the final tutor card tall enough for scroll measurements."
  ).join("\n\n");
}

async function main(): Promise<void> {
  try { await readFile(resolve(webRoot, "index.html")); }
  catch { throw new Error("Build the workbook UI first: npm run --workspace=tutorial-engine build:web:workbook"); }

  const moduleName = "playwright";
  let playwright: { chromium: { launch(options?: unknown): Promise<any> } };
  try { playwright = await import(moduleName) as typeof playwright; }
  catch { throw new Error("Tutor-chat scroll diagnostic needs Playwright. Install it with `npm install --no-save -D playwright`, then `npx playwright install chromium`."); }

  const workspace = await mkdtemp(resolve(tmpdir(), "tutor-chat-scroll-"));
  await cp(fixtureRoot, workspace, { recursive: true });
  await mkdir(resolve(workspace, "factory"), { recursive: true });
  await writeFile(resolve(workspace, "factory/answer.md"), "A draft for the visual fixture.\n");

  const reply = deferred<string>();
  const mainTutor = new QueuedMainTutor();
  mainTutor.replyQueue.push(reply.promise);

  const server = await startWorkbookServer({
    target: workspace,
    webRoot,
    port: 0,
    embeddedTerminal: false,
    mainTutor,
    practiceCoach: new RecordingPracticeCoach(),
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
      Element.prototype.scrollIntoView = function (this: Element, ...args: any[]) {
        const rect = this.getBoundingClientRect();
        const options = args.length === 0 ? undefined : args[0];
        calls.push({
          atMs: Math.round(performance.now()),
          target: {
            tagName: this.tagName,
            id: this.id || undefined,
            className: typeof (this as HTMLElement).className === "string" ? (this as HTMLElement).className : undefined,
            text: (this.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 120),
          },
          options,
          rectBefore: { top: Math.round(rect.top), bottom: Math.round(rect.bottom), height: Math.round(rect.height) },
          scrollYBefore: Math.round(window.scrollY),
          scrollHeightBefore: document.documentElement.scrollHeight,
          viewportHeight: window.innerHeight,
          hash: location.hash,
        });
        return original.apply(this, args as [arg?: boolean | ScrollIntoViewOptions]);
      };
    });

    const snapshot = async (label: string) => {
      const sample = await page.evaluate(async ({ snapshotLabel, fromScrollCall }: { snapshotLabel: string; fromScrollCall: number }) => {
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
      return {
        label: snapshotLabel,
        atMs: Math.round(performance.now()),
        scrollY: Math.round(window.scrollY),
        documentScrollHeight: document.documentElement.scrollHeight,
        viewportHeight: window.innerHeight,
        maxScrollY: Math.round(document.documentElement.scrollHeight - window.innerHeight),
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
        scrollIntoViewCallCount: ((window as any).__scrollIntoViewCalls ?? []).length,
        scrollIntoViewCalls: ((window as any).__scrollIntoViewCalls ?? []).slice(fromScrollCall).map((call: any, index: number) => ({ index: fromScrollCall + index, ...call })),
      };
      }, { snapshotLabel: label, fromScrollCall: scrollCallCursor });
      scrollCallCursor = sample.scrollIntoViewCallCount;
      return sample;
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

    const learnerMessage = longLearnerMessage();
    const tutorReply = longTutorReply();
    await page.locator(".timeline-composer-textarea").fill(learnerMessage);
    await page.waitForFunction(() => !((document.querySelector(".round-send") as HTMLButtonElement | null)?.disabled), undefined, { timeout: 5_000 });

    const scrollSetup = await page.evaluate(() => {
      const max = document.documentElement.scrollHeight - window.innerHeight;
      const target = Math.max(0, Math.min(max - 140, Math.round(max * 0.45)));
      window.scrollTo(0, target);
      return { target: Math.round(target), maxScrollY: Math.round(max) };
    });
    await page.waitForTimeout(200);
    check(scrollSetup.maxScrollY > 300, `setup: page was not meaningfully scrollable before submission (maxScrollY ${scrollSetup.maxScrollY})`);
    check(scrollSetup.target < scrollSetup.maxScrollY - 80, `setup: deliberate pre-submit scroll target was too close to the bottom (${JSON.stringify(scrollSetup)})`);
    trace.push({ ...(await snapshot("before-submission")), deliberatePreSubmitScroll: scrollSetup });

    await page.locator(".round-send").click();
    await waitFor(() => mainTutor.replies.length === 1, "api: fake main tutor did not receive the learner message");
    const persistedLearnerRendered = await page.waitForFunction((snippet: string) => {
      const learners = [...document.querySelectorAll(".timeline-message.learner")];
      return learners.length === 1
        && learners[0]?.textContent?.includes(snippet)
        && !document.querySelector(".timeline-message.tutor.thinking");
    }, "Diagnostic learner message paragraph 1", { timeout: 10_000 }).then(() => true).catch(() => false);
    check(persistedLearnerRendered, "ui: exactly one persisted learner record did not render before tutor reply");
    await page.waitForTimeout(250);
    const afterLearner = await snapshot("after-persisted-learner");
    trace.push(afterLearner);
    check(afterLearner.conversationCounts.learner === 1, `ui: expected one learner bubble after persisted learner, saw ${afterLearner.conversationCounts.learner}`);
    check(afterLearner.conversationCounts.thinking === 0, "ui: main-chat thinking card rendered while tutor reply was pending");
    check(afterLearner.scrollIntoViewCalls.length === 0, `scroll: persisted learner arrival should not scroll (${JSON.stringify(afterLearner.scrollIntoViewCalls)})`);

    reply.resolve(tutorReply);
    const tutorReplyRendered = await page.waitForFunction((snippet: string) => {
      const text = document.body.textContent ?? "";
      return text.includes(snippet) && !document.querySelector(".timeline-message.tutor.thinking");
    }, "Diagnostic tutor reply paragraph 1", { timeout: 10_000 }).then(() => true).catch(() => false);
    check(tutorReplyRendered, "ui: final tutor reply did not render");
    await page.waitForTimeout(350);
    const afterReply = await snapshot("after-tutor-reply");
    trace.push(afterReply);

    const replyScrolls = afterReply.scrollIntoViewCalls.filter((call: any) => call.target.className?.includes("timeline-message tutor") && call.target.text?.includes("Diagnostic tutor reply paragraph 1"));
    check(afterReply.conversationCounts.learner === 1, `ui: expected one learner bubble after tutor reply, saw ${afterReply.conversationCounts.learner}`);
    check(replyScrolls.length === 1, `scroll: expected exactly one tutor reply scroll, saw ${replyScrolls.length} (${JSON.stringify(afterReply.scrollIntoViewCalls)})`);
    check(replyScrolls[0]?.options?.behavior === "auto" && replyScrolls[0]?.options?.block === "end", `scroll: tutor reply used unexpected scroll options ${JSON.stringify(replyScrolls[0]?.options)}`);
    check(!afterReply.scrollIntoViewCalls.some((call: any) => call.options?.behavior === "smooth"), `scroll: tutor reply phase should not use smooth scrolling (${JSON.stringify(afterReply.scrollIntoViewCalls)})`);

    const replyRect = afterReply.latestConversationItem?.rect;
    const composerDockTop = afterReply.composer.dockRect?.top;
    if (replyRect && composerDockTop !== undefined) {
      const gapAboveComposer = composerDockTop - replyRect.bottom;
      check(replyRect.top > 16, `scroll: tutor reply should not be pinned at the viewport top (${JSON.stringify({ replyRect, composerDockTop })})`);
      check(replyRect.bottom <= composerDockTop + 2, `scroll: tutor reply bottom should be above the composer dock (${JSON.stringify({ replyRect, composerDockTop })})`);
      check(gapAboveComposer <= 40, `scroll: tutor reply should end close to the composer dock (${JSON.stringify({ gapAboveComposer, replyRect, composerDockTop })})`);
    } else {
      check(false, `scroll: missing tutor reply or composer geometry (${JSON.stringify(afterReply.latestConversationItem)}, ${JSON.stringify(afterReply.composer)})`);
    }

    check(mainTutor.replies[0]?.learnerMessage.text === learnerMessage.trim(), "api: fake main tutor received unexpected learner message text");
  } finally {
    await browser.close();
    await server.close();
    await rm(workspace, { recursive: true, force: true });
  }

  console.log(JSON.stringify({ diagnostic: "tutor-chat-scroll", failures, trace }));
  if (failures.length) process.exitCode = 1;
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
