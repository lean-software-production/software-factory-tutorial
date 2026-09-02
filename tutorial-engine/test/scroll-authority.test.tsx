import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { announceContent, blockStartVisible, contentBelowFold, currentUnseen, flushScheduledViewportWork, navigateToAnchor, passiveHistoryAllowed, READING_LINE_TOP_PX, replaceUrlAnchor, resetScrollAuthorityForTests, revealUnseen, safeViewportBottom, scheduleAnnouncement, scheduleNavigation, useUnseenContent } from "../web-workbook/src/scroll-authority.js";
import type { PublicWorkbookState } from "../src/workbook/public-contract.js";
import { TimelineThread } from "../web-workbook/src/timeline-thread.js";

let dom: JSDOM | undefined;
let root: Root | undefined;

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = undefined;
  resetScrollAuthorityForTests();
  dom?.window.close();
  dom = undefined;
  vi.unstubAllGlobals();
});

function stubDom(html: string, setup?: (win: JSDOM["window"]) => void) {
  dom = new JSDOM(html, { url: "http://localhost/workbook" });
  vi.stubGlobal("window", dom.window as unknown as Window & typeof globalThis);
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("location", dom.window.location);
  vi.stubGlobal("history", dom.window.history);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(dom.window, "innerHeight", { value: 900, configurable: true });
  setup?.(dom.window);
  return dom.window;
}

function rect(top: number, height = 200): DOMRect {
  return { top, bottom: top + height, left: 0, right: 800, width: 800, height, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
}

describe("scroll authority policy", () => {
  it("counts a block as visible only when its start is inside the reading area", () => {
    const safeBottom = 800;
    expect(blockStartVisible(rect(0), safeBottom)).toBe(true);
    expect(blockStartVisible(rect(safeBottom - READING_LINE_TOP_PX), safeBottom)).toBe(true);
    expect(blockStartVisible(rect(safeBottom - READING_LINE_TOP_PX + 1), safeBottom)).toBe(false);
    expect(blockStartVisible(rect(-1), safeBottom)).toBe(false);
    // A box with no size has not been laid out; it cannot be visible, so a navigation still scrolls.
    expect(blockStartVisible({ top: 0, width: 0, height: 0 }, safeBottom)).toBe(false);
  });

  it("counts content as below the fold only when it starts under the reading area", () => {
    expect(contentBelowFold(rect(800), 800)).toBe(true);
    expect(contentBelowFold(rect(799), 800)).toBe(false);
    expect(contentBelowFold({ top: 900, width: 0, height: 0 }, 800)).toBe(false);
  });

  it("measures the reading area down to the fixed composer when there is one", () => {
    const win = stubDom('<!doctype html><html><body><div class="timeline-composer-dock"></div></body></html>');
    expect(safeViewportBottom()).toBe(900);
    win.document.querySelector<HTMLElement>(".timeline-composer-dock")!.getBoundingClientRect = () => rect(780, 120);
    expect(safeViewportBottom()).toBe(780);
  });

  it("holds passive history writes off briefly after a navigation", () => {
    stubDom('<!doctype html><html><body><section id="target" tabindex="-1"></section></body></html>');
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-02T00:00:00.000Z"));
    try {
      expect(passiveHistoryAllowed()).toBe(true);
      replaceUrlAnchor("target");
      expect(location.hash).toBe("#target");
      expect(passiveHistoryAllowed()).toBe(false);
      vi.setSystemTime(new Date("2026-09-02T00:00:00.451Z"));
      expect(passiveHistoryAllowed()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("navigateToAnchor", () => {
  it("writes the URL, scrolls instantly to the block start, and focuses within it", () => {
    const win = stubDom('<!doctype html><html><body><section id="target" tabindex="-1"><h2>Target</h2></section></body></html>');
    const scrollCalls: Array<{ hash: string; options: unknown }> = [];
    win.HTMLElement.prototype.scrollIntoView = function (options?: boolean | ScrollIntoViewOptions) { scrollCalls.push({ hash: win.location.hash, options }); };
    const focused: string[] = [];
    win.HTMLElement.prototype.focus = function () { focused.push(this.id || this.tagName); };

    expect(navigateToAnchor("target", "push")).toBe(true);

    expect(scrollCalls).toEqual([{ hash: "#target", options: { behavior: "instant", block: "start" } }]);
    expect(focused).toEqual(["target"]);
    expect(navigateToAnchor("missing", "push")).toBe(false);
  });

  it("prefers the block's live editor for focus, and leaves a terminal's keys alone", () => {
    const win = stubDom('<!doctype html><html><body><section id="editor" tabindex="-1"><h2>Editor</h2><div class="cm-content" contenteditable="true"></div></section><section id="terminal" tabindex="-1"><h2>Terminal</h2><textarea class="xterm-helper-textarea"></textarea></section></body></html>');
    win.HTMLElement.prototype.scrollIntoView = () => {};
    const focused: string[] = [];
    win.HTMLElement.prototype.focus = function () { focused.push(this.className || this.id); };

    navigateToAnchor("editor", "push");
    navigateToAnchor("terminal", "push");

    expect(focused).toEqual(["cm-content", "terminal"]);
  });

  it("keeps the learner's place when asked to and the block start is already readable", () => {
    const win = stubDom('<!doctype html><html><body><div class="timeline-composer-dock"></div><section id="visible" tabindex="-1"></section><section id="hidden" tabindex="-1"></section></body></html>');
    win.document.querySelector<HTMLElement>(".timeline-composer-dock")!.getBoundingClientRect = () => rect(800, 100);
    win.document.getElementById("visible")!.getBoundingClientRect = () => rect(300);
    win.document.getElementById("hidden")!.getBoundingClientRect = () => rect(1200);
    const scrolled: string[] = [];
    win.HTMLElement.prototype.scrollIntoView = function () { scrolled.push(this.id); };

    expect(navigateToAnchor("visible", "push", { keepIfVisible: true })).toBe(true);
    expect(navigateToAnchor("hidden", "push", { keepIfVisible: true })).toBe(true);
    expect(navigateToAnchor("visible", "push")).toBe(true);

    expect(scrolled).toEqual(["hidden", "visible"]);
    expect(location.hash).toBe("#visible");
  });
});

describe("scheduled navigation", () => {
  const stateWithActive = (activeBlockId: string) => ({ progress: { activeBlockId, activeAnchorId: activeBlockId } } as unknown as PublicWorkbookState);

  it("navigates only once a state that activates the target has been committed", () => {
    const win = stubDom('<!doctype html><html><body><section id="before" tabindex="-1"></section><section id="after" tabindex="-1"></section></body></html>');
    const scrolled: string[] = [];
    win.HTMLElement.prototype.scrollIntoView = function () { scrolled.push(this.id); };

    scheduleNavigation("after", "push");
    // A commit of some other state — an SSE refresh from before the completion — must not run it.
    flushScheduledViewportWork(stateWithActive("before"));
    expect(scrolled).toEqual([]);

    flushScheduledViewportWork(stateWithActive("after"));
    expect(scrolled).toEqual(["after"]);
    expect(location.hash).toBe("#after");

    // Once run it is gone; later commits do nothing.
    flushScheduledViewportWork(stateWithActive("after"));
    expect(scrolled).toEqual(["after"]);
  });

  it("drops a navigation whose state never arrives instead of firing it later", () => {
    const win = stubDom('<!doctype html><html><body><section id="after" tabindex="-1"></section></body></html>');
    const scrolled: string[] = [];
    win.HTMLElement.prototype.scrollIntoView = function () { scrolled.push(this.id); };
    const scheduledAt = Date.now();

    scheduleNavigation("after", "push");
    flushScheduledViewportWork(stateWithActive("after"), scheduledAt + 2_001);
    expect(scrolled).toEqual([]);
  });

  it("announces a tutor-advanced block after its state commits, without scrolling", () => {
    const win = stubDom('<!doctype html><html><body><section id="next" tabindex="-1"></section></body></html>');
    win.document.getElementById("next")!.getBoundingClientRect = () => rect(1200);
    const scrolled: string[] = [];
    win.HTMLElement.prototype.scrollIntoView = function () { scrolled.push(this.id); };

    scheduleAnnouncement("next", "Continue below");
    flushScheduledViewportWork(stateWithActive("current"));
    expect(currentUnseen()).toBeUndefined();

    flushScheduledViewportWork(stateWithActive("next"));
    expect(currentUnseen()).toEqual({ anchorId: "next", label: "Continue below" });
    expect(scrolled).toEqual([]);
  });
});

describe("announced content", () => {
  it("shows the chip for content below the fold and clears it when the learner reveals it", () => {
    const win = stubDom('<!doctype html><html><body><div class="timeline-composer-dock"></div><article id="reply"></article></body></html>');
    win.document.querySelector<HTMLElement>(".timeline-composer-dock")!.getBoundingClientRect = () => rect(800, 100);
    const reply = win.document.getElementById("reply")!;
    reply.getBoundingClientRect = () => rect(1100, 80);
    const scrolled: Array<{ id: string; options: unknown }> = [];
    win.HTMLElement.prototype.scrollIntoView = function (options?: boolean | ScrollIntoViewOptions) { scrolled.push({ id: this.id, options }); };

    announceContent(reply, "New reply below");

    expect(currentUnseen()).toEqual({ anchorId: "reply", label: "New reply below" });
    expect(scrolled).toEqual([]);

    expect(revealUnseen()).toBe(true);
    expect(scrolled).toEqual([{ id: "reply", options: { behavior: "instant", block: "start" } }]);
    expect(currentUnseen()).toBeUndefined();
    expect(revealUnseen()).toBe(false);
  });

  it("ignores content that is already readable, and forgets the chip when the learner navigates", () => {
    const win = stubDom('<!doctype html><html><body><article id="seen"></article><article id="unseen"></article><section id="elsewhere" tabindex="-1"></section></body></html>');
    win.HTMLElement.prototype.scrollIntoView = () => {};
    win.document.getElementById("seen")!.getBoundingClientRect = () => rect(300, 80);
    win.document.getElementById("unseen")!.getBoundingClientRect = () => rect(950, 80);

    announceContent(win.document.getElementById("seen")!, "New reply below");
    expect(currentUnseen()).toBeUndefined();

    announceContent(win.document.getElementById("unseen")!, "New reply below");
    expect(currentUnseen()?.anchorId).toBe("unseen");

    navigateToAnchor("elsewhere", "push");
    expect(currentUnseen()).toBeUndefined();
  });

  it("clears the chip on its own once the content scrolls into the reading area", () => {
    let callback: ((entries: Array<{ isIntersecting: boolean }>) => void) | undefined;
    const observed: Element[] = [];
    class FakeIntersectionObserver {
      constructor(next: (entries: Array<{ isIntersecting: boolean }>) => void) { callback = next; }
      observe(element: Element) { observed.push(element); }
      disconnect() {}
    }
    const win = stubDom('<!doctype html><html><body><article id="reply"></article></body></html>', () => vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver));
    const reply = win.document.getElementById("reply")!;
    reply.getBoundingClientRect = () => rect(1100, 80);

    announceContent(reply, "New reply below");
    expect(observed).toEqual([reply]);
    callback?.([{ isIntersecting: false }]);
    expect(currentUnseen()?.anchorId).toBe("reply");
    callback?.([{ isIntersecting: true }]);
    expect(currentUnseen()).toBeUndefined();
  });

  it("lets React subscribe to the chip state", async () => {
    const win = stubDom('<!doctype html><html><body><div id="root"></div><article id="reply"></article></body></html>');
    win.HTMLElement.prototype.scrollIntoView = () => {};
    win.document.getElementById("reply")!.getBoundingClientRect = () => rect(1100, 80);
    function Chip() {
      const unseen = useUnseenContent();
      return createElement("output", null, unseen ? unseen.label : "nothing new");
    }
    const container = win.document.getElementById("root")!;
    root = createRoot(container);
    await act(async () => { root!.render(createElement(Chip)); });
    expect(container.textContent).toBe("nothing new");

    await act(async () => { announceContent(win.document.getElementById("reply")!, "New reply below"); });
    expect(container.textContent).toBe("New reply below");

    await act(async () => { revealUnseen(); });
    expect(container.textContent).toBe("nothing new");
  });
});

describe("TimelineThread and the scroll authority", () => {
  it("announces a reply that arrives below the fold instead of scrolling to it", async () => {
    const win = stubDom('<!doctype html><html><body><div id="root"></div></body></html>');
    const scrollTo = vi.fn();
    win.scrollTo = scrollTo as any;
    win.HTMLElement.prototype.scrollIntoView = vi.fn();
    Object.defineProperty(win, "innerHeight", { value: 900, configurable: true });
    // Everything the thread renders lies below the reading area in this fixture.
    win.HTMLElement.prototype.getBoundingClientRect = function () { return rect(this.classList.contains("timeline-composer-dock") ? 800 : 1000, 80); };
    const record = (id: string, role: "user" | "assistant", text: string) => ({ type: "message", id, sequence: 1, at: "2026-08-21T00:00:00.000Z", lessonId: "lesson", blockId: "write", role, source: role === "user" ? "learner" : "main_tutor", presentation: "chat", text } as const);
    const render = (records: ReturnType<typeof record>[]) => createElement(TimelineThread, { activeLessonId: "lesson", activeBlockId: "write", onSend: vi.fn(async () => undefined), records });

    const container = win.document.getElementById("root")!;
    root = createRoot(container);
    await act(async () => { root!.render(render([record("asked", "user", "Which directory?")])); });
    expect(currentUnseen()).toBeUndefined();

    await act(async () => { root!.render(render([record("asked", "user", "Which directory?"), record("answered", "assistant", "Use .tmp.")])); });

    expect(scrollTo).not.toHaveBeenCalled();
    expect(win.HTMLElement.prototype.scrollIntoView).not.toHaveBeenCalled();
    expect(currentUnseen()).toEqual({ anchorId: "timeline-message-answered", label: "New reply below" });
  });
});
