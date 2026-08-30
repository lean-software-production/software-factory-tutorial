import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { StrictMode, act, createElement, useEffect, useLayoutEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const terminalDataListeners: Array<(data: string) => void> = [];
const terminalInstances: any[] = [];
const terminalFitCalls: string[] = [];
let terminalProposedDimensions: { cols: number; rows: number } | undefined = { cols: 80, rows: 24 };

const confettiMock = vi.hoisted(() => {
  const reset = vi.fn();
  const cannon = Object.assign(vi.fn((_options?: any) => undefined), { reset });
  const create = vi.fn((_canvas?: HTMLCanvasElement, _options?: any) => cannon);
  return { cannon, create, reset };
});

vi.mock("canvas-confetti", () => ({ default: Object.assign(vi.fn(), { create: confettiMock.create }) }));

vi.mock("@codemirror/state", () => ({
  EditorState: { create: (config: any) => config }
}));

vi.mock("@codemirror/view", () => {
  const listenerMarker = "__cmUpdateListener";
  const flatten = (value: any): any[] => Array.isArray(value) ? value.flatMap(flatten) : [value];
  class EditorView {
    static updateListener = { of: (listener: (update: any) => void) => ({ [listenerMarker]: listener }) };
    static editable = { of: (editable: boolean) => ({ editable }) };
    dom: HTMLElement;
    contentDOM: HTMLElement;
    #listeners: Array<(update: any) => void>;
    constructor(options: { state: any; parent: HTMLElement }) {
      this.dom = document.createElement("div");
      this.dom.className = "cm-editor";
      this.contentDOM = document.createElement("div");
      this.contentDOM.className = "cm-content";
      this.contentDOM.setAttribute("role", "textbox");
      this.contentDOM.setAttribute("contenteditable", "true");
      this.contentDOM.textContent = options.state.doc ?? "";
      this.dom.append(this.contentDOM);
      options.parent.append(this.dom);
      this.#listeners = flatten(options.state.extensions).map((extension) => extension?.[listenerMarker]).filter(Boolean);
      this.contentDOM.addEventListener("input", () => {
        const text = this.contentDOM.textContent ?? "";
        this.#listeners.forEach((listener) => listener({ docChanged: true, state: { doc: { toString: () => text } } }));
      });
    }
    destroy() { this.dom.remove(); }
  }
  return { EditorView, keymap: { of: () => ({}) } };
});

vi.mock("@codemirror/commands", () => ({ defaultKeymap: [] }));

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options: { disableStdin?: boolean };
    constructor(options: { disableStdin?: boolean } = {}) { this.options = { ...options }; terminalInstances.push(this); }
    loadAddon(addon: { terminal?: { cols: number; rows: number } }) { addon.terminal = this; }
    open() {}
    onData(listener: (data: string) => void) {
      const guarded = (data: string) => { if (!this.options.disableStdin) listener(data); };
      terminalDataListeners.push(guarded);
      return { dispose() { const index = terminalDataListeners.indexOf(guarded); if (index >= 0) terminalDataListeners.splice(index, 1); } };
    }
    write() {}
    dispose() {}
  }
}));

vi.mock("@xterm/addon-fit", () => ({ FitAddon: class {
  terminal?: { cols: number; rows: number };
  fit() {
    terminalFitCalls.push("fit");
    if (this.terminal && terminalProposedDimensions) Object.assign(this.terminal, terminalProposedDimensions);
  }
  proposeDimensions() { return terminalProposedDimensions; }
} }));

vi.mock("../src/workbook/lesson-links.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/workbook/lesson-links.js")>();
  return { ...actual, lessonElementId: vi.fn(actual.lessonElementId) };
});

import { TimelineThread } from "../web-workbook/src/timeline-thread.js";
import { ActivityBand, activityGeometryFor } from "../web-workbook/src/activity-band.js";
import { App, BlockView, ContinuationPageBreak, LessonCompletionConfetti, LessonRail, TerminalHistory, completionAgeLabel, navigateToAnchor, scrollRunwayBlockIds, type Block, type Chapter, type EditorPracticeBlock, type Lesson, type Progress, type State } from "../web-workbook/src/workbook-ui.js";

const stylesCss = readFileSync(new URL("../web-workbook/src/styles.css", import.meta.url), "utf8");

const progress: Progress = {
  activeLessonId: "part/lesson-one",
  activeBlockId: "orientation",
  completedLessons: [],
  blocks: [
    { id: "orientation", type: "narrative", ready: true, active: true, completed: false, verified: false, emerged: true },
    { id: "practice", type: "terminal-practice", ready: false, active: false, completed: false, verified: false, emerged: false },
    { id: "reflect", type: "reflection", ready: false, active: false, completed: false, verified: false, emerged: false },
    { id: "transition", type: "narrative", ready: false, active: false, completed: false, verified: false, emerged: false },
  ],
  reflections: {},
  reflectionConversations: {},
};

/**
 * Attaches the private tutor text a block carries on the server. publicBlock() strips it before any
 * block reaches the browser, and EditorPracticeBlock types it `never`, so this shape cannot arrive
 * over the API. The fixtures build it on purpose: the leak assertions below need something that
 * could leak, and they prove the view would not render it even if handed some.
 */
function withPrivateTutorText<T extends Block>(block: T, tutor: string): T {
  return { ...block, tutor } as T;
}

const lesson: Lesson = {
  id: "part/lesson-one",
  title: "Markdown Lesson",
  dek: "Dek paragraph.",
  introduction: "Full **lesson introduction**.\n\n- First idea\n- Second idea",
  durationMinutes: 14,
  outcomes: ["Run the supplied command.", "Explain what changed."],
  blocks: [
    withPrivateTutorText({ id: "orientation", type: "narrative", title: "Orientation", markdown: "Read **carefully**.\n\n- One\n- Two" }, "private narrative note"),
    withPrivateTutorText({ id: "practice", type: "terminal-practice", title: "Practice", markdown: "Run this:\n\n```sh command\necho hi \\\n  | cat\n```" }, "private practice guidance"),
    withPrivateTutorText({ id: "reflect", type: "reflection", title: "Reflect", markdown: "Why did it work?" }, "private reflection prompt"),
    { id: "transition", type: "narrative", title: "Next", markdown: "Continue to **lesson two**." },
  ],
};

function html(element: ReturnType<typeof createElement>) {
  return renderToStaticMarkup(element);
}

function chapter(overrides: Partial<Chapter> = {}): Chapter & { lesson: typeof lesson } {
  return { id: lesson.id, part: "Part One", partMarkdown: "Part copy.", partNumber: 1, lessonNumber: 1, title: lesson.title, lesson, ...overrides } as Chapter & { lesson: typeof lesson };
}

const editorBlock = withPrivateTutorText<EditorPracticeBlock>({
  id: "edit-answer",
  type: "editor-practice",
  title: "Edit the answer",
  markdown: "Update the answer file so it contains the acceptance marker.",
  path: "factory/answer.md",
}, "Private editor rubric: require the acceptance marker.");

function activeEditorProgressFor(block: EditorPracticeBlock, overrides: Partial<Progress["blocks"][number]> = {}): Progress {
  return {
    ...progress,
    activeBlockId: block.id,
    blocks: [{ id: block.id, type: "editor-practice", ready: true, active: true, completed: false, verified: false, emerged: true, editorStatus: "editing", ...overrides } as any],
  };
}

function activeEditorProgress(overrides: Partial<Progress["blocks"][number]> = {}): Progress {
  return activeEditorProgressFor(editorBlock, overrides);
}

function EditorCommitWindowHarness({ block, progress, refresh, afterLayout, afterPassive }: {
  block: EditorPracticeBlock;
  progress: Progress;
  refresh(state: State): void;
  afterLayout?(): void;
  afterPassive?(): void;
}) {
  useLayoutEffect(() => { afterLayout?.(); }, [afterLayout]);
  useEffect(() => { afterPassive?.(); }, [afterPassive]);
  return createElement(BlockView, { block, progress, refresh });
}

function activeBlockProgress(block: { id: string; type: string }, overrides: Partial<Progress["blocks"][number]> = {}): Progress {
  return {
    ...progress,
    activeBlockId: block.id,
    blocks: [{ id: block.id, type: block.type, ready: true, active: true, completed: false, verified: false, emerged: true, ...overrides } as any],
  };
}

// HTTP mocks use the same complete response shape the browser validates in production.
function workbookState(progress: Progress): State {
  return { workbook: { title: "Workbook" }, introduction: "Intro.", introductionComplete: true, chapters: [chapter()], progress, adapter: {}, timeline: [] };
}

let mountedRoot: Root | undefined;
let dom: JSDOM | undefined;

afterEach(async () => {
  if (mountedRoot) await act(async () => { mountedRoot!.unmount(); });
  mountedRoot = undefined;
  dom?.window.close();
  dom = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  confettiMock.cannon.mockClear();
  confettiMock.create.mockClear();
  confettiMock.reset.mockClear();
  terminalDataListeners.splice(0);
  terminalInstances.splice(0);
  terminalFitCalls.splice(0);
  terminalProposedDimensions = { cols: 80, rows: 24 };
});

// Every test in this file renders a component into a fresh JSDOM document, so
// only `window`, `document`, and the React act() environment flag are stubbed
// here. Globals that only App() needs (a window scroll listener and a
// scrollIntoView polyfill JSDOM does not implement) are stubbed by callers
// that actually mount App(), via the optional stubExtraGlobals hook below.
async function mount(element: ReturnType<typeof createElement>, stubExtraGlobals?: (win: JSDOM["window"]) => void) {
  dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", { url: "http://localhost/workbook" });
  vi.stubGlobal("window", dom.window as any);
  vi.stubGlobal("document", dom.window.document as any);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // Legacy IE handlers, absent from jsdom and from the DOM lib, that a dependency probes for.
  const legacyPrototype = dom.window.HTMLElement.prototype as unknown as Record<string, () => void>;
  if (!("attachEvent" in legacyPrototype)) legacyPrototype.attachEvent = () => {};
  if (!("detachEvent" in legacyPrototype)) legacyPrototype.detachEvent = () => {};
  stubExtraGlobals?.(dom.window);
  const container = dom.window.document.getElementById("root")!;
  mountedRoot = createRoot(container);
  await act(async () => { mountedRoot!.render(element); });
  return container;
}

// App() listens for window scroll events to highlight the viewed lesson and
// calls scrollIntoView on mount; JSDOM implements neither, so only the test
// that mounts the full App() shell stubs them, scoped to that one call.
function stubAppShellGlobals(win: JSDOM["window"]) {
  if (!win.HTMLElement.prototype.scrollIntoView) win.HTMLElement.prototype.scrollIntoView = () => {};
  vi.stubGlobal("addEventListener", win.addEventListener.bind(win) as any);
  vi.stubGlobal("removeEventListener", win.removeEventListener.bind(win) as any);
}

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly listeners = new Map<string, Array<(event: { data: string }) => void>>();
  readonly url: string;
  closed = false;
  constructor(url: string) { this.url = url; FakeEventSource.instances.push(this); }
  addEventListener(event: string, listener: (event: { data: string }) => void) { (this.listeners.get(event) ?? this.listeners.set(event, []).get(event)!).push(listener); }
  close() { this.closed = true; }
  emit(event: string, data: unknown = {}) { for (const listener of this.listeners.get(event) ?? []) listener({ data: JSON.stringify(data) }); }
  listenerCount(event: string) { return this.listeners.get(event)?.length ?? 0; }
  static reset() { FakeEventSource.instances = []; }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolver) => { resolve = resolver; });
  return { promise, resolve };
}

function scrollPromotionFixture() {
  const initialState = {
    workbook: { title: "Workbook" },
    introduction: "Intro.",
    introductionComplete: false,
    chapters: [{ id: "001-first", title: "First", part: "Part One", partId: "validation-loop", partMarkdown: "Part copy.", lessonNumber: 1 }],
    progress: {
      activeLessonId: "001-first",
      activeBlockId: "workbook--introduction",
      activeAnchorId: "workbook--introduction",
      completedLessons: [],
      completedBlocks: [],
      workAcceptedBlocks: ["workbook--introduction"],
      readyBlocks: ["part--validation-loop"],
      blocks: [
        { id: "workbook--introduction", type: "workbook-introduction", ready: false, active: true, completed: false, verified: false, emerged: true, workAccepted: true },
        { id: "part--validation-loop", type: "part-preamble", ready: true, active: false, completed: false, verified: false, emerged: true },
      ],
      reflections: {},
      reflectionConversations: {},
      canComplete: { blockId: "workbook--introduction", eligible: true },
    },
    adapter: {},
    revealedBlockIds: ["workbook--introduction"],
    renderedBlockIds: ["workbook--introduction", "part--validation-loop"],
    readyBlockIds: ["part--validation-loop"],
    orderedBlocks: [
      { id: "workbook--introduction", anchorId: "workbook--introduction", title: "Workbook", origin: "structural", kind: "workbook-introduction", lessonId: "workbook--introduction" },
      { id: "part--validation-loop", anchorId: "part--validation-loop", title: "Part One", origin: "structural", kind: "part-preamble", lessonId: "part--validation-loop" },
    ],
    timeline: [
      { type: "message", id: "intro", sequence: 1, at: "2026-08-21T00:00:00.000Z", lessonId: "workbook--introduction", blockId: "workbook--introduction", role: "assistant", source: "authored", presentation: "course", text: "# Workbook\n\nIntro copy." },
      { type: "message", id: "intro-tutor", sequence: 2, at: "2026-08-21T00:00:00.500Z", lessonId: "workbook--introduction", blockId: "workbook--introduction", role: "assistant", source: "main_tutor", presentation: "chat", text: "Tutor chat before continuing." },
      { type: "message", id: "part", sequence: 3, at: "2026-08-21T00:00:01.000Z", lessonId: "part--validation-loop", blockId: "part--validation-loop", role: "assistant", source: "authored", presentation: "course", text: "# Part One\n\nPart copy." },
    ],
  } as any;
  const completedState = {
    ...initialState,
    introductionComplete: true,
    progress: {
      ...initialState.progress,
      activeBlockId: "part--validation-loop",
      activeAnchorId: "part--validation-loop",
      completedBlocks: ["workbook--introduction"],
      readyBlocks: [],
      blocks: initialState.progress.blocks.map((block: any) => block.id === "workbook--introduction" ? { ...block, active: false, completed: true } : { ...block, active: true, ready: false, workAccepted: true }),
    },
    revealedBlockIds: ["workbook--introduction", "part--validation-loop"],
    readyBlockIds: [],
  } as any;
  return { initialState, completedState };
}

describe("workbook lesson UI", () => {
  it("formats a compact completion age", () => {
    const now = Date.parse("2026-08-26T12:00:00.000Z");
    expect(completionAgeLabel("2026-08-26T11:59:40.000Z", now)).toBe("Completed just now");
    expect(completionAgeLabel("2026-08-26T11:58:00.000Z", now)).toBe("Completed 2m ago");
    expect(completionAgeLabel("2026-08-26T09:00:00.000Z", now)).toBe("Completed 3h ago");
  });

  it("uses a completion indicator while preserving the continuation layout", () => {
    const markup = html(createElement(ContinuationPageBreak, { completedAt: new Date().toISOString() }));
    expect(markup).toContain('class="continuation-completed"');
    expect(markup).toContain(">Completed just now</time>");
    expect(markup).toContain('class="continuation-page-break"');
    expect(markup).not.toContain("<button");
  });

  it("updates the URL fragment before scrolling an explicit anchor navigation", () => {
    dom = new JSDOM("<!doctype html><html><body><section id=\"target\" tabindex=\"-1\"><h2>Target</h2></section></body></html>", { url: "http://localhost/workbook" });
    vi.stubGlobal("window", dom.window as any);
    vi.stubGlobal("document", dom.window.document as any);
    vi.stubGlobal("location", dom.window.location);
    vi.stubGlobal("history", dom.window.history);
    const observedHashes: string[] = [];
    dom.window.HTMLElement.prototype.scrollIntoView = function () { observedHashes.push(dom!.window.location.hash); };

    expect(navigateToAnchor("target", "push")).toBe(true);

    expect(observedHashes).toEqual(["#target"]);
    expect(location.hash).toBe("#target");
  });

  it("refreshes state in place on author hot-reload SSE and preserves the current URL anchor", async () => {
    const { completedState } = scrollPromotionFixture();
    const reloadedState = { ...completedState, workbook: { title: "Reloaded Workbook" }, introduction: "Reloaded intro copy.", timeline: [{ ...completedState.timeline[0], text: "# Reloaded Workbook\n\nReloaded intro copy." }, ...completedState.timeline.slice(1)] } as any;
    FakeEventSource.reset();
    const fetchMock = vi.fn(async (input?: RequestInfo | URL) => ({ ok: true, json: async () => String(input).startsWith("api/workbook/state") ? reloadedState : completedState }));
    const scrollIntoView = vi.fn();
    const replaceState = vi.fn();
    const pushState = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("EventSource", FakeEventSource as any);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 1; });

    const container = await mount(createElement(App), (win) => {
      stubAppShellGlobals(win);
      win.HTMLElement.prototype.scrollIntoView = scrollIntoView;
      win.history.replaceState(null, "", "#part--validation-loop");
      vi.stubGlobal("location", win.location);
      vi.stubGlobal("history", { pushState, replaceState });
    });
    await act(async () => { await Promise.resolve(); });
    expect(FakeEventSource.instances[0]!.url).toBe("api/workbook/timeline");
    expect(FakeEventSource.instances[0]!.listenerCount("record")).toBe(1);
    expect(FakeEventSource.instances[0]!.listenerCount("state")).toBe(1);
    expect(FakeEventSource.instances[0]!.listenerCount("content-reloaded")).toBe(1);
    expect(FakeEventSource.instances[0]!.listenerCount("content-reload-error")).toBe(1);
    expect(container.textContent).toContain("Workbook");

    await act(async () => { FakeEventSource.instances[0]!.emit("content-reload-error", { message: "workbook.md front matter is incomplete" }); });
    expect(container.textContent).toContain("Author reload failed.");
    expect(container.textContent).toContain("workbook.md front matter is incomplete");
    expect(container.textContent).toContain("Workbook");

    scrollIntoView.mockClear();
    await act(async () => { FakeEventSource.instances[0]!.emit("content-reloaded", { generation: 2 }); await Promise.resolve(); });
    expect(fetchMock).toHaveBeenCalledWith("api/workbook/state", { method: "GET" });
    expect(container.textContent).toContain("Reloaded Workbook");
    expect(container.textContent).toContain("Reloaded intro copy.");
    expect(container.textContent).not.toContain("Author reload failed.");
    expect(location.hash).toBe("#part--validation-loop");
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(replaceState).not.toHaveBeenCalledWith(null, "", "#workbook--introduction");
    expect(pushState).not.toHaveBeenCalled();
  });

  it("refreshes authoritative state for public record and state SSE without letting stale responses win", async () => {
    FakeEventSource.reset();
    const reflectionProgress = activeBlockProgress(lesson.blocks[2]!, {
      checkpoint: { status: "reviewing", evidence: { kind: "reflection", conversation: [{ role: "learner", text: "I would inspect the flow map." }] } }
    } as any);
    const initialState = {
      workbook: { title: "Workbook" },
      introduction: "Intro.",
      introductionComplete: true,
      chapters: [chapter()],
      progress: reflectionProgress,
      adapter: {},
      timeline: [
        { type: "message", id: "course", sequence: 1, at: "2026-08-21T00:00:00.000Z", lessonId: lesson.id, blockId: "reflect", role: "assistant", source: "authored", presentation: "course", text: "## Reflect\n\nWhy did it work?" },
        { type: "message", id: "learner", sequence: 2, at: "2026-08-21T00:00:01.000Z", lessonId: lesson.id, blockId: "reflect", role: "user", source: "learner", presentation: "chat", text: "I would inspect the flow map." },
      ],
    } as any;
    const staleReviewState = {
      ...initialState,
      timeline: [...initialState.timeline, { type: "message", id: "stale-review", sequence: 3, at: "2026-08-21T00:00:02.000Z", lessonId: lesson.id, blockId: "reflect", role: "assistant", source: "main_tutor", presentation: "review", text: "Older tutor review that must not win." }],
    } as any;
    const latestReviewState = {
      ...initialState,
      progress: activeBlockProgress(lesson.blocks[2]!, {
        checkpoint: { status: "accepted", successMessage: "Accepted.", evidence: { kind: "reflection", conversation: [{ role: "learner", text: "I would inspect the flow map." }, { role: "tutor", text: "Final tutor review added asynchronously." }] } }
      } as any),
      timeline: [...initialState.timeline, { type: "message", id: "latest-review", sequence: 4, at: "2026-08-21T00:00:03.000Z", lessonId: lesson.id, blockId: "reflect", role: "assistant", source: "main_tutor", presentation: "review", text: "Final tutor review added asynchronously." }],
    } as any;
    const firstRecordFetch = deferred<any>();
    const secondRecordFetch = deferred<any>();
    let stateFetches = 0;
    const response = (state: any) => ({ ok: true, json: async () => state });
    const fetchMock = vi.fn(async (input?: RequestInfo | URL) => {
      expect(String(input)).toMatch(/api\/workbook\/state$/);
      stateFetches += 1;
      if (stateFetches === 1) return response(initialState);
      if (stateFetches === 2) return firstRecordFetch.promise.then(response);
      if (stateFetches === 3) return secondRecordFetch.promise.then(response);
      return response(latestReviewState);
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("EventSource", FakeEventSource as any);

    const container = await mount(createElement(App), stubAppShellGlobals);
    await act(async () => { await Promise.resolve(); });

    const events = FakeEventSource.instances[0]!;
    expect(events.url).toBe("api/workbook/timeline");
    expect(events.listenerCount("record")).toBe(1);
    expect(events.listenerCount("state")).toBe(1);
    expect(container.textContent).toContain("I would inspect the flow map.");
    expect(container.textContent).toContain("Thinking");
    expect(container.querySelector('.timeline-message.tutor.thinking[role="status"][aria-label="Tutor is thinking"]')).toBeTruthy();
    expect(container.textContent).not.toContain("Final tutor review added asynchronously.");

    await act(async () => { events.emit("record", { sequence: 3 }); await Promise.resolve(); });
    await act(async () => { events.emit("state", { blockId: "reflect", revision: 1 }); await Promise.resolve(); });
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("api/workbook/state"))).toHaveLength(3);

    await act(async () => { secondRecordFetch.resolve(latestReviewState); await Promise.resolve(); });
    expect(container.textContent).toContain("Tutor review");
    expect(container.textContent).toContain("Final tutor review added asynchronously.");
    expect(container.querySelector(".timeline-message.tutor.thinking")).toBeNull();

    await act(async () => { firstRecordFetch.resolve(staleReviewState); await Promise.resolve(); });
    expect(container.textContent).toContain("Final tutor review added asynchronously.");
    expect(container.textContent).not.toContain("Older tutor review that must not win.");
  });

  it("ignores stale editor SSE state that accepts a draft after the learner has typed a newer one", async () => {
    vi.useFakeTimers();
    FakeEventSource.reset();
    const editorLesson = { ...lesson, blocks: [editorBlock] } as Lesson;
    const editorChapter = { ...chapter(), lesson: editorLesson } as Chapter & { lesson: Lesson };
    const initialState = {
      workbook: { title: "Workbook" },
      introduction: "Intro.",
      introductionComplete: true,
      chapters: [editorChapter],
      progress: activeEditorProgress({ revision: 0, draftText: "" } as any),
      adapter: {},
      timeline: [{ type: "message", id: "course", sequence: 1, at: "2026-08-21T00:00:00.000Z", lessonId: lesson.id, blockId: editorBlock.id, role: "assistant", source: "authored", presentation: "course", text: "## Edit the answer" }],
    } as State;
    const firstReviewState = { ...initialState, progress: activeEditorProgress({ revision: 1, draftText: "submitted draft", editorStatus: "reviewing", checkpoint: { status: "reviewing", evidence: { kind: "editor", text: "submitted draft" } } } as any) } as State;
    const staleAcceptedState = { ...initialState, progress: activeEditorProgress({ revision: 1, draftText: "submitted draft", editorStatus: "unlocked", completed: true, checkpoint: { status: "accepted", successMessage: "Old draft accepted.", evidence: { kind: "editor", text: "submitted draft" } } } as any) } as State;
    let stateFetches = 0;
    const fetchMock = vi.fn(async (input?: RequestInfo | URL, _init?: RequestInit) => {
      if (String(input).endsWith("api/workbook/editor")) return { ok: true, json: async () => firstReviewState };
      expect(String(input)).toMatch(/api\/workbook\/state$/);
      stateFetches += 1;
      return { ok: true, json: async () => stateFetches === 1 ? initialState : staleAcceptedState };
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("EventSource", FakeEventSource as any);

    const container = await mount(createElement(App), stubAppShellGlobals);
    await act(async () => { await Promise.resolve(); });
    const events = FakeEventSource.instances[0]!;
    const editor = container.querySelector<HTMLElement>("[role='textbox'][contenteditable='true']")!;

    editor.textContent = "submitted draft";
    await act(async () => { editor.dispatchEvent(new window.Event("input", { bubbles: true })); vi.advanceTimersByTime(750); await Promise.resolve(); await Promise.resolve(); });
    expect(JSON.parse(String(fetchMock.mock.calls.find(([url]) => String(url).endsWith("api/workbook/editor"))![1]!.body))).toMatchObject({ revision: 1, text: "submitted draft" });

    editor.textContent = "unsent newer draft";
    await act(async () => { editor.dispatchEvent(new window.Event("input", { bubbles: true })); vi.advanceTimersByTime(749); await Promise.resolve(); });
    await act(async () => { events.emit("state", { blockId: editorBlock.id, revision: 1 }); await Promise.resolve(); await Promise.resolve(); });

    expect(container.querySelector("[role='textbox'][contenteditable='true']")).toBe(editor);
    expect(editor.textContent).toBe("unsent newer draft");
    expect(container.textContent).not.toContain("Old draft accepted.");
    expect(container.textContent).not.toContain("Accepted revision unlocked the next step.");
  });

  it("falls back to the active anchor without a modal when the URL anchor is no longer valid", async () => {
    const { completedState } = scrollPromotionFixture();
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => completedState }));
    const scrollIntoView = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 1; });

    const container = await mount(createElement(App), (win) => {
      stubAppShellGlobals(win);
      win.HTMLElement.prototype.scrollIntoView = scrollIntoView;
      win.history.replaceState(null, "", "#removed-by-author");
      const replaceState = vi.spyOn(win.history, "replaceState");
      vi.stubGlobal("location", win.location);
      vi.stubGlobal("history", win.history);
      replaceState.mockClear();
    });
    await act(async () => { await Promise.resolve(); });

    expect(container.textContent).not.toContain("The lesson you're linking to is not ready yet");
    expect(location.hash).toBe("#part--validation-loop");
    expect(history.replaceState).toHaveBeenCalledWith(null, "", "#part--validation-loop");
  });

  it("submits the typed tutor message with Enter", async () => {
    const onSend = vi.fn(async () => undefined);
    const container = await mount(createElement(TimelineThread, {
      activeLessonId: "part/lesson-one",
      activeBlockId: "orientation",
      onSend,
      records: []
    }));
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea[name='message']")!;

    textarea.value = "What should I try next?";
    textarea.focus();
    await act(async () => { textarea.dispatchEvent(new window.Event("input", { bubbles: true })); });
    await act(async () => { textarea.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });

    expect(onSend).toHaveBeenCalledWith("What should I try next?");
  });

  it("keeps Shift+Enter in the tutor composer as a newline without submitting", async () => {
    const onSend = vi.fn(async () => undefined);
    const container = await mount(createElement(TimelineThread, {
      activeLessonId: "part/lesson-one",
      activeBlockId: "orientation",
      onSend,
      records: []
    }));
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea[name='message']")!;

    textarea.value = "Line one";
    textarea.selectionStart = textarea.selectionEnd = textarea.value.length;
    textarea.focus();
    await act(async () => { textarea.dispatchEvent(new window.Event("input", { bubbles: true })); });
    await act(async () => { textarea.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true })); });

    expect(onSend).not.toHaveBeenCalled();
    expect(textarea.value).toBe("Line one\n");
  });

  it("keeps the docked composer visually compact while preserving accessible labels", async () => {
    const container = await mount(createElement(TimelineThread, {
      activeLessonId: "part/lesson-one",
      activeBlockId: "orientation",
      onSend: vi.fn(async () => undefined),
      records: []
    }));

    const dock = container.querySelector(".timeline-composer-dock.fixed-composer");
    const form = container.querySelector("form.timeline-input.fixed-composer");
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea[name='message']")!;

    expect(dock).not.toBeNull();
    expect(form).not.toBeNull();
    expect(textarea.getAttribute("aria-label")).toBe("Message the tutor");
    expect(textarea.classList.contains("timeline-composer-textarea")).toBe(true);
    expect(textarea.rows).toBe(1);
    expect(container.querySelector("label")).toBeNull();
    expect(container.textContent).not.toContain("Message the tutor");
    expect(container.querySelector(".round-send")?.getAttribute("aria-label")).toBe("Send message");
  });

  it("auto-sizes the docked composer from one line as draft content grows", async () => {
    const container = await mount(createElement(TimelineThread, {
      activeLessonId: "part/lesson-one",
      activeBlockId: "orientation",
      onSend: vi.fn(async () => undefined),
      records: []
    }));
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea[name='message']")!;
    let scrollHeight = 42;
    Object.defineProperty(textarea, "scrollHeight", { configurable: true, get: () => scrollHeight });

    textarea.value = "Line one";
    await act(async () => { textarea.dispatchEvent(new window.Event("input", { bubbles: true })); });

    expect(textarea.style.height).toBe("42px");
    expect(textarea.style.overflowY).toBe("hidden");

    scrollHeight = 94;
    textarea.value = "Line one\nLine two\nLine three";
    await act(async () => { textarea.dispatchEvent(new window.Event("input", { bubbles: true })); });

    expect(textarea.style.height).toBe("94px");
    expect(textarea.style.overflowY).toBe("hidden");
  });

  it("caps docked composer growth and enables vertical scrolling without field-sizing support", async () => {
    const container = await mount(createElement(TimelineThread, {
      activeLessonId: "part/lesson-one",
      activeBlockId: "orientation",
      onSend: vi.fn(async () => undefined),
      records: []
    }));
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea[name='message']")!;
    Object.defineProperty(textarea, "scrollHeight", { configurable: true, get: () => 240 });

    textarea.value = "Line one\nLine two\nLine three\nLine four\nLine five\nLine six";
    await act(async () => { textarea.dispatchEvent(new window.Event("input", { bubbles: true })); });

    expect(textarea.style.height).toBe("160px");
    expect(textarea.style.overflowY).toBe("auto");
  });

  it("clears the composer and disables sending while the tutor POST is pending without adding local chat records", async () => {
    let resolveSend!: () => void;
    const onSend = vi.fn(() => new Promise<void>((resolve) => { resolveSend = resolve; }));
    const container = await mount(createElement(TimelineThread, {
      activeLessonId: "part/lesson-one",
      activeBlockId: "orientation",
      onSend,
      records: []
    }));
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea[name='message']")!;
    const sendButton = container.querySelector<HTMLButtonElement>(".round-send")!;

    textarea.value = "What should I try next?";
    textarea.focus();
    await act(async () => { textarea.dispatchEvent(new window.Event("input", { bubbles: true })); });
    await act(async () => { textarea.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });

    expect(onSend).toHaveBeenCalledWith("What should I try next?");
    expect(textarea.value).toBe("");
    expect(textarea.disabled).toBe(true);
    expect(sendButton.disabled).toBe(true);
    expect(container.querySelector(".timeline-message.learner")).toBeNull();
    expect(container.querySelector(".timeline-message.tutor.thinking")).toBeNull();

    await act(async () => { resolveSend(); await Promise.resolve(); });

    expect(textarea.disabled).toBe(false);
    expect(container.querySelector(".timeline-message.learner")).toBeNull();
    expect(container.querySelector(".timeline-message.tutor.thinking")).toBeNull();
  });

  it("restores the draft if onSend rejects without adding local chat records", async () => {
    let rejectSend!: (error: Error) => void;
    const onSend = vi.fn(() => new Promise<void>((_resolve, reject) => { rejectSend = reject; }));
    const container = await mount(createElement(TimelineThread, {
      activeLessonId: "part/lesson-one",
      activeBlockId: "orientation",
      onSend,
      records: []
    }));
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea[name='message']")!;

    textarea.value = "What should I try next?";
    textarea.focus();
    await act(async () => { textarea.dispatchEvent(new window.Event("input", { bubbles: true })); });
    await act(async () => { textarea.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });

    expect(onSend).toHaveBeenCalledWith("What should I try next?");
    expect(textarea.value).toBe("");
    expect(textarea.disabled).toBe(true);
    expect(container.querySelector(".timeline-message.learner")).toBeNull();

    const onUnhandledRejection = (error: unknown) => { void error; };
    process.on("unhandledRejection", onUnhandledRejection);
    try {
      await act(async () => {
        rejectSend(new Error("send failed"));
        await Promise.resolve().then(() => Promise.resolve());
      });
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }

    expect(textarea.value).toBe("What should I try next?");
    expect(textarea.disabled).toBe(false);
    expect(container.querySelector(".timeline-message.learner")).toBeNull();
  });

  it("renders authored timeline entries as plain page content while dynamic messages stay carded", async () => {
    const container = await mount(createElement(TimelineThread, {
      activeLessonId: "part/lesson-one",
      activeBlockId: "orientation",
      onSend: vi.fn(async () => undefined),
      records: [
        { type: "message", id: "course", sequence: 1, at: "2026-08-21T00:00:00.000Z", lessonId: "part/lesson-one", blockId: "orientation", role: "assistant", source: "authored", presentation: "course", text: "## Orientation\n\nAuthored page prose." },
        { type: "message", id: "learner", sequence: 2, at: "2026-08-21T00:00:01.000Z", lessonId: "part/lesson-one", blockId: "orientation", role: "user", source: "learner", presentation: "chat", text: "Learner reply." },
        { type: "message", id: "tutor", sequence: 3, at: "2026-08-21T00:00:02.000Z", lessonId: "part/lesson-one", blockId: "orientation", role: "assistant", source: "main_tutor", presentation: "chat", text: "Tutor reply." },
        { type: "message", id: "hint", sequence: 4, at: "2026-08-21T00:00:03.000Z", lessonId: "part/lesson-one", blockId: "orientation", role: "assistant", source: "main_tutor", presentation: "review", text: "Tutor review." },
        { type: "message", id: "review", sequence: 5, at: "2026-08-21T00:00:04.000Z", lessonId: "part/lesson-one", blockId: "orientation", role: "assistant", source: "main_tutor", presentation: "review", text: "Review reply." },
      ] as any
    }));

    const authored = container.querySelector(".timeline-authored-content");
    expect(authored).not.toBeNull();
    expect(authored?.textContent).toContain("Authored page prose.");
    expect(authored?.classList.contains("timeline-message")).toBe(false);
    expect(authored?.classList.contains("authored")).toBe(false);
    expect(authored?.textContent).not.toContain("Course note");
    expect(container.querySelector(".timeline-message.authored")).toBeNull();
    expect(container.querySelector(".timeline-message.learner")?.textContent).toContain("Learner reply.");
    expect(container.querySelector(".timeline-message.tutor:not(.hint):not(.review)")?.textContent).toContain("Tutor reply.");
    expect(container.querySelector(".timeline-message.tutor.review")?.textContent).toContain("Tutor review.");
    expect(container.querySelector(".timeline-message.tutor.review")?.textContent).toContain("Tutor review.");
  });

  it("keeps terminal A's snapshot below A while terminal B owns the live surface without duplicate anchors", () => {
    const firstId = "lesson--001-first--run";
    const secondId = "lesson--001-first--change";
    const records = [
      { type: "message", id: "first", sequence: 1, at: "2026-08-21T00:00:00.000Z", lessonId: "001-first", blockId: firstId, role: "assistant", source: "authored", presentation: "course", text: "## First terminal" },
      { type: "message", id: "second", sequence: 2, at: "2026-08-21T00:00:01.000Z", lessonId: "001-first", blockId: secondId, role: "assistant", source: "authored", presentation: "course", text: "## Second terminal" },
    ] as const;
    const firstTerminalState = { id: firstId, type: "terminal-practice", ready: false, active: false, completed: true, verified: true, emerged: true, terminal: { phase: "complete" as const, message: "Accepted." }, terminalSnapshot: { transcript: "terminal A only" } };
    const markup = html(createElement(TimelineThread, {
      activeLessonId: "001-first",
      activeBlockId: secondId,
      onSend: vi.fn(async () => undefined),
      records,
      renderTerminalHistory: (record) => record.blockId === firstId
        ? createElement(TerminalHistory, { state: firstTerminalState as any })
        : null,
      practiceSurfaceBlockId: secondId,
      practiceSurface: createElement("div", { "data-live-terminal": secondId }, "live B")
    }));

    expect(markup.indexOf("First terminal")).toBeLessThan(markup.indexOf("terminal A only"));
    expect(markup.indexOf("terminal A only")).toBeLessThan(markup.indexOf("Second terminal"));
    expect(markup.indexOf("Second terminal")).toBeLessThan(markup.indexOf("live B"));
    expect(markup.match(new RegExp(`id=\\"${firstId}\\"`, "g"))).toHaveLength(1);
    expect(markup.match(new RegExp(`id=\\"${secondId}\\"`, "g"))).toHaveLength(1);
    expect(markup.match(/terminal A only/g)).toHaveLength(1);
    expect(markup).not.toContain("terminal B only");
  });

  it("renders Do it for me only for the active authored terminal record with an insertion callback", () => {
    const record = { type: "message", id: "course", sequence: 1, at: "2026-08-21T00:00:00.000Z", lessonId: "part/lesson-one", blockId: "practice", role: "assistant", source: "authored", presentation: "course", text: "## Practice\n\nRun the command." } as const;
    const sharedProps = { onSend: vi.fn(async () => undefined), records: [record] };

    const activeMarkup = html(createElement(TimelineThread, { ...sharedProps, activeLessonId: record.lessonId, activeBlockId: record.blockId, onDoItForMe: vi.fn() }));
    const inactiveMarkup = html(createElement(TimelineThread, { ...sharedProps, activeLessonId: record.lessonId, activeBlockId: "other", onDoItForMe: vi.fn() }));
    const unavailableMarkup = html(createElement(TimelineThread, { ...sharedProps, activeLessonId: record.lessonId, activeBlockId: record.blockId }));

    expect(activeMarkup.match(/Do it for me/g)).toHaveLength(1);
    expect(inactiveMarkup).not.toContain("Do it for me");
    expect(unavailableMarkup).not.toContain("Do it for me");
  });

  it("marks only authored part records as timeline transitions", async () => {
    const container = await mount(createElement(TimelineThread, {
      activeLessonId: "part/lesson-one",
      activeBlockId: "orientation",
      onSend: vi.fn(async () => undefined),
      records: [
        { type: "message", id: "part", sequence: 1, at: "2026-08-21T00:00:00.000Z", lessonId: "workbook:part:part-one", blockId: "__part__", role: "assistant", source: "authored", presentation: "course", text: "# Part One" },
        { type: "message", id: "frame", sequence: 2, at: "2026-08-21T00:00:01.000Z", lessonId: "part/lesson-one", blockId: "__lesson_frame__", role: "assistant", source: "authored", presentation: "course", text: "# Lesson One" },
        { type: "message", id: "block", sequence: 3, at: "2026-08-21T00:00:02.000Z", lessonId: "part/lesson-one", blockId: "orientation", role: "assistant", source: "authored", presentation: "course", text: "## Orientation" },
      ] as any
    }));

    const part = container.querySelector(".timeline-authored-content.timeline-part-transition");
    const ordinary = [...container.querySelectorAll(".timeline-authored-content:not(.timeline-part-transition)")];

    expect(part?.textContent).toContain("Part One");
    expect(ordinary.map((node) => node.textContent)).toEqual(expect.arrayContaining([expect.stringContaining("Lesson One"), expect.stringContaining("Orientation")]));
    expect(container.querySelectorAll(".timeline-part-transition")).toHaveLength(1);
    expect(container.querySelectorAll(".timeline-lesson-transition")).toHaveLength(0);
  });

  it("ignores learner echoes and thinking statuses, and leaves already-visible appended responses stable", async () => {
    const scrollIntoView = vi.fn();
    const scrollTo = vi.fn();
    const baseRecords = [
      { type: "message", id: "course", sequence: 1, at: "2026-08-21T00:00:00.000Z", lessonId: "part/lesson-one", blockId: "orientation", role: "assistant", source: "authored", presentation: "course", text: "Course note" },
      { type: "message", id: "history", sequence: 2, at: "2026-08-21T00:00:01.000Z", lessonId: "part/lesson-one", blockId: "orientation", role: "assistant", source: "main_tutor", presentation: "chat", text: "Historic tutor reply" }
    ] as const;
    const render = (records: readonly any[], activeReflectionReviewing = false) => createElement(TimelineThread, {
      activeLessonId: "part/lesson-one",
      activeBlockId: "orientation",
      onSend: vi.fn(async () => undefined),
      activeReflectionReviewing,
      records
    });
    const container = await mount(render(baseRecords), (win) => {
      win.HTMLElement.prototype.scrollIntoView = scrollIntoView;
      win.scrollTo = scrollTo as any;
    });

    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(scrollTo).not.toHaveBeenCalled();

    const withLearner = [
      ...baseRecords,
      { type: "message", id: "learner", sequence: 3, at: "2026-08-21T00:00:02.000Z", lessonId: "part/lesson-one", blockId: "orientation", role: "user", source: "learner", presentation: "chat", text: "Learner follow-up" }
    ] as const;
    await act(async () => { mountedRoot!.render(render(withLearner)); });
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(scrollTo).not.toHaveBeenCalled();

    await act(async () => { mountedRoot!.render(render(withLearner, true)); });
    expect(container.querySelector('.timeline-message.tutor.thinking[role="status"][aria-label="Tutor is thinking"]')).toBeTruthy();
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(scrollTo).not.toHaveBeenCalled();

    const withReply = [
      ...withLearner,
      { type: "message", id: "reply", sequence: 4, at: "2026-08-21T00:00:03.000Z", lessonId: "part/lesson-one", blockId: "orientation", role: "assistant", source: "main_tutor", presentation: "chat", text: "Tutor reply" }
    ] as const;
    await act(async () => { mountedRoot!.render(render(withReply)); });

    expect([...container.querySelectorAll(".timeline-message.tutor")].at(-1)?.textContent).toContain("Tutor reply");
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(scrollTo).not.toHaveBeenCalled();

  });

  it("shows one persisted learner bubble and keeps an already-visible persisted tutor reply stable", async () => {
    let resolveSend!: () => void;
    const onSend = vi.fn(() => new Promise<void>((resolve) => { resolveSend = resolve; }));
    const scrollIntoView = vi.fn();
    const scrollTo = vi.fn();
    const course = { type: "message", id: "course", sequence: 1, at: "2026-08-21T00:00:00.000Z", lessonId: "part/lesson-one", blockId: "orientation", role: "assistant", source: "authored", presentation: "course", text: "Course note" } as const;
    const learner = { type: "message", id: "learner", sequence: 2, at: "2026-08-21T00:00:01.000Z", lessonId: "part/lesson-one", blockId: "orientation", role: "user", source: "learner", presentation: "chat", text: "What should I try next?" } as const;
    const reply = { type: "message", id: "reply", sequence: 3, at: "2026-08-21T00:00:02.000Z", lessonId: "part/lesson-one", blockId: "orientation", role: "assistant", source: "main_tutor", presentation: "chat", text: "Try the next visible command." } as const;
    const render = (records: readonly any[]) => createElement(TimelineThread, {
      activeLessonId: "part/lesson-one",
      activeBlockId: "orientation",
      onSend,
      records
    });
    const container = await mount(render([course]), (win) => {
      win.HTMLElement.prototype.scrollIntoView = scrollIntoView;
      win.scrollTo = scrollTo as any;
    });
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea[name='message']")!;

    textarea.value = "What should I try next?";
    textarea.focus();
    await act(async () => { textarea.dispatchEvent(new window.Event("input", { bubbles: true })); });
    await act(async () => { textarea.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });

    expect(onSend).toHaveBeenCalledWith("What should I try next?");
    expect(textarea.value).toBe("");
    expect(textarea.disabled).toBe(true);
    expect(container.querySelectorAll(".timeline-message.learner")).toHaveLength(0);
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(scrollTo).not.toHaveBeenCalled();

    await act(async () => { mountedRoot!.render(render([course, learner])); });

    const learnerBubbles = container.querySelectorAll(".timeline-message.learner");
    expect(learnerBubbles).toHaveLength(1);
    expect(learnerBubbles[0]?.textContent).toContain("What should I try next?");
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(scrollTo).not.toHaveBeenCalled();

    await act(async () => { mountedRoot!.render(render([course, learner, reply])); });

    expect(container.querySelectorAll(".timeline-message.learner")).toHaveLength(1);
    expect(container.querySelector(".timeline-message.tutor")?.textContent).toContain("Try the next visible command.");
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(scrollTo).not.toHaveBeenCalled();

    await act(async () => { resolveSend(); await Promise.resolve(); });
  });

  it("renders an active editor-practice block without exposing private tutor text", () => {
    const markup = html(createElement(BlockView, { block: editorBlock, progress: activeEditorProgress(), refresh: vi.fn() }));

    expect(markup).toContain("factory/answer.md");
    expect(markup).toContain("editor-surface");
    expect(markup).toContain("editor-feedback-overlay");
    expect(markup).toMatch(/editing|review/i);
    expect(markup).not.toContain("Private editor rubric");
    expect(markup).not.toContain("Save");
    expect(markup).not.toContain("Review");
  });

  it("uses the shared welded practice feedback bar for editor running, feedback, update, failure, and success states", async () => {
    const reviewingMarkup = html(createElement(BlockView, {
      block: editorBlock,
      progress: activeEditorProgress({ editorStatus: "reviewing", checkpoint: { status: "reviewing", evidence: { kind: "editor", text: "draft" } } } as any),
      refresh: vi.fn()
    }));
    expect(reviewingMarkup).toContain("practice-feedback-bar is-status is-busy");
    expect(reviewingMarkup).toContain("practice-feedback-spinner");
    expect(reviewingMarkup).toContain("Reviewing your latest revision…");

    const feedbackMarkup = html(createElement(BlockView, {
      block: editorBlock,
      progress: activeEditorProgress({ editorStatus: "feedback", checkpoint: { status: "feedback", feedback: "Add the acceptance marker.", evidence: { kind: "editor", text: "draft" } } } as any),
      refresh: vi.fn()
    }));
    expect(feedbackMarkup).toContain("practice-feedback-bar is-feedback");
    expect(feedbackMarkup).toContain("Add the acceptance marker.");
    expect(feedbackMarkup).not.toContain("practice-feedback-spinner");

    const container = await mount(createElement(BlockView, {
      block: editorBlock,
      progress: activeEditorProgress({ revision: 1, draftText: "first draft", editorStatus: "feedback", checkpoint: { status: "feedback", feedback: "Keep the old actionable feedback.", evidence: { kind: "editor", text: "first draft" } } } as any),
      refresh: vi.fn()
    }));
    await act(async () => {
      mountedRoot!.render(createElement(BlockView, {
        block: editorBlock,
        progress: activeEditorProgress({ revision: 2, draftText: "second draft", editorStatus: "reviewing", checkpoint: { status: "reviewing", evidence: { kind: "editor", text: "second draft" } } } as any),
        refresh: vi.fn()
      }));
    });
    const updatingBar = container.querySelector(".practice-feedback-bar.is-updating")!;
    expect(updatingBar.textContent).toContain("Keep the old actionable feedback.");
    expect(updatingBar.textContent).toContain("Updating feedback…");
    expect(updatingBar.querySelector(".practice-feedback-spinner")?.getAttribute("aria-hidden")).toBe("true");

    await act(async () => {
      mountedRoot!.render(createElement(BlockView, {
        block: editorBlock,
        progress: activeEditorProgress({ active: false, completed: true, editorStatus: "unlocked", checkpoint: { status: "accepted", successMessage: "Editor accepted.", evidence: { kind: "editor", text: "accepted" } } } as any),
        refresh: vi.fn()
      }));
    });
    expect(container.querySelector(".practice-feedback-bar.is-success")?.textContent).toContain("Editor accepted.");
  });

  it("shows the checkpoint feedback once, and not as a conversation message", () => {
    // Every review is logged, but a practice block displays only its latest feedback, beside the
    // work surface. It reaches the block through the checkpoint alone, so a second render site
    // would show the learner the same sentence twice.
    const feedback = "Name the acceptance marker and explain why it belongs there.";
    const markup = html(createElement(BlockView, {
      block: editorBlock,
      progress: activeEditorProgress({ editorStatus: "feedback", checkpoint: { status: "feedback", feedback } } as any),
      refresh: vi.fn()
    }));

    expect(markup).toContain(feedback);
    expect(markup.split(feedback).length - 1).toBe(1);
    expect(markup).toContain("editor-feedback");
    expect(markup).not.toContain("conversation-entry");
  });

  it("keeps previous editor feedback visible with a subtle update status while a new review is pending", async () => {
    const feedback = "Name the acceptance marker and explain why it belongs there.";
    const container = await mount(createElement(BlockView, {
      block: editorBlock,
      progress: activeEditorProgress({ revision: 1, draftText: "first draft", editorStatus: "feedback", checkpoint: { status: "feedback", feedback, evidence: { kind: "editor", text: "first draft" } } } as any),
      refresh: vi.fn()
    }));

    await act(async () => {
      mountedRoot!.render(createElement(BlockView, {
        block: editorBlock,
        progress: activeEditorProgress({ revision: 2, draftText: "second draft", editorStatus: "reviewing", checkpoint: { status: "reviewing", evidence: { kind: "editor", text: "second draft" } } } as any),
        refresh: vi.fn()
      }));
    });

    expect(container.textContent).toContain(feedback);
    expect(container.textContent).toContain("Updating feedback…");
    expect(container.querySelector(".practice-feedback-spinner")).not.toBeNull();
    expect(container.textContent).not.toContain("Reviewing your latest revision…");
  });

  it("replaces old editor feedback atomically only when latest feedback arrives", async () => {
    const container = await mount(createElement(BlockView, {
      block: editorBlock,
      progress: activeEditorProgress({ revision: 1, draftText: "first draft", editorStatus: "feedback", checkpoint: { status: "feedback", feedback: "Old actionable feedback.", evidence: { kind: "editor", text: "first draft" } } } as any),
      refresh: vi.fn()
    }));

    await act(async () => {
      mountedRoot!.render(createElement(BlockView, {
        block: editorBlock,
        progress: activeEditorProgress({ revision: 2, draftText: "second draft", editorStatus: "reviewing", checkpoint: { status: "reviewing", evidence: { kind: "editor", text: "second draft" } } } as any),
        refresh: vi.fn()
      }));
    });
    expect(container.textContent).toContain("Old actionable feedback.");

    await act(async () => {
      mountedRoot!.render(createElement(BlockView, {
        block: editorBlock,
        progress: activeEditorProgress({ revision: 2, draftText: "second draft", editorStatus: "feedback", checkpoint: { status: "feedback", feedback: "New actionable feedback.", evidence: { kind: "editor", text: "second draft" } } } as any),
        refresh: vi.fn()
      }));
    });

    expect(container.textContent).toContain("New actionable feedback.");
    expect(container.textContent).not.toContain("Old actionable feedback.");
    expect(container.textContent).not.toContain("Updating feedback…");
  });

  it("does not render live editor-practice surface or status for inactive and completed blocks", () => {
    const inactiveMarkup = html(createElement(BlockView, {
      block: editorBlock,
      progress: activeEditorProgress({ ready: false, active: false, completed: false, editorStatus: undefined, checkpoint: { status: "feedback", feedback: "Hold this feedback until the block is active." } } as any),
      refresh: vi.fn()
    }));
    const completedMarkup = html(createElement(BlockView, {
      block: editorBlock,
      progress: activeEditorProgress({ active: false, completed: true, editorStatus: "unlocked" } as any),
      refresh: vi.fn()
    }));

    expect(inactiveMarkup).toContain("factory/answer.md");
    expect(inactiveMarkup).not.toContain("editor-surface");
    expect(inactiveMarkup).not.toContain("editor-live-surface");
    expect(inactiveMarkup).not.toContain("editor-feedback-overlay");
    expect(inactiveMarkup).not.toMatch(/Editing —|Reviewing your latest revision/);

    expect(completedMarkup).toContain("factory/answer.md");
    expect(completedMarkup).toContain("Accepted revision unlocked the next step.");
    expect(completedMarkup).toContain("The latest accepted editor draft was written to the target file.");
    expect(completedMarkup).not.toContain("editor-surface");
    expect(completedMarkup).toContain("practice-feedback-bar is-success");
    expect(completedMarkup).toContain("role=\"status\"");
    expect(completedMarkup).not.toMatch(/Editing —|Reviewing your latest revision/);
  });

  it("renders a compact terminal activity without duplicating authored content", () => {
    const terminalBlock = lesson.blocks[1]!;
    const markup = html(createElement(ActivityBand, {
      lessonId: lesson.id,
      activeBlock: terminalBlock,
      progress: activeBlockProgress(terminalBlock),
      refresh: vi.fn()
    }));

    expect(markup).toContain("current-activity-band");
    expect(markup).toContain("data-activity-type=\"terminal-practice\"");
    expect(markup).toContain("data-activity-layout=\"scroll-linked\"");
    expect(markup).toContain('class="terminal-connection-status"');
    expect(markup).toContain('aria-label="Terminal disconnected"');
    expect(markup).not.toContain("Terminal practice");
    expect(markup).not.toContain("Run this in the embedded terminal");
    expect(markup).not.toContain("Observed by the tutor");
    expect(markup).not.toContain("Get a hint");
    expect(markup).not.toContain("Practice");
    expect(markup).not.toContain("Run this:");
    expect(markup).not.toContain("echo hi");
  });

  it("renders editor activity chrome without duplicating the authored title or markdown", () => {
    const markup = html(createElement(ActivityBand, {
      lessonId: lesson.id,
      activeBlock: editorBlock,
      progress: activeEditorProgress(),
      refresh: vi.fn()
    }));

    expect(markup).toContain("current-activity-band");
    expect(markup).toContain("data-activity-type=\"editor-practice\"");
    expect(markup).toContain("factory/answer.md");
    expect(markup).toContain("editor-surface");
    expect(markup).toContain("editor-feedback-overlay");
    expect(markup).not.toContain("Get a hint");
    expect(markup).not.toContain("Edit the answer");
    expect(markup).not.toContain("Update the answer file");
  });

  it("calculates left-aligned start, balanced growth, and full centered canvas geometry", () => {
    const mainRect = { left: 265, width: 1000 };
    const inlineRect = { left: 365, width: 720 };
    const inlineCenter = inlineRect.left + inlineRect.width / 2;
    const canvasCenter = mainRect.left + mainRect.width / 2;
    const inset = 24;

    const atStart = activityGeometryFor({ mainRect, inlineRect, progress: 0 });
    const atMiddle = activityGeometryFor({ mainRect, inlineRect, progress: 0.5 });
    const atFull = activityGeometryFor({ mainRect, inlineRect, progress: 1 });
    const reversed = activityGeometryFor({ mainRect, inlineRect, progress: 0.25 });

    expect(atStart).toMatchObject({ left: inlineRect.left, width: inlineRect.width, top: 0 });
    expect(atStart.left + atStart.width / 2).toBe(inlineCenter);

    expect(atMiddle).toMatchObject({ left: 327, width: 836, top: 12 });
    expect(atMiddle.left).toBeLessThan(inlineRect.left);
    expect(atMiddle.left + atMiddle.width).toBeGreaterThan(inlineRect.left + inlineRect.width);
    expect(atMiddle.left + atMiddle.width / 2).toBe((inlineCenter + canvasCenter) / 2);

    expect(atFull).toMatchObject({ left: mainRect.left + inset, width: mainRect.width - inset * 2, top: inset });
    expect(atFull.left + atFull.width).toBe(mainRect.left + mainRect.width - inset);
    expect(atFull.left + atFull.width / 2).toBe(canvasCenter);

    expect(reversed).toMatchObject({ left: 346, width: 778, top: 6 });
    expect(reversed.left + reversed.width / 2).toBe(inlineCenter + (canvasCenter - inlineCenter) * 0.25);
  });

  it("does not show checkpoint Continue for nonaccepted evaluated blocks", () => {
    const terminalMarkup = html(createElement(BlockView, { block: lesson.blocks[1]!, progress: activeBlockProgress(lesson.blocks[1]!), refresh: vi.fn() }));
    const editorMarkup = html(createElement(BlockView, { block: editorBlock, progress: activeEditorProgress({ checkpoint: { status: "feedback", feedback: "Try again.", evidence: { kind: "editor", text: "draft" } } } as any), refresh: vi.fn() }));

    expect(terminalMarkup).not.toContain("success-checkpoint");
    expect(terminalMarkup).not.toContain("Continue");
    expect(editorMarkup).not.toContain("success-checkpoint");
    expect(editorMarkup).not.toContain("Continue");
  });

  it("keeps a focused editor through feedback refreshes", async () => {
    const refresh = vi.fn();
    const container = await mount(createElement(BlockView, { block: editorBlock, progress: activeEditorProgress({ revision: 0, draftText: "" } as any), refresh }));
    const editor = container.querySelector<HTMLElement>("[role='textbox'][contenteditable='true']")!;
    editor.focus();
    expect(document.activeElement).toBe(editor);

    await act(async () => {
      mountedRoot!.render(createElement(BlockView, { block: editorBlock, progress: activeEditorProgress({ revision: 1, draftText: "draft with feedback", checkpoint: { status: "feedback", feedback: "Keep going.", evidence: { kind: "editor", text: "draft with feedback" } } } as any), refresh }));
    });

    const refreshedEditor = container.querySelector<HTMLElement>("[role='textbox'][contenteditable='true']");
    expect(refreshedEditor).not.toBeNull();
    expect(document.activeElement).toBe(refreshedEditor);
  });

  it("automatically reviews a fresh seeded editor after the quiet period and keeps focus through the refresh", async () => {
    vi.useFakeTimers();
    const seed = "seeded spec.md draft";
    const refresh = vi.fn((next: State) => {
      mountedRoot!.render(createElement(BlockView, { block: editorBlock, progress: next.progress, refresh }));
    });
    const fetchMock = vi.fn(async (_input?: RequestInfo | URL, _init?: RequestInit) => ({ ok: true, json: async () => workbookState(activeEditorProgress({ revision: 1, draftText: seed, editorStatus: "reviewing" } as any)) }));
    vi.stubGlobal("fetch", fetchMock);

    const container = await mount(createElement(BlockView, { block: editorBlock, progress: activeEditorProgress({ revision: 0, draftText: seed } as any), refresh }));
    const editor = container.querySelector<HTMLElement>("[role='textbox'][contenteditable='true']")!;
    editor.focus();
    expect(document.activeElement).toBe(editor);

    await act(async () => { vi.advanceTimersByTime(749); });
    expect(fetchMock).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))).toEqual({ blockId: "edit-answer", revision: 1, text: seed });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(container.querySelector("[role='textbox'][contenteditable='true']"));
  });

  it("does not auto-review a blank prompt.md editor", async () => {
    vi.useFakeTimers();
    const promptBlock = { ...editorBlock, id: "edit-prompt", path: "prompt.md" };
    const fetchMock = vi.fn(async (_input?: RequestInfo | URL, _init?: RequestInit) => ({ ok: true, json: async () => workbookState(activeEditorProgressFor(promptBlock, { revision: 1, draftText: "", editorStatus: "reviewing" } as any)) }));
    vi.stubGlobal("fetch", fetchMock);

    await mount(createElement(BlockView, { block: promptBlock, progress: activeEditorProgressFor(promptBlock, { revision: 0, draftText: "" } as any), refresh: vi.fn() }));
    await act(async () => { vi.advanceTimersByTime(750); });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not auto-review a ralph.sh editor that already has a submitted revision", async () => {
    vi.useFakeTimers();
    const ralphBlock = { ...editorBlock, id: "edit-ralph", path: "ralph.sh" };
    const fetchMock = vi.fn(async (_input?: RequestInfo | URL, _init?: RequestInit) => ({ ok: true, json: async () => workbookState(activeEditorProgressFor(ralphBlock, { revision: 2, draftText: "#!/usr/bin/env bash\necho ralph", editorStatus: "reviewing" } as any)) }));
    vi.stubGlobal("fetch", fetchMock);

    await mount(createElement(BlockView, { block: ralphBlock, progress: activeEditorProgressFor(ralphBlock, { revision: 1, draftText: "#!/usr/bin/env bash\necho ralph", editorStatus: "waiting" } as any), refresh: vi.fn() }));
    await act(async () => { vi.advanceTimersByTime(750); });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not reset seeded debounce or replace the focused editor when refresh callback identity changes", async () => {
    vi.useFakeTimers();
    const seed = "seeded spec.md draft";
    const firstRefresh = vi.fn();
    const secondRefresh = vi.fn();
    const fetchMock = vi.fn(async (_input?: RequestInfo | URL, _init?: RequestInit) => ({ ok: true, json: async () => workbookState(activeEditorProgress({ revision: 1, draftText: seed, editorStatus: "reviewing" } as any)) }));
    vi.stubGlobal("fetch", fetchMock);

    const container = await mount(createElement(BlockView, { block: editorBlock, progress: activeEditorProgress({ revision: 0, draftText: seed } as any), refresh: firstRefresh }));
    const editor = container.querySelector<HTMLElement>("[role='textbox'][contenteditable='true']")!;
    editor.focus();
    await act(async () => { vi.advanceTimersByTime(375); });

    await act(async () => {
      mountedRoot!.render(createElement(BlockView, { block: editorBlock, progress: activeEditorProgress({ revision: 0, draftText: seed } as any), refresh: secondRefresh }));
    });

    expect(container.querySelector("[role='textbox'][contenteditable='true']")).toBe(editor);
    expect(document.activeElement).toBe(editor);
    await act(async () => { vi.advanceTimersByTime(374); });
    expect(fetchMock).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))).toEqual({ blockId: "edit-answer", revision: 1, text: seed });
    expect(firstRefresh).not.toHaveBeenCalled();
    expect(secondRefresh).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(editor);
  });

  it("submits the latest edited text instead of the seed during the quiet period", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (_input?: RequestInfo | URL, _init?: RequestInit) => ({ ok: true, json: async () => workbookState(activeEditorProgress({ revision: 1, draftText: "latest edited draft", editorStatus: "reviewing" } as any)) }));
    vi.stubGlobal("fetch", fetchMock);
    const container = await mount(createElement(BlockView, { block: editorBlock, progress: activeEditorProgress({ revision: 0, draftText: "seeded spec.md draft" } as any), refresh: vi.fn() }));
    const editor = container.querySelector<HTMLElement>("[role='textbox'][contenteditable='true']")!;

    editor.textContent = "first edited draft";
    await act(async () => { editor.dispatchEvent(new window.Event("input", { bubbles: true })); });
    await act(async () => { vi.advanceTimersByTime(375); });
    editor.textContent = "latest edited draft";
    await act(async () => { editor.dispatchEvent(new window.Event("input", { bubbles: true })); });
    await act(async () => { vi.advanceTimersByTime(749); });
    expect(fetchMock).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))).toEqual({ blockId: "edit-answer", revision: 1, text: "latest edited draft" });
  });

  it("ignores a late seeded response after a newer edit response and keeps revisions increasing", async () => {
    vi.useFakeTimers();
    const seed = "seeded spec.md draft";
    const responses = new Map<number, ReturnType<typeof deferred<State>>>();
    const appliedRevisions: number[] = [];
    const fetchMock = vi.fn(async (_input?: RequestInfo | URL, init?: RequestInit) => {
      const revision = JSON.parse(String(init?.body)).revision as number;
      const response = deferred<State>();
      responses.set(revision, response);
      return { ok: true, json: async () => response.promise };
    });
    vi.stubGlobal("fetch", fetchMock);
    const refresh = vi.fn((next: State) => {
      const applied = next.progress.blocks.find((block) => block.id === editorBlock.id)?.revision;
      if (applied !== undefined) appliedRevisions.push(applied);
      mountedRoot!.render(createElement(BlockView, { block: editorBlock, progress: next.progress, refresh }));
    });

    const container = await mount(createElement(BlockView, { block: editorBlock, progress: activeEditorProgress({ revision: 0, draftText: seed } as any), refresh }));
    const editor = container.querySelector<HTMLElement>("[role='textbox'][contenteditable='true']")!;
    await act(async () => {
      vi.advanceTimersByTime(750);
      await Promise.resolve();
    });
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))).toEqual({ blockId: "edit-answer", revision: 1, text: seed });

    editor.textContent = "edited revision two";
    await act(async () => { editor.dispatchEvent(new window.Event("input", { bubbles: true })); });
    await act(async () => {
      vi.advanceTimersByTime(750);
      await Promise.resolve();
    });
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1]!.body))).toEqual({ blockId: "edit-answer", revision: 2, text: "edited revision two" });

    await act(async () => {
      responses.get(2)!.resolve(workbookState(activeEditorProgress({ revision: 2, draftText: "edited revision two", editorStatus: "feedback", checkpoint: { status: "feedback", feedback: "Revision 2 feedback", evidence: { kind: "editor", text: "edited revision two" } } } as any)));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(appliedRevisions).toEqual([2]);
    expect(container.textContent).toContain("Revision 2 feedback");

    await act(async () => {
      responses.get(1)!.resolve(workbookState(activeEditorProgress({ revision: 1, draftText: seed, editorStatus: "feedback", checkpoint: { status: "feedback", feedback: "Revision 1 feedback", evidence: { kind: "editor", text: seed } } } as any)));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(appliedRevisions).toEqual([2]);
    expect(container.textContent).toContain("Revision 2 feedback");
    expect(container.textContent).not.toContain("Revision 1 feedback");

    editor.textContent = "edited revision three";
    await act(async () => { editor.dispatchEvent(new window.Event("input", { bubbles: true })); });
    await act(async () => {
      vi.advanceTimersByTime(750);
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(JSON.parse(String(fetchMock.mock.calls[2]![1]!.body))).toEqual({ blockId: "edit-answer", revision: 3, text: "edited revision three" });
  });

  it("rejects an old editor response resolved after a block-switch commit but before passive effects", async () => {
    vi.useFakeTimers();
    const seed = "seeded answer draft";
    const nextBlock = { ...editorBlock, id: "edit-prompt", path: "prompt.md" };
    const oldResponse = deferred<State>();
    const order: string[] = [];
    const oldRefresh = vi.fn(() => { order.push("old refresh"); });
    const newRefresh = vi.fn(() => { order.push("new refresh"); });
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => oldResponse.promise }));
    vi.stubGlobal("fetch", fetchMock);

    await mount(createElement(EditorCommitWindowHarness, {
      block: editorBlock,
      progress: activeEditorProgress({ revision: 0, draftText: seed } as any),
      refresh: oldRefresh,
    }));
    await act(async () => {
      vi.advanceTimersByTime(750);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const layoutCommitted = deferred<void>();
    // act() flushes passive effects, which would erase the interval under test. This concurrent-root
    // render commits first; the parent layout effect then resolves both gates before passive effects.
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", false);
    mountedRoot!.render(createElement(EditorCommitWindowHarness, {
      block: nextBlock,
      progress: activeEditorProgressFor(nextBlock, { revision: 0, draftText: "" } as any),
      refresh: newRefresh,
      afterLayout: () => {
        order.push("layout");
        expect(document.querySelector("[aria-label='Editor for prompt.md']")).not.toBeNull();
        oldResponse.resolve(workbookState(activeEditorProgress({ revision: 1, draftText: seed, editorStatus: "feedback" } as any)));
        layoutCommitted.resolve();
      },
      afterPassive: () => { order.push("passive"); },
    }));
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    await layoutCommitted.promise;
    await Promise.resolve();
    await Promise.resolve();

    expect(order).toEqual(["layout"]);
    expect(oldRefresh).not.toHaveBeenCalled();
    expect(newRefresh).not.toHaveBeenCalled();
  });

  it("resets editor revision tracking when the active editor block changes", async () => {
    vi.useFakeTimers();
    const nextBlock = { ...editorBlock, id: "edit-prompt", path: "prompt.md" };
    const fetchMock = vi.fn(async (_input?: RequestInfo | URL, _init?: RequestInit) => ({ ok: true, json: async () => workbookState(activeEditorProgressFor(nextBlock, { revision: 1, draftText: "new prompt draft", editorStatus: "reviewing" } as any)) }));
    vi.stubGlobal("fetch", fetchMock);
    const container = await mount(createElement(BlockView, { block: editorBlock, progress: activeEditorProgress({ revision: 5, draftText: "old block draft", editorStatus: "waiting" } as any), refresh: vi.fn() }));

    await act(async () => {
      mountedRoot!.render(createElement(BlockView, { block: nextBlock, progress: activeEditorProgressFor(nextBlock, { revision: 0, draftText: "" } as any), refresh: vi.fn() }));
    });
    const editor = container.querySelector<HTMLElement>("[role='textbox'][contenteditable='true']")!;
    editor.textContent = "new prompt draft";
    await act(async () => {
      editor.dispatchEvent(new window.Event("input", { bubbles: true }));
      vi.advanceTimersByTime(750);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))).toEqual({ blockId: "edit-prompt", revision: 1, text: "new prompt draft" });
  });

  it("replays the seeded auto-review only once under StrictMode", async () => {
    vi.useFakeTimers();
    const seed = "seeded spec.md draft";
    const fetchMock = vi.fn(async (_input?: RequestInfo | URL, _init?: RequestInit) => ({ ok: true, json: async () => workbookState(activeEditorProgress({ revision: 1, draftText: seed, editorStatus: "reviewing" } as any)) }));
    vi.stubGlobal("fetch", fetchMock);

    await mount(createElement(StrictMode, null, createElement(BlockView, { block: editorBlock, progress: activeEditorProgress({ revision: 0, draftText: seed } as any), refresh: vi.fn() })));
    await act(async () => {
      vi.advanceTimersByTime(750);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))).toEqual({ blockId: "edit-answer", revision: 1, text: seed });
  });

  it("keeps the lesson-completion confetti canvas decorative and quiet for completed lessons present on mount", async () => {
    const container = await mount(createElement(StrictMode, null, createElement(LessonCompletionConfetti, { completedLessonIds: ["part/lesson-one"] })));

    const canvas = container.querySelector<HTMLCanvasElement>(".lesson-completion-confetti-canvas");
    expect(canvas).not.toBeNull();
    expect(canvas!.tagName).toBe("CANVAS");
    expect(canvas!.getAttribute("aria-hidden")).toBe("true");
    expect(canvas!.style.pointerEvents).toBe("none");
    expect(stylesCss).toMatch(/\.lesson-completion-confetti-canvas\s*\{[^}]*position:\s*fixed;/s);
    expect(stylesCss).toMatch(/\.lesson-completion-confetti-canvas\s*\{[^}]*inset:\s*0;/s);
    expect(confettiMock.create).toHaveBeenCalled();
    expect(confettiMock.create.mock.calls.at(-1)![0]).toBe(canvas);
    expect(confettiMock.create.mock.calls.at(-1)![1]).toMatchObject({ resize: true, disableForReducedMotion: true });
    expect(confettiMock.cannon).not.toHaveBeenCalled();
  });

  it("fires one symmetric lower-corner burst for each newly completed lesson only once", async () => {
    await mount(createElement(LessonCompletionConfetti, { completedLessonIds: [] }));
    expect(confettiMock.cannon).not.toHaveBeenCalled();

    await act(async () => { mountedRoot!.render(createElement(LessonCompletionConfetti, { completedLessonIds: ["part/lesson-one"] })); });
    expect(confettiMock.cannon).toHaveBeenCalledTimes(2);
    const firstLessonBurst = confettiMock.cannon.mock.calls.map(([options]) => options);
    expect(firstLessonBurst).toEqual([
      expect.objectContaining({ angle: 58, origin: { x: 0, y: 1 }, disableForReducedMotion: true }),
      expect.objectContaining({ angle: 122, origin: { x: 1, y: 1 }, disableForReducedMotion: true }),
    ]);
    expect(firstLessonBurst.every((options) => !("colors" in options!))).toBe(true);

    await act(async () => { mountedRoot!.render(createElement(LessonCompletionConfetti, { completedLessonIds: ["part/lesson-one"] })); });
    expect(confettiMock.cannon).toHaveBeenCalledTimes(2);

    await act(async () => { mountedRoot!.render(createElement(LessonCompletionConfetti, { completedLessonIds: ["part/lesson-one", "part/lesson-two"] })); });
    expect(confettiMock.cannon).toHaveBeenCalledTimes(4);
    expect(confettiMock.cannon.mock.calls.slice(2).map(([options]) => options)).toEqual([
      expect.objectContaining({ angle: 58, origin: { x: 0, y: 1 }, disableForReducedMotion: true }),
      expect.objectContaining({ angle: 122, origin: { x: 1, y: 1 }, disableForReducedMotion: true }),
    ]);

    await act(async () => { mountedRoot!.render(createElement(LessonCompletionConfetti, { completedLessonIds: ["part/lesson-one", "part/lesson-two"] })); });
    expect(confettiMock.cannon).toHaveBeenCalledTimes(4);

    expect(confettiMock.reset).not.toHaveBeenCalled();
    await act(async () => { mountedRoot!.unmount(); });
    mountedRoot = undefined;
    expect(confettiMock.reset).toHaveBeenCalledTimes(1);
  });

  it("does not fire confetti for ordinary accepted block state", async () => {
    const acceptedProgress: Progress = {
      ...progress,
      activeBlockId: "practice",
      blocks: progress.blocks.map((block) => ({
        ...block,
        active: block.id === "practice",
        ready: block.id === "practice",
        emerged: block.id === "practice" ? true : block.emerged,
        terminal: block.id === "practice" ? { phase: "complete", message: "Accepted." } : block.terminal,
      })),
    };
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => workbookState(acceptedProgress) })));

    await mount(createElement(App), stubAppShellGlobals);
    await act(async () => { await Promise.resolve(); });

    expect(confettiMock.cannon).not.toHaveBeenCalled();
  });

  it("debounces editor-practice edits and posts only the latest text at the next revision", async () => {
    vi.useFakeTimers();
    const refresh = vi.fn();
    const fetchMock = vi.fn(async (_input?: RequestInfo | URL, _init?: RequestInit) => ({ ok: true, json: async () => workbookState(activeEditorProgress({ revision: 1, editorStatus: "reviewing" } as any)) }));
    vi.stubGlobal("fetch", fetchMock);
    const container = await mount(createElement(BlockView, { block: editorBlock, progress: activeEditorProgress({ revision: 0 }), refresh }));
    const editor = container.querySelector<HTMLElement>("[role='textbox'][contenteditable='true']");

    expect(editor).not.toBeNull();
    editor!.textContent = "first draft";
    await act(async () => { editor!.dispatchEvent(new window.Event("input", { bubbles: true })); });
    await act(async () => { vi.advanceTimersByTime(375); });
    editor!.textContent = "second draft";
    await act(async () => { editor!.dispatchEvent(new window.Event("input", { bubbles: true })); });
    await act(async () => { vi.advanceTimersByTime(749); });
    expect(fetchMock).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe("api/workbook/editor");
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ method: "POST", headers: { "Content-Type": "application/json" } });
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))).toEqual({ blockId: "edit-answer", revision: 1, text: "second draft" });
  });

  it("ignores stale editor POST responses when an older request resolves after a newer one", async () => {
    vi.useFakeTimers();
    const refresh = vi.fn();
    const first = deferred<Response>();
    const second = deferred<Response>();
    const fetchMock = vi.fn((_input?: RequestInfo | URL, _init?: RequestInit) => fetchMock.mock.calls.length === 1 ? first.promise : second.promise);
    vi.stubGlobal("fetch", fetchMock);
    const container = await mount(createElement(BlockView, { block: editorBlock, progress: activeEditorProgress({ revision: 0, draftText: "" } as any), refresh }));
    const editor = container.querySelector<HTMLElement>("[role='textbox'][contenteditable='true']")!;

    editor.textContent = "first draft";
    await act(async () => { editor.dispatchEvent(new window.Event("input", { bubbles: true })); vi.advanceTimersByTime(750); await Promise.resolve(); });
    editor.textContent = "second draft";
    await act(async () => { editor.dispatchEvent(new window.Event("input", { bubbles: true })); vi.advanceTimersByTime(750); await Promise.resolve(); });
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))).toMatchObject({ revision: 1, text: "first draft" });
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1]!.body))).toMatchObject({ revision: 2, text: "second draft" });

    await act(async () => {
      second.resolve({ ok: true, json: async () => workbookState(activeEditorProgress({ revision: 2, editorStatus: "feedback", checkpoint: { status: "feedback", feedback: "New feedback.", evidence: { kind: "editor", text: "second draft" } } } as any)) } as Response);
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      first.resolve({ ok: true, json: async () => workbookState(activeEditorProgress({ revision: 1, editorStatus: "feedback", checkpoint: { status: "feedback", feedback: "Old feedback.", evidence: { kind: "editor", text: "first draft" } } } as any)) } as Response);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(refresh).toHaveBeenCalledTimes(1);
    const refreshedEditorBlock = (refresh.mock.calls[0]![0] as State).progress.blocks.find((candidate) => candidate.id === "edit-answer");
    expect(refreshedEditorBlock?.checkpoint?.feedback).toBe("New feedback.");
  });

  it("ignores an in-flight editor response after a local edit before the next debounce fires", async () => {
    vi.useFakeTimers();
    const refresh = vi.fn();
    const first = deferred<Response>();
    const second = deferred<Response>();
    const fetchMock = vi.fn((_input?: RequestInfo | URL, _init?: RequestInit) => fetchMock.mock.calls.length === 1 ? first.promise : second.promise);
    vi.stubGlobal("fetch", fetchMock);
    const container = await mount(createElement(BlockView, { block: editorBlock, progress: activeEditorProgress({ revision: 0, draftText: "" } as any), refresh }));
    const editor = container.querySelector<HTMLElement>("[role='textbox'][contenteditable='true']")!;

    editor.textContent = "submitted draft";
    await act(async () => { editor.dispatchEvent(new window.Event("input", { bubbles: true })); vi.advanceTimersByTime(750); await Promise.resolve(); });
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))).toMatchObject({ revision: 1, text: "submitted draft" });

    editor.textContent = "unsent newer draft";
    await act(async () => { editor.dispatchEvent(new window.Event("input", { bubbles: true })); vi.advanceTimersByTime(749); await Promise.resolve(); });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      first.resolve({ ok: true, json: async () => workbookState(activeEditorProgress({ revision: 1, editorStatus: "unlocked", completed: true, checkpoint: { status: "accepted", successMessage: "Old draft accepted.", evidence: { kind: "editor", text: "submitted draft" } } } as any)) } as Response);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(refresh).not.toHaveBeenCalled();
    expect(container.querySelector("[role='textbox'][contenteditable='true']")).toBe(editor);
    expect(editor.textContent).toBe("unsent newer draft");

    await act(async () => { vi.advanceTimersByTime(1); await Promise.resolve(); });
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1]!.body))).toMatchObject({ revision: 2, text: "unsent newer draft" });
    await act(async () => {
      second.resolve({ ok: true, json: async () => workbookState(activeEditorProgress({ revision: 2, editorStatus: "feedback", checkpoint: { status: "feedback", feedback: "Review of newer draft.", evidence: { kind: "editor", text: "unsent newer draft" } } } as any)) } as Response);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    const refreshedEditorBlock = (refresh.mock.calls[0]![0] as State).progress.blocks.find((candidate) => candidate.id === "edit-answer");
    expect(refreshedEditorBlock?.revision).toBe(2);
    expect(refreshedEditorBlock?.checkpoint?.feedback).toBe("Review of newer draft.");
  });

  it("retains previous editor feedback with a retry status when a resubmission transport fails", async () => {
    vi.useFakeTimers();
    const refresh = vi.fn();
    const fetchMock = vi.fn(async () => { throw new Error("Network unavailable."); });
    vi.stubGlobal("fetch", fetchMock);
    const container = await mount(createElement(BlockView, {
      block: editorBlock,
      progress: activeEditorProgress({ revision: 1, draftText: "first draft", editorStatus: "feedback", checkpoint: { status: "feedback", feedback: "Old actionable feedback.", evidence: { kind: "editor", text: "first draft" } } } as any),
      refresh
    }));
    const editor = container.querySelector<HTMLElement>("[role='textbox'][contenteditable='true']")!;

    editor.textContent = "second draft";
    await act(async () => { editor.dispatchEvent(new window.Event("input", { bubbles: true })); vi.advanceTimersByTime(750); await Promise.resolve(); await Promise.resolve(); });

    const failureBar = container.querySelector(".practice-feedback-bar.is-failure")!;
    expect(failureBar.textContent).toContain("Old actionable feedback.");
    expect(failureBar.textContent).toContain("Network unavailable.");
    expect(failureBar.textContent).toContain("retry");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("preserves editor focus, cursor, and local draft while refreshed state arrives", async () => {
    const refresh = vi.fn();
    const container = await mount(createElement(BlockView, { block: editorBlock, progress: activeEditorProgress({ revision: 0, draftText: "" } as any), refresh }));
    const editor = container.querySelector<HTMLElement>("[role='textbox'][contenteditable='true']")!;
    editor.textContent = "local unsent draft";
    editor.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.setStart(editor.firstChild ?? editor, "local ".length);
    range.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(range);
    expect(document.activeElement).toBe(editor);

    await act(async () => {
      mountedRoot!.render(createElement(BlockView, { block: editorBlock, progress: activeEditorProgress({ revision: 1, draftText: "server draft", editorStatus: "waiting" } as any), refresh }));
    });

    const refreshedEditor = container.querySelector<HTMLElement>("[role='textbox'][contenteditable='true']")!;
    expect(refreshedEditor).toBe(editor);
    expect(document.activeElement).toBe(refreshedEditor);
    expect(refreshedEditor.textContent).toBe("local unsent draft");
    expect(window.getSelection()?.anchorOffset).toBe("local ".length);
  });

  it("continues submitting after a refreshed draft without recreating the editor", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (_input?: RequestInfo | URL, _init?: RequestInit) => ({ ok: true, json: async () => workbookState(activeEditorProgress({ revision: 1, draftText: "first draft", editorStatus: "waiting" } as any)) }));
    vi.stubGlobal("fetch", fetchMock);
    const refresh = vi.fn();
    const container = await mount(createElement(BlockView, { block: editorBlock, progress: activeEditorProgress({ revision: 0, draftText: "" } as any), refresh }));

    await act(async () => {
      mountedRoot!.render(createElement(BlockView, { block: editorBlock, progress: activeEditorProgress({ revision: 1, draftText: "first draft", editorStatus: "waiting" } as any), refresh }));
    });
    const editor = container.querySelector<HTMLElement>("[role='textbox'][contenteditable='true']");
    editor!.textContent = "second draft";
    await act(async () => {
      editor!.dispatchEvent(new window.Event("input", { bubbles: true }));
      vi.advanceTimersByTime(750);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))).toEqual({ blockId: "edit-answer", revision: 2, text: "second draft" });
  });

  it("keeps editor review UI passive while SSE owns asynchronous state refresh", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (_input?: RequestInfo | URL, _init?: RequestInit) => ({ ok: true, json: async () => workbookState(activeEditorProgress({ revision: 1, editorStatus: "reviewing" } as any)) }));
    vi.stubGlobal("fetch", fetchMock);

    const container = await mount(createElement(BlockView, { block: editorBlock, progress: activeEditorProgress({ revision: 1, editorStatus: "reviewing" } as any), refresh: vi.fn() }));
    expect(container.textContent).toContain("Reviewing your latest revision…");
    expect(vi.getTimerCount()).toBe(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
      await Promise.resolve();
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("renders live practice feedback Mermaid as copyable code rather than a diagram", () => {
    const diagram = "```mermaid\ngraph TD\n  A --> B\n```";
    const feedbackMarkup = html(createElement(BlockView, {
      block: { ...lesson.blocks[1]!, markdown: diagram },
      progress: activeBlockProgress(lesson.blocks[1]!, { terminal: { phase: "feedback", message: diagram } } as any),
      refresh: vi.fn()
    }));

    expect(feedbackMarkup).not.toContain('class="mermaid-diagram"');
    expect(feedbackMarkup).toContain('class="code-block"');
    expect(feedbackMarkup).toContain('aria-label="Copy code"');
  });

  it("keeps the embedded terminal as the only terminal path and extracts only authored command fences", () => {
    const activeTerminalProgress = { ...progress, activeBlockId: "practice", blocks: progress.blocks.map((block) => ({ ...block, active: block.id === "practice", ready: true, emerged: true })) };
    const withCommand = html(createElement(BlockView, { block: lesson.blocks[1]!, progress: activeTerminalProgress, refresh: vi.fn() }));
    expect(withCommand).toContain("terminal-connection-status");
    expect(withCommand).not.toContain("Use your own terminal");
    expect(withCommand).not.toContain("fallback");
    expect(withCommand).not.toContain("Insert command");

    const scriptSnippetBlock = { ...lesson.blocks[1]!, markdown: "Create this script:\n\n```sh\n#!/usr/bin/env bash\necho script body\n```" };
    const withSnippet = html(createElement(BlockView, { block: scriptSnippetBlock, progress: activeTerminalProgress, refresh: vi.fn() }));
    expect(withSnippet).toContain("terminal-connection-status");

    const clueOnlyBlock = { ...lesson.blocks[1]!, markdown: "Try the command you just edited, then compare its output." };
    const withoutCommand = html(createElement(BlockView, { block: clueOnlyBlock, progress: activeTerminalProgress, refresh: vi.fn() }));
    expect(withoutCommand).toContain("terminal-connection-status");
  });

  it("uses the shared welded practice feedback bar for terminal running, checking, feedback, and success states", () => {
    const terminalBlock = lesson.blocks[1]!;
    const runningMarkup = html(createElement(BlockView, { block: terminalBlock, progress: activeBlockProgress(terminalBlock, { terminal: { phase: "running" } } as any), refresh: vi.fn() }));
    expect(runningMarkup).toContain("practice-feedback-bar is-status is-busy");
    expect(runningMarkup).toContain("practice-feedback-spinner");
    expect(runningMarkup).toContain("Running…");
    expect(runningMarkup).not.toContain("terminal-running-spinner");

    const checkingMarkup = html(createElement(BlockView, { block: terminalBlock, progress: activeBlockProgress(terminalBlock, { terminal: { phase: "checking" } } as any), refresh: vi.fn() }));
    expect(checkingMarkup).toContain("practice-feedback-bar is-status is-busy");
    expect(checkingMarkup).toContain("Checking…");

    const feedbackMarkup = html(createElement(BlockView, { block: terminalBlock, progress: activeBlockProgress(terminalBlock, { terminal: { phase: "feedback", message: "Fix the command and run it again." } } as any), refresh: vi.fn() }));
    expect(feedbackMarkup).toContain("practice-feedback-bar is-feedback");
    expect(feedbackMarkup).toContain("Fix the command and run it again.");
    expect(feedbackMarkup).not.toContain("Retry review");

    const successMarkup = html(createElement(TerminalHistory, {
      state: activeBlockProgress(terminalBlock, { terminal: { phase: "complete", message: "Terminal accepted." }, terminalSnapshot: { transcript: "$ npm test\nPASS" } } as any).blocks[0]
    }));
    expect(successMarkup).toContain("terminal-completion-surface");
    expect(successMarkup).toContain("practice-feedback-bar is-success");
    expect(successMarkup).toContain("Terminal accepted.");
  });

  it("welds the shared practice feedback bar to editor, terminal, and narrow activity layouts in CSS", () => {
    expect(stylesCss).toContain(".practice-feedback-bar");
    expect(stylesCss).toContain(".terminal-live-surface.has-feedback .embedded-terminal-panel");
    expect(stylesCss).toContain("border-bottom: 0");
    expect(stylesCss).toContain("border-radius: 9px 9px 0 0");
    expect(stylesCss).toContain(".editor-live-surface.has-feedback .editor-surface");
    expect(stylesCss).toContain(".terminal-live-surface .practice-feedback-bar");
    expect(stylesCss).toContain("width: 100%");
    expect(stylesCss).toContain("@media (prefers-reduced-motion: reduce)");
    expect(stylesCss).toContain(".practice-feedback-spinner");
    expect(stylesCss).not.toContain("terminal-feedback-overlay::before");
    expect(stylesCss).not.toContain("width: fit-content; max-width: min(620px");
    expect(stylesCss).not.toContain("margin: 12px 0 12px auto");
  });

  it("renders terminal feedback as Markdown for inline code and fenced shell blocks", () => {
    const terminalProgress = activeBlockProgress(lesson.blocks[1]!, {
      terminal: { phase: "feedback", message: "Run `npm test` again.\n\n```sh\nnpm test -- --runInBand\n```" }
    } as any);
    const markup = html(createElement(BlockView, { block: lesson.blocks[1]!, progress: terminalProgress, refresh: vi.fn() }));

    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain('class="markdown"');
    expect(markup).toContain("<code>npm test</code>");
    expect(markup).toContain('class="code-block');
    expect(markup).toContain("language-sh");
    expect(markup).toContain("-- --runInBand");
    expect(markup).not.toContain("```sh");
    expect(markup).not.toContain("`npm test`");
  });

  it("renders no part grouping in the rail when chapters have no part", () => {
    const chapters: Chapter[] = [
      { id: "001-first-lesson", title: "First", lessonNumber: 1, lesson: { ...lesson, id: "001-first-lesson", title: "First" } } as any,
      { id: "002-second-lesson", title: "Second", lessonNumber: 2, lesson: { ...lesson, id: "002-second-lesson", title: "Second" } } as any,
    ];

    const markup = html(createElement(LessonRail, {
      title: "Flat Workbook",
      chapters,
      progress: { ...progress, activeLessonId: "001-first-lesson" },
      viewedLessonId: "001-first-lesson",
      setViewedLesson: vi.fn(),
    }));

    expect(markup).toContain("Lesson 1: First");
    expect(markup).toContain("Lesson 2: Second");
    expect(markup).not.toContain("part-name");
  });

  it("marks completed, current, visible, and unavailable lessons in the rail", () => {
    const chapters: Chapter[] = [
      { id: "part/lesson-one", title: "Lesson One", part: "Part One", partMarkdown: "", partNumber: 1, lessonNumber: 1, lesson },
      { id: "part/lesson-two", title: "Lesson Two", part: "Part One", partMarkdown: "", partNumber: 1, lessonNumber: 2, lesson: { ...lesson, id: "part/lesson-two", title: "Lesson Two" } },
      { id: "part/lesson-three", title: "Lesson Three", part: "Part One", partMarkdown: "", partNumber: 1, lessonNumber: 3 },
    ];
    const railProgress = { ...progress, activeLessonId: "part/lesson-two", completedLessons: ["part/lesson-one"] };
    const markup = html(createElement(LessonRail, { title: "Workbook", chapters, progress: railProgress, viewedLessonId: "part/lesson-two", setViewedLesson: vi.fn() }));

    expect(markup).toContain("Lesson One");
    expect(markup).toContain("lesson-row done");
    expect(markup).toContain("lesson-row current");
    expect(markup).toContain("Lesson Three");
    expect(markup).toContain("aria-disabled=\"true\"");
  });

  it("labels the rail rows with global lesson numbers across parts", () => {
    const chapterOne = chapter({ id: "part-one/lesson-one", part: "Part One", partNumber: 1, lessonNumber: 1 });
    const secondLesson = { ...lesson, id: "part-two/lesson-one", title: "Second Lesson" };
    const chapterTwo = chapter({ id: secondLesson.id, part: "Part Two", partNumber: 2, lessonNumber: 2, title: secondLesson.title, lesson: secondLesson });
    const chapters: Chapter[] = [chapterOne, chapterTwo];
    const railProgress = { ...progress, activeLessonId: chapterOne.id };
    const railMarkup = html(createElement(LessonRail, { title: "Workbook", chapters, progress: railProgress, viewedLessonId: chapterOne.id, setViewedLesson: vi.fn() }));

    // Exact rail labels, not a bare "Lesson 1" substring: that would also
    // match "Lesson 10: ...", silently accepting a wrong global number.
    expect(railMarkup).toContain(">Lesson 1: Markdown Lesson</a>");
    expect(railMarkup).toContain(">Lesson 2: Second Lesson</a>");
    expect(railMarkup).not.toMatch(/Lesson 1\d/);
  });

  it("renders each part preamble once even when a part has multiple lessons", async () => {
    const partALessonOne = { ...lesson, id: "part-a/lesson-one", title: "Part A Lesson One" };
    const partALessonTwo = { ...lesson, id: "part-a/lesson-two", title: "Part A Lesson Two" };
    const partBLessonOne = { ...lesson, id: "part-b/lesson-one", title: "Part B Lesson One" };
    const chapters: Chapter[] = [
      { id: partALessonOne.id, title: partALessonOne.title, part: "Part A", partId: "part-a", partMarkdown: "Part A copy.", partNumber: 1, lessonNumber: 1, lesson: partALessonOne },
      { id: partALessonTwo.id, title: partALessonTwo.title, part: "Part A", partId: "part-a", partMarkdown: "Part A copy.", partNumber: 1, lessonNumber: 2, lesson: partALessonTwo },
      { id: partBLessonOne.id, title: partBLessonOne.title, part: "Part B", partId: "part-b", partMarkdown: "Part B copy.", partNumber: 2, lessonNumber: 3, lesson: partBLessonOne },
    ];
    const appProgress: Progress = { ...progress, activeLessonId: partALessonOne.id, completedLessons: [] };
    // A part opens the thread once and its lessons follow it, so two lessons in one part still
    // produce a single part preamble row.
    const timeline = [
      { type: "message", id: "part-a", sequence: 1, at: "2026-08-21T00:00:01.000Z", lessonId: "workbook:part:part-a", blockId: "part--part-a", role: "assistant", source: "authored", presentation: "course", text: "# Part A\n\nPart A copy." },
      { type: "message", id: "part-a-lesson-one", sequence: 2, at: "2026-08-21T00:00:02.000Z", lessonId: partALessonOne.id, blockId: `lesson--${partALessonOne.id}`, role: "assistant", source: "authored", presentation: "course", text: "# Part A Lesson One\n\nDek paragraph." },
      { type: "message", id: "part-a-lesson-two", sequence: 3, at: "2026-08-21T00:00:03.000Z", lessonId: partALessonTwo.id, blockId: `lesson--${partALessonTwo.id}`, role: "assistant", source: "authored", presentation: "course", text: "# Part A Lesson Two\n\nDek paragraph." },
      { type: "message", id: "part-b", sequence: 4, at: "2026-08-21T00:00:04.000Z", lessonId: "workbook:part:part-b", blockId: "part--part-b", role: "assistant", source: "authored", presentation: "course", text: "# Part B\n\nPart B copy." },
      { type: "message", id: "part-b-lesson-one", sequence: 5, at: "2026-08-21T00:00:05.000Z", lessonId: partBLessonOne.id, blockId: `lesson--${partBLessonOne.id}`, role: "assistant", source: "authored", presentation: "course", text: "# Part B Lesson One\n\nDek paragraph." },
    ];
    const state = { workbook: { title: "Workbook" }, introduction: "Intro.", introductionComplete: true, chapters, progress: appProgress, adapter: {}, timeline };
    const fetchMock = vi.fn(async (_input?: RequestInfo | URL, _init?: RequestInit) => ({ ok: true, json: async () => state }));
    vi.stubGlobal("fetch", fetchMock);

    const container = await mount(createElement(App), stubAppShellGlobals);

    const occurrences = (text: string) => container.textContent!.split(text).length - 1;
    expect(container.querySelectorAll(".timeline-part-transition")).toHaveLength(2);
    expect(occurrences("Part A copy.")).toBe(1);
    expect(occurrences("Part B copy.")).toBe(1);
  });

  it("links rail lesson outlines to lesson-scoped safe block DOM ids", () => {
    const unsafeLesson = { ...lesson, id: "part two/lesson#two", blocks: [{ ...lesson.blocks[0]!, id: "repeat block?" }] };
    const chapters: Chapter[] = [{ id: unsafeLesson.id, title: "Unsafe", part: "Part Two", partMarkdown: "", partNumber: 2, lessonNumber: 1, lesson: unsafeLesson }];
    const railProgress = { ...progress, activeLessonId: unsafeLesson.id, activeBlockId: "repeat block?", blocks: [{ id: "repeat block?", type: "narrative", ready: true, active: true, completed: false, verified: false, emerged: true }] };
    const railMarkup = html(createElement(LessonRail, { title: "Workbook", chapters, progress: railProgress, viewedLessonId: unsafeLesson.id, setViewedLesson: vi.fn() }));

    expect(railMarkup).toContain('href="#lesson-part-two-lesson-two"');
    expect(railMarkup).toContain('href="#lesson-part-two-lesson-two-block-repeat-block-"');
    expect(railMarkup).not.toContain('href="#repeat block?"');
  });

  it("completes only the active predecessor when the ready successor crosses the reading line", async () => {
    let observerCallback: ((entries: any[]) => void) | undefined;
    class FakeIntersectionObserver {
      observe = vi.fn();
      disconnect = vi.fn();
      constructor(callback: (entries: any[]) => void) { observerCallback = callback; }
    }
    const initialState = {
      workbook: { title: "Workbook" },
      introduction: "Intro.",
      introductionComplete: false,
      chapters: [{ id: "001-first", title: "First", part: "Part One", partId: "validation-loop", partMarkdown: "Part copy.", lessonNumber: 1 }],
      progress: {
        activeLessonId: "001-first",
        activeBlockId: "workbook--introduction",
        activeAnchorId: "workbook--introduction",
        completedLessons: [],
        completedBlocks: [],
        workAcceptedBlocks: ["workbook--introduction"],
        readyBlocks: ["part--validation-loop"],
        blocks: [
          { id: "workbook--introduction", type: "workbook-introduction", ready: false, active: true, completed: false, verified: false, emerged: true, workAccepted: true },
          { id: "part--validation-loop", type: "part-preamble", ready: true, active: false, completed: false, verified: false, emerged: true },
        ],
        reflections: {},
        reflectionConversations: {},
        canComplete: { blockId: "workbook--introduction", eligible: true },
      },
      adapter: {},
      revealedBlockIds: ["workbook--introduction"],
      renderedBlockIds: ["workbook--introduction", "part--validation-loop"],
      readyBlockIds: ["part--validation-loop"],
      timeline: [
        { type: "message", id: "intro", sequence: 1, at: "2026-08-21T00:00:00.000Z", lessonId: "workbook--introduction", blockId: "workbook--introduction", role: "assistant", source: "authored", presentation: "course", text: "# Workbook\n\nIntro copy." },
        { type: "message", id: "part", sequence: 2, at: "2026-08-21T00:00:01.000Z", lessonId: "part--validation-loop", blockId: "part--validation-loop", role: "assistant", source: "authored", presentation: "course", text: "# Part One\n\nPart copy." },
      ],
    } as any;
    const completedState = {
      ...initialState,
      introductionComplete: true,
      progress: {
        ...initialState.progress,
        activeBlockId: "part--validation-loop",
        activeAnchorId: "part--validation-loop",
        completedBlocks: ["workbook--introduction"],
        readyBlocks: [],
        blocks: initialState.progress.blocks.map((block: any) => block.id === "workbook--introduction" ? { ...block, active: false, completed: true } : { ...block, active: true, ready: false, workAccepted: true }),
      },
      revealedBlockIds: ["workbook--introduction", "part--validation-loop"],
      readyBlockIds: [],
    } as any;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => ({ ok: true, json: async () => init?.method === "POST" ? completedState : initialState }));
    const pushState = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver as any);

    await mount(createElement(App), (win) => { stubAppShellGlobals(win); vi.stubGlobal("history", { pushState, replaceState: vi.fn() }); });
    await act(async () => { await Promise.resolve(); });

    expect(observerCallback).toBeTruthy();
    await act(async () => {
      observerCallback?.([{ isIntersecting: true, boundingClientRect: { top: 100 } }]);
      observerCallback?.([{ isIntersecting: true, boundingClientRect: { top: 80 } }]);
      await Promise.resolve();
      await Promise.resolve();
    });

    const completionCalls = fetchMock.mock.calls.filter(([url, init]) => url === "api/workbook/complete-block" && (init as RequestInit | undefined)?.method === "POST");
    expect(completionCalls).toHaveLength(1);
    expect(JSON.parse((completionCalls[0]![1] as RequestInit).body as string)).toEqual({ blockId: "workbook--introduction" });
    expect(pushState).not.toHaveBeenCalled();
  });

  it("replaces the URL without adding history when scrolling promotes a ready successor", async () => {
    vi.useFakeTimers();
    const initialState = {
      workbook: { title: "Workbook" },
      introduction: "Intro.",
      introductionComplete: false,
      chapters: [{ id: "001-first", title: "First", part: "Part One", partId: "validation-loop", partMarkdown: "Part copy.", lessonNumber: 1 }],
      progress: {
        activeLessonId: "001-first",
        activeBlockId: "workbook--introduction",
        activeAnchorId: "workbook--introduction",
        completedLessons: [],
        completedBlocks: [],
        workAcceptedBlocks: ["workbook--introduction"],
        readyBlocks: ["part--validation-loop"],
        blocks: [
          { id: "workbook--introduction", type: "workbook-introduction", ready: false, active: true, completed: false, verified: false, emerged: true, workAccepted: true },
          { id: "part--validation-loop", type: "part-preamble", ready: true, active: false, completed: false, verified: false, emerged: true },
        ],
        reflections: {},
        reflectionConversations: {},
        canComplete: { blockId: "workbook--introduction", eligible: true },
      },
      adapter: {},
      revealedBlockIds: ["workbook--introduction"],
      renderedBlockIds: ["workbook--introduction", "part--validation-loop"],
      readyBlockIds: ["part--validation-loop"],
      timeline: [
        { type: "message", id: "intro", sequence: 1, at: "2026-08-21T00:00:00.000Z", lessonId: "workbook--introduction", blockId: "workbook--introduction", role: "assistant", source: "authored", presentation: "course", text: "# Workbook\n\nIntro copy." },
        { type: "message", id: "part", sequence: 2, at: "2026-08-21T00:00:01.000Z", lessonId: "part--validation-loop", blockId: "part--validation-loop", role: "assistant", source: "authored", presentation: "course", text: "# Part One\n\nPart copy." },
      ],
    } as any;
    const completedState = {
      ...initialState,
      introductionComplete: true,
      progress: {
        ...initialState.progress,
        activeBlockId: "part--validation-loop",
        activeAnchorId: "part--validation-loop",
        completedBlocks: ["workbook--introduction"],
        readyBlocks: [],
        blocks: initialState.progress.blocks.map((block: any) => block.id === "workbook--introduction" ? { ...block, active: false, completed: true } : { ...block, active: true, ready: false, workAccepted: true }),
      },
      revealedBlockIds: ["workbook--introduction", "part--validation-loop"],
      readyBlockIds: [],
    } as any;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => ({ ok: true, json: async () => init?.method === "POST" ? { outcome: "completed", state: completedState, navigationTarget: "part--validation-loop" } : initialState }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("IntersectionObserver", class { observe = vi.fn(); disconnect = vi.fn(); } as any);
    const scrollIntoView = vi.fn();

    const container = await mount(createElement(App), (win) => {
      stubAppShellGlobals(win);
      win.HTMLElement.prototype.scrollIntoView = scrollIntoView;
      win.history.replaceState(null, "", "#workbook--introduction");
      const replaceState = vi.spyOn(win.history, "replaceState");
      const pushState = vi.spyOn(win.history, "pushState");
      vi.stubGlobal("location", win.location);
      vi.stubGlobal("history", win.history);
      replaceState.mockClear();
      pushState.mockClear();
    });
    await act(async () => {
      await Promise.resolve();
      vi.advanceTimersByTime(20);
    });
    scrollIntoView.mockClear();

    const introElement = container.querySelector<HTMLElement>("#workbook--introduction")!;
    introElement.getBoundingClientRect = () => ({ top: 0, bottom: 200, left: 0, right: 800, width: 800, height: 200, x: 0, y: 0, toJSON: () => ({}) });
    const readyElement = container.querySelector<HTMLElement>("#part--validation-loop")!;
    readyElement.getBoundingClientRect = () => ({ top: 100, bottom: 300, left: 0, right: 800, width: 800, height: 200, x: 0, y: 100, toJSON: () => ({}) });

    await act(async () => {
      window.dispatchEvent(new window.Event("scroll"));
      await Promise.resolve();
      await Promise.resolve();
      vi.advanceTimersByTime(150);
    });

    expect(history.replaceState).toHaveBeenCalledWith(null, "", "#part--validation-loop");
    expect(location.hash).toBe("#part--validation-loop");
    expect(history.pushState).not.toHaveBeenCalled();
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("preserves continuation break and ready runway across passive scroll promotion without scroll compensation", async () => {
    const { initialState, completedState } = scrollPromotionFixture();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => ({ ok: true, json: async () => init?.method === "POST" ? { outcome: "completed", state: completedState, navigationTarget: "part--validation-loop" } : initialState }));
    const scrollBy = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("IntersectionObserver", class { observe = vi.fn(); disconnect = vi.fn(); } as any);

    const container = await mount(createElement(App), (win) => {
      stubAppShellGlobals(win);
      vi.stubGlobal("history", { pushState: vi.fn(), replaceState: vi.fn() });
      win.scrollBy = scrollBy as any;
    });
    await act(async () => { await Promise.resolve(); });

    const introSection = container.querySelector<HTMLElement>("#workbook--introduction")!;
    const continueButton = introSection.querySelector<HTMLButtonElement>(".continuation-controls > button")!;
    const pageBreak = introSection.querySelector<HTMLElement>(".continuation-page-break")!;
    const tutorChat = introSection.querySelector<HTMLElement>(".timeline-message.tutor")!;
    expect(pageBreak).toBeTruthy();
    expect(container.querySelector("#part--validation-loop .ready-successor-scroll-runway")).toBeTruthy();
    expect(continueButton.textContent).toBe("Continue to Part One");
    expect(tutorChat.textContent).toContain("Tutor chat before continuing.");
    expect(tutorChat.compareDocumentPosition(continueButton) & window.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(continueButton.nextElementSibling).toBe(pageBreak);
    expect(container.querySelector(".composer-contextual-continuation button")).toBeNull();

    const readyElement = container.querySelector<HTMLElement>("#part--validation-loop")!;
    readyElement.getBoundingClientRect = () => ({ top: 100, bottom: 300, left: 0, right: 800, width: 800, height: 200, x: 0, y: 100, toJSON: () => ({}) });

    await act(async () => {
      window.dispatchEvent(new window.Event("scroll"));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchMock.mock.calls.filter(([url, init]) => url === "api/workbook/complete-block" && (init as RequestInit | undefined)?.method === "POST")).toHaveLength(1);
    expect(container.querySelector("#workbook--introduction .continuation-page-break")).toBeTruthy();
    expect(container.querySelector("#workbook--introduction button")).toBeNull();
    expect(container.querySelector("#part--validation-loop .ready-successor-scroll-runway")).toBeTruthy();
    expect(container.querySelector(".composer-contextual-continuation button")).toBeNull();
    expect(scrollBy).not.toHaveBeenCalled();
  });

  it("derives the scroll runway from server state alone across a block's ready-to-active life", () => {
    const { initialState, completedState } = scrollPromotionFixture();
    // While the introduction's work is accepted, the runway belongs to the ready successor.
    expect(scrollRunwayBlockIds(initialState)).toEqual(["part--validation-loop"]);
    // The successor keeps it once the learner continues into it and it leaves readyBlockIds.
    expect(scrollRunwayBlockIds(completedState)).toEqual(["part--validation-loop"]);
    // A block whose predecessor was never work-accepted was never a ready successor.
    const unaccepted = { ...completedState, progress: { ...completedState.progress, workAcceptedBlocks: [], blocks: completedState.progress.blocks.map((block: any) => ({ ...block, workAccepted: false })) } };
    expect(scrollRunwayBlockIds(unaccepted)).toEqual([]);
    // Once its own work is accepted the next block is ready, and only that one carries the runway.
    const nextReady = { ...completedState, readyBlockIds: ["lesson--001-first"], progress: { ...completedState.progress, readyBlocks: ["lesson--001-first"] } };
    expect(scrollRunwayBlockIds(nextReady)).toEqual(["lesson--001-first"]);
    // A finished workbook has nothing left to scroll towards.
    expect(scrollRunwayBlockIds({ ...completedState, progress: { ...completedState.progress, workbookComplete: true } })).toEqual([]);
  });

  it("renders the ready runway for a promoted block on a fresh load, with no memory of an earlier render", async () => {
    const { completedState } = scrollPromotionFixture();
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => completedState }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("IntersectionObserver", class { observe = vi.fn(); disconnect = vi.fn(); } as any);

    const container = await mount(createElement(App), (win) => {
      stubAppShellGlobals(win);
      vi.stubGlobal("history", { pushState: vi.fn(), replaceState: vi.fn() });
    });
    await act(async () => { await Promise.resolve(); });

    expect(container.querySelector("#part--validation-loop .ready-successor-scroll-runway")).toBeTruthy();
    expect(container.querySelectorAll(".ready-successor-scroll-runway")).toHaveLength(1);
  });

  it("keeps the ready runway across promotion while StrictMode double-invokes the render", async () => {
    const { initialState, completedState } = scrollPromotionFixture();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => ({ ok: true, json: async () => init?.method === "POST" ? { outcome: "completed", state: completedState, navigationTarget: "part--validation-loop" } : initialState }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("IntersectionObserver", class { observe = vi.fn(); disconnect = vi.fn(); } as any);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 1; });

    const container = await mount(createElement(StrictMode, null, createElement(App)), (win) => {
      stubAppShellGlobals(win);
      win.HTMLElement.prototype.scrollIntoView = () => {};
      vi.stubGlobal("history", { pushState: vi.fn(), replaceState: vi.fn() });
    });
    await act(async () => { await Promise.resolve(); });

    expect(container.querySelector("#part--validation-loop .ready-successor-scroll-runway")).toBeTruthy();

    const continueButton = container.querySelector<HTMLButtonElement>("#workbook--introduction .continuation-controls > button")!;
    await act(async () => {
      continueButton.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelector("#part--validation-loop .ready-successor-scroll-runway")).toBeTruthy();
    expect(container.querySelectorAll(".ready-successor-scroll-runway")).toHaveLength(1);
  });

  it("keeps explicit Continue in the document canvas after tutor chat and uses the normal navigation path", async () => {
    const { initialState, completedState } = scrollPromotionFixture();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => ({ ok: true, json: async () => init?.method === "POST" ? { outcome: "completed", state: completedState, navigationTarget: "part--validation-loop" } : initialState }));
    const scrollIntoView = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("IntersectionObserver", class { observe = vi.fn(); disconnect = vi.fn(); } as any);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 1; });

    const container = await mount(createElement(App), (win) => {
      stubAppShellGlobals(win);
      win.HTMLElement.prototype.scrollIntoView = scrollIntoView;
      vi.stubGlobal("history", { pushState: vi.fn(), replaceState: vi.fn() });
    });
    await act(async () => { await Promise.resolve(); });
    scrollIntoView.mockClear();

    const introSection = container.querySelector<HTMLElement>("#workbook--introduction")!;
    const continueButton = introSection.querySelector<HTMLButtonElement>(".continuation-controls > button")!;
    const pageBreak = introSection.querySelector<HTMLElement>(".continuation-page-break")!;
    const tutorChat = introSection.querySelector<HTMLElement>(".timeline-message.tutor")!;
    expect(continueButton.textContent).toBe("Continue to Part One");
    expect(tutorChat.compareDocumentPosition(continueButton) & window.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(continueButton.nextElementSibling).toBe(pageBreak);
    expect(container.querySelector(".composer-contextual-continuation button")).toBeNull();

    await act(async () => {
      continueButton.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    const completionCalls = fetchMock.mock.calls.filter(([url, init]) => url === "api/workbook/complete-block" && (init as RequestInit | undefined)?.method === "POST");
    expect(completionCalls).toHaveLength(1);
    expect(JSON.parse((completionCalls[0]![1] as RequestInit).body as string)).toEqual({ blockId: "workbook--introduction" });
    expect(scrollIntoView).toHaveBeenCalled();
    expect(container.querySelector("#workbook--introduction button")).toBeNull();
  });

  it("completes a ready successor that first enters below the reading line and later crosses on scroll", async () => {
    let observerCallback: ((entries: any[]) => void) | undefined;
    class FakeIntersectionObserver {
      observe = vi.fn();
      disconnect = vi.fn();
      constructor(callback: (entries: any[]) => void) { observerCallback = callback; }
    }
    const initialState = {
      workbook: { title: "Workbook" },
      introduction: "Intro.",
      introductionComplete: false,
      chapters: [{ id: "001-first", title: "First", part: "Part One", partId: "validation-loop", partMarkdown: "Part copy.", lessonNumber: 1 }],
      progress: {
        activeLessonId: "001-first",
        activeBlockId: "workbook--introduction",
        activeAnchorId: "workbook--introduction",
        completedLessons: [],
        completedBlocks: [],
        workAcceptedBlocks: ["workbook--introduction"],
        readyBlocks: ["part--validation-loop"],
        blocks: [
          { id: "workbook--introduction", type: "workbook-introduction", ready: false, active: true, completed: false, verified: false, emerged: true, workAccepted: true },
          { id: "part--validation-loop", type: "part-preamble", ready: true, active: false, completed: false, verified: false, emerged: true },
        ],
        reflections: {},
        reflectionConversations: {},
        canComplete: { blockId: "workbook--introduction", eligible: true },
      },
      adapter: {},
      revealedBlockIds: ["workbook--introduction"],
      renderedBlockIds: ["workbook--introduction", "part--validation-loop"],
      readyBlockIds: ["part--validation-loop"],
      timeline: [
        { type: "message", id: "intro", sequence: 1, at: "2026-08-21T00:00:00.000Z", lessonId: "workbook--introduction", blockId: "workbook--introduction", role: "assistant", source: "authored", presentation: "course", text: "# Workbook\n\nIntro copy." },
        { type: "message", id: "part", sequence: 2, at: "2026-08-21T00:00:01.000Z", lessonId: "part--validation-loop", blockId: "part--validation-loop", role: "assistant", source: "authored", presentation: "course", text: "# Part One\n\nPart copy." },
      ],
    } as any;
    const completedState = {
      ...initialState,
      introductionComplete: true,
      progress: {
        ...initialState.progress,
        activeBlockId: "part--validation-loop",
        activeAnchorId: "part--validation-loop",
        completedBlocks: ["workbook--introduction"],
        readyBlocks: [],
        blocks: initialState.progress.blocks.map((block: any) => block.id === "workbook--introduction" ? { ...block, active: false, completed: true } : { ...block, active: true, ready: false, workAccepted: true }),
      },
      revealedBlockIds: ["workbook--introduction", "part--validation-loop"],
      readyBlockIds: [],
    } as any;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => ({ ok: true, json: async () => init?.method === "POST" ? completedState : initialState }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver as any);

    const container = await mount(createElement(App), stubAppShellGlobals);
    await act(async () => { await Promise.resolve(); });

    const readyElement = container.querySelector<HTMLElement>("#part--validation-loop")!;
    expect(readyElement).toBeTruthy();
    expect(readyElement.querySelector(".ready-successor-scroll-runway")).toBeTruthy();
    let readyTop = 240;
    readyElement.getBoundingClientRect = () => ({ top: readyTop, bottom: readyTop + 200, left: 0, right: 800, width: 800, height: 200, x: 0, y: readyTop, toJSON: () => ({}) });

    await act(async () => {
      observerCallback?.([{ isIntersecting: true, boundingClientRect: { top: readyTop } }]);
      await Promise.resolve();
    });
    expect(fetchMock.mock.calls.filter(([url, init]) => url === "api/workbook/complete-block" && (init as RequestInit | undefined)?.method === "POST")).toHaveLength(0);

    readyTop = 100;
    await act(async () => {
      window.dispatchEvent(new window.Event("scroll"));
      await Promise.resolve();
      await Promise.resolve();
    });

    const completionCalls = fetchMock.mock.calls.filter(([url, init]) => url === "api/workbook/complete-block" && (init as RequestInit | undefined)?.method === "POST");
    expect(completionCalls).toHaveLength(1);
    expect(JSON.parse((completionCalls[0]![1] as RequestInit).body as string)).toEqual({ blockId: "workbook--introduction" });
  });

  it("shows the current lesson's full outline while disabling ready and future blocks", () => {
    const currentLesson = { ...lesson, id: "001-first", blocks: lesson.blocks };
    const chapters: Chapter[] = [{ id: "001-first", title: "First", part: "Part One", partMarkdown: "Part copy.", partNumber: 1, lessonNumber: 1, lesson: { ...currentLesson, blocks: currentLesson.blocks.slice(0, 2) } } as any];
    const outlineProgress: Progress = {
      ...progress,
      activeLessonId: "001-first",
      activeBlockId: "lesson--001-first--practice",
      completedBlocks: ["lesson--001-first--orientation"],
      readyBlocks: ["lesson--001-first--reflect"],
      blocks: [
        { id: "lesson--001-first--orientation", type: "narrative", ready: false, active: false, completed: true, verified: false, emerged: true },
        { id: "lesson--001-first--practice", type: "terminal-practice", ready: false, active: true, completed: false, verified: false, emerged: true },
        { id: "lesson--001-first--reflect", type: "reflection", ready: true, active: false, completed: false, verified: false, emerged: true },
        { id: "lesson--001-first--transition", type: "narrative", ready: false, active: false, completed: false, verified: false, emerged: false },
      ] as any,
    };
    const orderedBlocks = currentLesson.blocks.map((block) => ({ id: `lesson--001-first--${block.id}`, anchorId: `lesson--001-first--${block.id}`, title: block.title, origin: "declared", kind: block.type, lessonId: "001-first", declaredId: block.id }));

    const markup = html(createElement(LessonRail, { title: "Workbook", chapters, progress: outlineProgress, viewedLessonId: "001-first", setViewedLesson: vi.fn(), orderedBlocks }));

    expect(markup).toContain("Orientation");
    expect(markup).toContain("Practice");
    expect(markup).toContain("Reflect");
    expect(markup).toContain("Next");
    expect(markup).toContain('href="#lesson--001-first--orientation"');
    expect(markup).toContain('href="#lesson--001-first--practice"');
    expect(markup).not.toContain('href="#lesson--001-first--reflect"');
    expect(markup).not.toContain('href="#lesson--001-first--transition"');
    expect(markup.match(/aria-disabled="true"/g)).toHaveLength(2);
  });

  it("labels explicit timeline Continue buttons with their successor destination", async () => {
    const state = {
      workbook: { title: "Workbook" },
      introduction: "Intro.",
      introductionComplete: true,
      chapters: [chapter({ id: "001-first", lessonNumber: 1, title: "First", lesson: { ...lesson, id: "001-first" } })],
      progress: {
        ...progress,
        activeLessonId: "001-first",
        activeBlockId: "part--validation-loop",
        activeAnchorId: "part--validation-loop",
        canComplete: { blockId: "part--validation-loop", eligible: true },
        blocks: [{ id: "part--validation-loop", type: "part-preamble", ready: false, active: true, completed: false, verified: false, emerged: true, workAccepted: true }],
      },
      adapter: {},
      orderedBlocks: [
        { id: "workbook--introduction", anchorId: "workbook--introduction", title: "Workbook", origin: "structural", kind: "workbook-introduction", lessonId: "workbook--introduction" },
        { id: "part--validation-loop", anchorId: "part--validation-loop", title: "Validation loop", origin: "structural", kind: "part-preamble", lessonId: "001-first" },
        { id: "lesson--001-first", anchorId: "lesson--001-first", title: "First", origin: "structural", kind: "lesson-preamble", lessonId: "001-first" },
        { id: "lesson--001-first--orientation", anchorId: "lesson--001-first--orientation", title: "Orientation", origin: "declared", kind: "narrative", lessonId: "001-first", declaredId: "orientation" },
      ],
      timeline: [{ type: "message", id: "part", sequence: 1, at: "2026-08-21T00:00:00.000Z", lessonId: "001-first", blockId: "part--validation-loop", role: "assistant", source: "authored", presentation: "course", text: "# Validation loop\n\nPart copy." }],
    } as any;
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => state })));

    const container = await mount(createElement(App), stubAppShellGlobals);
    await act(async () => { await Promise.resolve(); });

    expect([...container.querySelectorAll("button")].map((button) => button.textContent)).toContain("Continue to lesson 1");
  });

  it("keeps a ready successor out of sidebar navigation and direct-link access", async () => {
    const chapters: Chapter[] = [{ id: "001-first", title: "First", part: "Part One", partId: "validation-loop", partMarkdown: "Part copy.", partNumber: 1, lessonNumber: 1 } as any];
    const readyProgress: Progress = {
      activeLessonId: "001-first",
      activeBlockId: "workbook--introduction",
      activeAnchorId: "workbook--introduction",
      completedLessons: [],
      completedBlocks: [],
      blocks: [
        { id: "workbook--introduction", type: "workbook-introduction", ready: false, active: true, completed: false, verified: false, emerged: true },
        { id: "part--validation-loop", type: "part-preamble", ready: true, active: false, completed: false, verified: false, emerged: true },
      ],
      reflections: {},
      reflectionConversations: {},
    };
    const railMarkup = html(createElement(LessonRail, { title: "Workbook", chapters, progress: readyProgress, viewedLessonId: "001-first", setViewedLesson: vi.fn() }));
    expect(railMarkup).toContain('<p class="part-name">Part One</p>');
    expect(railMarkup).not.toContain('href="#part--validation-loop"');

    const state = { workbook: { title: "Workbook" }, introduction: "Intro.", introductionComplete: false, chapters, progress: readyProgress, adapter: {}, revealedBlockIds: ["workbook--introduction"], renderedBlockIds: ["workbook--introduction", "part--validation-loop"], timeline: [] } as any;
    const fetchMock = vi.fn(async (_input?: RequestInfo | URL, _init?: RequestInit) => ({ ok: true, json: async () => state }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 1; });
    const container = await mount(createElement(App), (win) => {
      stubAppShellGlobals(win);
      win.history.replaceState(null, "", "#part--validation-loop");
      vi.stubGlobal("location", win.location);
      vi.stubGlobal("history", win.history);
    });
    await act(async () => { await Promise.resolve(); });
    expect(container.textContent).not.toContain("The lesson you're linking to is not ready yet");
  });

  it("renders the unopened introduction through the timeline with a composer and durable intro target", async () => {
    const state = {
      workbook: { title: "Workbook" },
      introduction: "Intro should not render as a standalone section.",
      introductionComplete: false,
      chapters: [chapter({ lesson: undefined } as any)],
      progress,
      adapter: {},
      timeline: [{ type: "message", id: "intro", sequence: 1, at: "2026-08-21T00:00:00.000Z", lessonId: "workbook--introduction", blockId: "workbook--introduction", role: "assistant", source: "authored", presentation: "course", text: "# Workbook\n\nTimeline intro copy." }]
    } as any;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => ({ ok: true, json: async () => state }));
    vi.stubGlobal("fetch", fetchMock);

    const container = await mount(createElement(App), stubAppShellGlobals);
    await act(async () => { await Promise.resolve(); });

    expect(container.querySelector(".workbook-intro")).toBeNull();
    expect(container.querySelector(".current-activity-band")).toBeNull();
    expect(container.textContent).toContain("Timeline intro copy.");
    expect(container.textContent).not.toContain("Intro should not render as a standalone section.");
    expect(container.querySelector("textarea[name='message']")?.getAttribute("aria-label")).toBe("Message the tutor");

    const textarea = container.querySelector<HTMLTextAreaElement>("textarea[name='message']")!;
    textarea.value = "Can I ask first?";
    await act(async () => { textarea.dispatchEvent(new window.Event("input", { bubbles: true })); });
    const sendButton = container.querySelector<HTMLButtonElement>("button[aria-label='Send message']")!;
    await act(async () => { sendButton.dispatchEvent(new window.MouseEvent("click", { bubbles: true })); });
    const messageCall = fetchMock.mock.calls.find(([url]) => url === "api/workbook/messages");
    expect(messageCall).toBeTruthy();
    expect(JSON.parse((messageCall![1] as RequestInit).body as string)).toEqual({ blockId: "workbook--introduction", text: "Can I ask first?" });

    const continueButton = [...container.querySelectorAll("button")].find((button) => button.textContent === "Ready to continue")!;
    await act(async () => { continueButton.dispatchEvent(new window.MouseEvent("click", { bubbles: true })); });
    expect(fetchMock.mock.calls.some(([url, init]) => url === "api/workbook/complete-block" && (init as RequestInit | undefined)?.method === "POST")).toBe(true);
  });

  it("renders conversational intro, part, lesson frame, and block content only in the timeline", async () => {
    const conversationalLesson = { ...lesson, dek: "TIMELINE_ONLY_DEK", introduction: "TIMELINE_ONLY_LESSON_INTRO", outcomes: ["TIMELINE_ONLY_OUTCOME"], blocks: [{ ...lesson.blocks[0]!, markdown: "Block body duplicated only if document blocks render." }] };
    const state = {
      workbook: { title: "Workbook" },
      introduction: "TIMELINE_ONLY_INTRO",
      introductionComplete: true,
      chapters: [chapter({ partMarkdown: "TIMELINE_ONLY_PART_COPY", lesson: conversationalLesson })],
      progress,
      adapter: {},
      timeline: [
        { type: "message", id: "intro", sequence: 1, at: "2026-08-21T00:00:00.000Z", lessonId: "workbook--introduction", blockId: "workbook--introduction", role: "assistant", source: "authored", presentation: "course", text: "# Workbook\n\nTIMELINE_ONLY_INTRO" },
        { type: "message", id: "part", sequence: 2, at: "2026-08-21T00:00:01.000Z", lessonId: "workbook:part:part-one", blockId: "__part__", role: "assistant", source: "authored", presentation: "course", text: "# Part One\n\nTIMELINE_ONLY_PART_COPY" },
        { type: "message", id: "frame", sequence: 3, at: "2026-08-21T00:00:02.000Z", lessonId: lesson.id, blockId: "__lesson_frame__", role: "assistant", source: "authored", presentation: "course", text: "# Markdown Lesson\n\nTIMELINE_ONLY_DEK\n\n## What you will learn\n\n- TIMELINE_ONLY_OUTCOME\n\nTIMELINE_ONLY_LESSON_INTRO" },
        { type: "message", id: "block", sequence: 4, at: "2026-08-21T00:00:03.000Z", lessonId: lesson.id, blockId: "orientation", role: "assistant", source: "authored", presentation: "course", text: "## Orientation\n\nBlock body duplicated only if document blocks render." },
      ]
    } as any;
    const fetchMock = vi.fn(async (_input?: RequestInfo | URL, _init?: RequestInit) => ({ ok: true, json: async () => state }));
    vi.stubGlobal("fetch", fetchMock);

    const container = await mount(createElement(App), stubAppShellGlobals);
    await act(async () => { await Promise.resolve(); });

    const text = container.textContent ?? "";
    expect(container.querySelector(".workbook-intro")).toBeNull();
    expect(container.querySelector(".part-chapter")).toBeNull();
    expect(container.querySelector(".opening")).toBeNull();
    expect(container.querySelector(".lesson-introduction")).toBeNull();
    expect(text.match(/TIMELINE_ONLY_INTRO/g)).toHaveLength(1);
    expect(text.match(/TIMELINE_ONLY_PART_COPY/g)).toHaveLength(1);
    expect(text.match(/TIMELINE_ONLY_DEK/g)).toHaveLength(1);
    expect(text.match(/TIMELINE_ONLY_OUTCOME/g)).toHaveLength(1);
    expect(text.match(/TIMELINE_ONLY_LESSON_INTRO/g)).toHaveLength(1);
    expect(text.match(/Block body duplicated only if document blocks render\./g)).toHaveLength(1);
  });

  it("renders the active narrative timeline note with a manual Continue in the canvas", async () => {
    const state = {
      workbook: { title: "Workbook" },
      introduction: "Intro.",
      introductionComplete: true,
      chapters: [chapter()],
      progress,
      adapter: {},
      timeline: [
        { type: "message", id: "course", sequence: 1, at: "2026-08-21T00:00:00.000Z", lessonId: lesson.id, blockId: "orientation", role: "assistant", source: "authored", presentation: "course", text: "## Orientation\n\nAuthored Orientation note." },
        { type: "message", id: "tutor-chat", sequence: 2, at: "2026-08-21T00:00:01.000Z", lessonId: lesson.id, blockId: "orientation", role: "assistant", source: "main_tutor", presentation: "chat", text: "Tutor chat before the learner continues." },
      ]
    } as any;
    const continuedState = { ...state, progress: { ...progress, blocks: progress.blocks.map((block) => block.id === "orientation" ? { ...block, completed: true } : block) } };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => ({ ok: true, json: async () => init?.method === "POST" ? continuedState : state }));
    vi.stubGlobal("fetch", fetchMock);

    const container = await mount(createElement(App), stubAppShellGlobals);
    await act(async () => { await Promise.resolve(); });

    const text = container.textContent ?? "";
    expect(text).toContain("Authored Orientation note.");
    expect(text.indexOf("Authored Orientation note.")).toBeLessThan(text.indexOf("Continue"));
    expect(text).not.toContain("Message the tutor");

    const orientation = container.querySelector<HTMLElement>("#orientation")!;
    const continueButton = orientation.querySelector<HTMLButtonElement>(".continuation-controls > button")!;
    const composerDock = container.querySelector(".timeline-composer-dock.fixed-composer")!;
    const tutorChat = orientation.querySelector<HTMLElement>(".timeline-message.tutor")!;
    const pageBreak = orientation.querySelector<HTMLElement>(".continuation-page-break")!;
    expect(composerDock.contains(continueButton)).toBe(false);
    expect(tutorChat.textContent).toContain("Tutor chat before the learner continues.");
    expect(tutorChat.compareDocumentPosition(continueButton) & window.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(continueButton.nextElementSibling).toBe(pageBreak);
    expect(container.querySelector(".composer-contextual-continuation button")).toBeNull();
    expect(container.querySelector("textarea[name='message']")?.getAttribute("aria-label")).toBe("Message the tutor");
    await act(async () => { continueButton.dispatchEvent(new window.MouseEvent("click", { bubbles: true })); });

    const eventCall = fetchMock.mock.calls.find(([url]) => url === "api/workbook/complete-block");
    expect(eventCall).toBeTruthy();
    expect(JSON.parse((eventCall![1] as RequestInit).body as string)).toEqual({ blockId: "orientation" });
  });

  it("keeps navigation but omits standalone part and lesson framing in timeline mode", async () => {
    const state = {
      workbook: { title: "Workbook" },
      introduction: "Intro.",
      introductionComplete: true,
      chapters: [chapter()],
      progress,
      adapter: {},
      timeline: [{ type: "message", id: "course", sequence: 1, at: "2026-08-21T00:00:00.000Z", lessonId: lesson.id, blockId: "orientation", role: "assistant", source: "authored", presentation: "course", text: "## Orientation\n\nAuthored Orientation note." }]
    } as any;
    const fetchMock = vi.fn(async (_input?: RequestInfo | URL, _init?: RequestInit) => ({ ok: true, json: async () => state }));
    vi.stubGlobal("fetch", fetchMock);

    const container = await mount(createElement(App), stubAppShellGlobals);
    await act(async () => { await Promise.resolve(); });

    expect(container.querySelector(".part-chapter")).toBeNull();
    expect(container.querySelector("article.chapter header")).toBeNull();
    expect(container.querySelector(".rail")?.textContent).toContain("Part One");
    expect(container.querySelector(".rail")?.textContent).toContain("Lesson 1: Markdown Lesson");
    expect(container.textContent).toContain("Authored Orientation note.");
    expect(container.textContent).not.toContain("Part copy.");
  });

  it("does not repeat the part card for a later lesson in the same part in timeline mode", async () => {
    const secondLesson = { ...lesson, id: "part/lesson-two", title: "Second Lesson" };
    const secondProgress: Progress = { ...progress, activeLessonId: secondLesson.id, completedLessons: [lesson.id] };
    const state = {
      workbook: { title: "Workbook" },
      introduction: "Intro.",
      introductionComplete: true,
      chapters: [
        chapter(),
        chapter({ id: secondLesson.id, lessonNumber: 2, title: secondLesson.title, lesson: secondLesson }),
      ],
      progress: secondProgress,
      adapter: {},
      timeline: [{ type: "message", id: "course", sequence: 1, at: "2026-08-21T00:00:00.000Z", lessonId: secondLesson.id, blockId: "orientation", role: "assistant", source: "authored", presentation: "course", text: "## Orientation\n\nSecond lesson note." }]
    } as any;
    const fetchMock = vi.fn(async (_input?: RequestInfo | URL, _init?: RequestInit) => ({ ok: true, json: async () => state }));
    vi.stubGlobal("fetch", fetchMock);

    const container = await mount(createElement(App), stubAppShellGlobals);
    await act(async () => { await Promise.resolve(); });

    expect(container.querySelectorAll(".part-chapter")).toHaveLength(0);
    expect(container.textContent).not.toContain("Part copy.");
  });

  it("places timeline Continue only after the active lesson note when a completed lesson reused the block id", async () => {
    const priorLesson = { ...lesson, id: "part/lesson-one", title: "Completed Lesson" };
    const activeLesson = { ...lesson, id: "part/lesson-two", title: "Active Duplicate Lesson" };
    const activeProgress: Progress = {
      ...progress,
      activeLessonId: activeLesson.id,
      activeBlockId: "orientation",
      completedLessons: [priorLesson.id],
      blocks: [
        { id: "orientation", type: "narrative", ready: true, active: true, completed: false, verified: false, emerged: true },
        { id: "practice", type: "terminal-practice", ready: false, active: false, completed: false, verified: false, emerged: false },
        { id: "transition", type: "narrative", ready: false, active: false, completed: false, verified: false, emerged: false },
      ],
    };
    const state = {
      workbook: { title: "Workbook" },
      introduction: "Intro.",
      introductionComplete: true,
      chapters: [
        chapter({ id: priorLesson.id, lessonNumber: 1, title: priorLesson.title, lesson: priorLesson }),
        chapter({ id: activeLesson.id, lessonNumber: 2, title: activeLesson.title, lesson: activeLesson }),
      ],
      progress: activeProgress,
      adapter: {},
      timeline: [
        { type: "message", id: "old-course", sequence: 1, at: "2026-08-21T00:00:00.000Z", lessonId: priorLesson.id, blockId: "orientation", role: "assistant", source: "authored", presentation: "course", text: "## Orientation\n\nOld completed orientation note." },
        { type: "message", id: "active-course", sequence: 2, at: "2026-08-21T00:00:01.000Z", lessonId: activeLesson.id, blockId: "orientation", role: "assistant", source: "authored", presentation: "course", text: "## Orientation\n\nActive lesson orientation note." },
      ],
    } as any;
    const continuedState = {
      ...state,
      progress: {
        ...activeProgress,
        activeBlockId: "transition",
        blocks: activeProgress.blocks.map((block) => block.id === "orientation" ? { ...block, active: false, completed: true } : { ...block, active: block.id === "transition", ready: block.id === "transition", emerged: block.id === "transition" }),
      },
    };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => ({ ok: true, json: async () => init?.method === "POST" ? continuedState : state }));
    vi.stubGlobal("fetch", fetchMock);

    const container = await mount(createElement(App), stubAppShellGlobals);
    await act(async () => { await Promise.resolve(); });

    const text = container.textContent ?? "";
    expect(text.indexOf("Old completed orientation note.")).toBeLessThan(text.indexOf("Active lesson orientation note."));
    expect(text.indexOf("Active lesson orientation note.")).toBeLessThan(text.indexOf("Continue"));
    expect(container.querySelectorAll(".continuation-controls")).toHaveLength(1);

    const continueButton = [...container.querySelectorAll("button")].find((button) => button.textContent === "Continue")!;
    await act(async () => { continueButton.dispatchEvent(new window.MouseEvent("click", { bubbles: true })); });

    const eventCall = fetchMock.mock.calls.find(([url]) => url === "api/workbook/complete-block");
    expect(eventCall).toBeTruthy();
    expect(JSON.parse((eventCall![1] as RequestInit).body as string)).toEqual({ blockId: "orientation" });
    expect(container.textContent).toContain("Next");
  });

  it("keeps a ready terminal canvas under its authored record and enables that same session on promotion", async () => {
    class FakeWebSocket {
      static CONNECTING = 0; static OPEN = 1; static CLOSED = 3;
      static instances: FakeWebSocket[] = [];
      readyState = FakeWebSocket.CONNECTING;
      sent: string[] = [];
      private listeners = new Map<string, Array<(event: any) => void>>();
      constructor(_url: string) { FakeWebSocket.instances.push(this); }
      addEventListener(type: string, listener: (event: any) => void) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
      send(message: string) { this.sent.push(message); }
      close() { this.readyState = FakeWebSocket.CLOSED; this.emit("close"); }
      emit(type: string, event: any = {}) { for (const listener of this.listeners.get(type) ?? []) listener(event); }
    }
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const terminalBlock = lesson.blocks[1]!;
    const preloaded: Progress = {
      ...progress,
      activeBlockId: "orientation",
      blocks: [
        { id: "orientation", type: "narrative", ready: false, active: true, completed: false, verified: false, emerged: true, workAccepted: true },
        { id: "practice", type: "terminal-practice", ready: true, active: false, completed: false, verified: false, emerged: true },
      ],
      readyBlocks: ["practice"],
    };
    const promoted: Progress = {
      ...preloaded,
      activeBlockId: "practice",
      blocks: preloaded.blocks.map((block) => block.id === "orientation" ? { ...block, active: false, completed: true } : { ...block, ready: false, active: true }),
      readyBlocks: [],
    };
    const insertion = vi.fn();
    const records = [
      { type: "message", id: "orientation", sequence: 1, at: "2026-08-21T00:00:00.000Z", lessonId: lesson.id, blockId: "orientation", role: "assistant", source: "authored", presentation: "course", text: "## Orientation" },
      { type: "message", id: "practice", sequence: 2, at: "2026-08-21T00:00:01.000Z", lessonId: lesson.id, blockId: "practice", role: "assistant", source: "authored", presentation: "course", text: "## Practice" },
    ] as const;
    const render = (current: Progress) => createElement(TimelineThread, {
      records,
      activeLessonId: lesson.id,
      activeBlockId: current.activeBlockId,
      onSend: vi.fn(async () => undefined),
      practiceSurfaceBlockId: terminalBlock.id,
      practiceSurface: createElement(ActivityBand, { lessonId: lesson.id, activeBlock: terminalBlock, progress: current, refresh: vi.fn(), onTerminalInsertionChange: insertion }),
    });

    const container = await mount(render(preloaded), (win) => {
      vi.stubGlobal("location", win.location);
      vi.stubGlobal("addEventListener", win.addEventListener.bind(win) as any);
      vi.stubGlobal("removeEventListener", win.removeEventListener.bind(win) as any);
    });
    const socket = FakeWebSocket.instances[0]!;
    await act(async () => { socket.readyState = FakeWebSocket.OPEN; socket.emit("open"); });

    const readyRecord = container.querySelector<HTMLElement>("#practice")!;
    const orientationRecord = container.querySelector<HTMLElement>("#orientation")!;
    const readyBand = readyRecord.querySelector<HTMLElement>(".current-activity-band")!;
    const canvas = readyBand.querySelector<HTMLElement>(".embedded-terminal")!;
    expect(readyBand.getAttribute("data-activity-preloaded")).toBe("true");
    expect(orientationRecord.contains(readyBand)).toBe(false);
    expect(canvas.getAttribute("aria-disabled")).toBe("true");
    expect(canvas.hasAttribute("inert")).toBe(true);
    expect(terminalInstances).toHaveLength(1);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(insertion.mock.calls.every(([, callback]) => callback === undefined)).toBe(true);

    await act(async () => { terminalDataListeners[0]!("echo bypass\\r"); });
    expect(socket.sent.map((message) => JSON.parse(message))).toEqual([{ type: "resize", cols: 80, rows: 24 }]);

    await act(async () => { mountedRoot!.render(render(promoted)); });
    const promotedCanvas = container.querySelector<HTMLElement>("#practice .embedded-terminal")!;
    expect(promotedCanvas).toBe(canvas);
    expect(container.querySelectorAll(".current-activity-band")).toHaveLength(1);
    expect(terminalInstances).toHaveLength(1);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(terminalInstances[0]!.options.disableStdin).toBe(false);
    expect(promotedCanvas.hasAttribute("inert")).toBe(false);
    expect(promotedCanvas.getAttribute("aria-disabled")).toBeNull();
    expect(insertion.mock.calls.at(-1)?.[1]).toEqual(expect.any(Function));

    await act(async () => { terminalDataListeners[0]!("echo active\\r"); });
    expect(socket.sent.map((message) => JSON.parse(message)).at(-1)).toEqual({ type: "input", data: "echo active\\r" });
  });

  it("refits the embedded terminal only when its proposed grid changes", async () => {
    class FakeWebSocket {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSED = 3;
      static instances: FakeWebSocket[] = [];
      readyState = FakeWebSocket.CONNECTING;
      sent: string[] = [];
      private listeners = new Map<string, Array<(event: any) => void>>();
      constructor(_url: string) { FakeWebSocket.instances.push(this); }
      addEventListener(type: string, listener: (event: any) => void) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
      send(message: string) { this.sent.push(message); }
      close() { this.readyState = FakeWebSocket.CLOSED; this.emit("close"); }
      emit(type: string, event: any = {}) { for (const listener of this.listeners.get(type) ?? []) listener(event); }
    }
    class FakeResizeObserver {
      static instances: FakeResizeObserver[] = [];
      observed: Element[] = [];
      disconnected = false;
      constructor(private callback: ResizeObserverCallback) { FakeResizeObserver.instances.push(this); }
      observe(element: Element) { this.observed.push(element); }
      disconnect() { this.disconnected = true; }
      trigger() { this.callback([], this as unknown as ResizeObserver); }
    }
    vi.stubGlobal("WebSocket", FakeWebSocket);

    const container = await mount(createElement(BlockView, { block: lesson.blocks[1]!, progress: activeBlockProgress(lesson.blocks[1]!), refresh: vi.fn() }), (win) => {
      vi.stubGlobal("location", win.location);
      vi.stubGlobal("addEventListener", win.addEventListener.bind(win) as any);
      vi.stubGlobal("removeEventListener", win.removeEventListener.bind(win) as any);
      Object.defineProperty(win, "ResizeObserver", { value: FakeResizeObserver, configurable: true });
    });

    const terminalNode = container.querySelector(".embedded-terminal")!;
    expect(FakeResizeObserver.instances).toHaveLength(1);
    expect(FakeResizeObserver.instances[0]!.observed).toContain(terminalNode);
    expect(terminalFitCalls).toHaveLength(1);

    const socket = FakeWebSocket.instances[0]!;
    await act(async () => { socket.readyState = FakeWebSocket.OPEN; socket.emit("open"); });
    expect(terminalFitCalls).toHaveLength(1);
    expect(socket.sent.map((message) => JSON.parse(message))).toEqual([{ type: "resize", cols: 80, rows: 24 }]);

    await act(async () => { FakeResizeObserver.instances[0]!.trigger(); });
    expect(terminalFitCalls).toHaveLength(1);
    expect(socket.sent).toHaveLength(1);

    await act(async () => { window.dispatchEvent(new window.Event("resize")); });
    expect(terminalFitCalls).toHaveLength(1);
    expect(socket.sent).toHaveLength(1);

    terminalProposedDimensions = { cols: 100, rows: 30 };
    await act(async () => { FakeResizeObserver.instances[0]!.trigger(); });
    expect(terminalFitCalls).toHaveLength(2);
    expect(socket.sent.map((message) => JSON.parse(message))).toEqual([
      { type: "resize", cols: 80, rows: 24 },
      { type: "resize", cols: 100, rows: 30 },
    ]);

    terminalProposedDimensions = undefined;
    await act(async () => { window.dispatchEvent(new window.Event("resize")); });
    expect(terminalFitCalls).toHaveLength(2);
    expect(socket.sent).toHaveLength(2);

    await act(async () => { mountedRoot!.unmount(); });
    mountedRoot = undefined;
    expect(FakeResizeObserver.instances[0]!.disconnected).toBe(true);
  });

  it("inserts an authored terminal command without Enter and removes the action when the socket closes", async () => {
    class FakeWebSocket {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;
      static instances: FakeWebSocket[] = [];
      readyState = FakeWebSocket.CONNECTING;
      sent: string[] = [];
      private listeners = new Map<string, Array<(event: any) => void>>();
      constructor(_url: string) { FakeWebSocket.instances.push(this); }
      addEventListener(type: string, listener: (event: any) => void) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
      send(message: string) { this.sent.push(message); }
      close() { this.readyState = FakeWebSocket.CLOSED; this.emit("close"); }
      emit(type: string, event: any = {}) { for (const listener of this.listeners.get(type) ?? []) listener(event); }
    }
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const terminalProgress = activeBlockProgress(lesson.blocks[1]!);
    const state = {
      workbook: { title: "Workbook" },
      introduction: "Intro.",
      introductionComplete: true,
      chapters: [chapter()],
      progress: terminalProgress,
      adapter: {},
      timeline: [{ type: "message", id: "course", sequence: 1, at: "2026-08-21T00:00:00.000Z", lessonId: lesson.id, blockId: "practice", role: "assistant", source: "authored", presentation: "course", text: "## Practice\n\nRun the authored command." }]
    } as any;
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => state })));

    const container = await mount(createElement(App), (win) => { stubAppShellGlobals(win); vi.stubGlobal("location", win.location); });
    await act(async () => { await Promise.resolve(); });
    const socket = FakeWebSocket.instances[0]!;
    const connectionStatus = container.querySelector(".terminal-connection-status")!;
    expect(connectionStatus.classList.contains("connected")).toBe(false);
    expect(connectionStatus.getAttribute("aria-label")).toBe("Terminal disconnected");
    expect(container.querySelector(".timeline-do-it")).toBeNull();

    await act(async () => { socket.readyState = FakeWebSocket.OPEN; socket.emit("open"); });

    expect(connectionStatus.classList.contains("connected")).toBe(true);
    expect(connectionStatus.getAttribute("aria-label")).toBe("Terminal connected");
    expect(container.textContent).not.toContain("Terminal connected in an isolated workbook container.");
    const action = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Do it for me")!;
    expect(action).toBeTruthy();
    await act(async () => { action.dispatchEvent(new window.MouseEvent("click", { bubbles: true })); });

    expect(socket.sent).toHaveLength(2);
    const input = JSON.parse(socket.sent[1]!);
    expect(input).toEqual({ type: "input", data: "echo hi  | cat" });
    expect(input.data).not.toMatch(/[\r\n]/);
    expect(action.textContent).toBe("Inserted — press Enter");

    await act(async () => { socket.readyState = FakeWebSocket.CLOSED; socket.emit("close"); });
    expect(container.querySelector(".timeline-do-it")).toBeNull();
  });

  it("renders the durable terminal transcript beside terminal success", () => {
    const snapshot = "$ npm test\nPASS  calculator";
    const markup = html(createElement(TerminalHistory, {
      state: activeBlockProgress(lesson.blocks[1]!, {
        terminal: { phase: "complete", message: "Accepted by the Main Tutor." },
        terminalSnapshot: { transcript: snapshot }
      } as any).blocks[0]
    }));

    expect(markup).toContain('class="terminal-history"');
    expect(markup).toContain('class="frozen-terminal-output">$ npm test\nPASS  calculator</pre>');
    expect(markup).toContain("Accepted by the Main Tutor.");
    expect(markup).not.toContain("Terminal session frozen.");
  });

  it("uses one terminal card for public states and never duplicates its DOM surface", async () => {
    class FakeWebSocket {
      static CONNECTING = 0; static OPEN = 1; static CLOSED = 3;
      readyState = FakeWebSocket.OPEN;
      addEventListener() {} send() {} close() { this.readyState = FakeWebSocket.CLOSED; }
    }
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const render = (terminal: any) => createElement(BlockView, {
      block: lesson.blocks[1]!,
      progress: activeBlockProgress(lesson.blocks[1]!, { ...(terminal ? { terminal } : {}) } as any),
      refresh: vi.fn(),
    });
    const container = await mount(render({ phase: "checking" }), (win) => {
      vi.stubGlobal("location", win.location);
      vi.stubGlobal("addEventListener", win.addEventListener.bind(win) as any);
      vi.stubGlobal("removeEventListener", win.removeEventListener.bind(win) as any);
    });
    expect(container.querySelectorAll(".live-block-feedback")).toHaveLength(1);
    expect(container.textContent).toContain("Checking…");

    await act(async () => { mountedRoot!.render(render({ phase: "feedback", message: "Keep the final feedback." })); });
    expect(container.querySelectorAll(".live-block-feedback")).toHaveLength(1);
    expect(container.textContent).toContain("Keep the final feedback.");

    await act(async () => { mountedRoot!.render(render({ phase: "complete", message: "Accepted by the Main Tutor." })); });
    expect(container.querySelector(".embedded-terminal-panel")).toBeNull();
    expect(container.querySelectorAll(".live-block-feedback")).toHaveLength(0);
    expect(container.textContent).not.toContain("Accepted by the Main Tutor.");
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(0);
  });

  it("keeps the server state on Enter and replaces it only with Bash-authoritative state", async () => {
    class FakeWebSocket {
      static CONNECTING = 0; static OPEN = 1; static CLOSED = 3;
      readyState = FakeWebSocket.OPEN;
      addEventListener() {} send() {} close() { this.readyState = FakeWebSocket.CLOSED; }
    }
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const render = (terminal: any) => createElement(BlockView, {
      block: lesson.blocks[1]!,
      progress: activeBlockProgress(lesson.blocks[1]!, { ...(terminal ? { terminal } : {}) } as any),
      refresh: vi.fn(),
    });
    const oldFeedback = { phase: "feedback", message: "Previous feedback remains until Bash reports a new state." } as const;
    const container = await mount(render(oldFeedback), (win) => {
      vi.stubGlobal("location", win.location);
      vi.stubGlobal("addEventListener", win.addEventListener.bind(win) as any);
      vi.stubGlobal("removeEventListener", win.removeEventListener.bind(win) as any);
    });
    expect(container.textContent).toContain(oldFeedback.message);

    await act(async () => { terminalDataListeners[0]!("\r"); });
    expect(container.textContent).toContain(oldFeedback.message);
    expect(container.querySelectorAll(".live-block-feedback")).toHaveLength(1);

    await act(async () => { mountedRoot!.render(render({ phase: "running" })); });
    expect(container.textContent).toContain("Running…");
    expect(container.textContent).not.toContain(oldFeedback.message);
    expect(container.querySelectorAll(".live-block-feedback")).toHaveLength(1);
    expect(container.querySelector(".practice-feedback-spinner")?.getAttribute("aria-hidden")).toBe("true");

    await act(async () => { mountedRoot!.render(render({ phase: "checking" })); });
    expect(container.textContent).toContain("Checking…");
    expect(container.querySelector(".practice-feedback-spinner")).not.toBeNull();
    expect(container.querySelectorAll(".live-block-feedback")).toHaveLength(1);
  });

  it("applies fatal state over an unsent editor revision without losing the local draft or feedback", async () => {
    const editorProgress = activeEditorProgress({
      draftText: "server draft before local typing",
      checkpoint: { status: "reviewing", feedback: "Keep the acceptance marker.", reviewNotice: "Updating feedback…", evidence: { kind: "editor", text: "server draft before local typing" } }
    } as any);
    const healthyState = {
      workbook: { title: "Workbook" },
      introduction: "Intro.",
      introductionComplete: true,
      chapters: [chapter({ lesson: { ...lesson, blocks: [editorBlock] } as any })],
      progress: editorProgress,
      adapter: {},
      timeline: [{ type: "message", id: "course", sequence: 1, at: "2026-08-21T00:00:00.000Z", lessonId: lesson.id, blockId: editorBlock.id, role: "assistant", source: "authored", presentation: "course", text: "## Edit the answer\n\nUpdate the file." }]
    } as any;
    const fatalState = { ...healthyState, fatal: { kind: "tutor-infrastructure", message: "The AI tutor provider is unavailable. Fix or reconnect the provider, then restart this workbook to continue." } } as any;
    let currentState = healthyState;
    const fetchMock = vi.fn(async (_input?: RequestInfo | URL, _init?: RequestInit) => ({ ok: true, json: async () => currentState }));
    vi.stubGlobal("fetch", fetchMock);
    FakeEventSource.reset();
    vi.stubGlobal("EventSource", FakeEventSource as any);

    const container = await mount(createElement(App), stubAppShellGlobals);
    await act(async () => { await Promise.resolve(); });
    const editable = container.querySelector<HTMLElement>(".cm-content")!;
    editable.textContent = "unsent local draft remains visible";
    await act(async () => { editable.dispatchEvent(new window.Event("input", { bubbles: true })); });

    currentState = fatalState;
    await act(async () => {
      FakeEventSource.instances[0]!.emit("state");
      await Promise.resolve().then(() => Promise.resolve());
    });

    const alerts = container.querySelectorAll('[role="alert"].workbook-fatal-notice');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.getAttribute("aria-label")).toBe("Workbook paused");
    expect(alerts[0]?.textContent).toMatch(/workbook paused.*tutor unavailable.*reconnect.*restart/is);
    expect(container.textContent).not.toMatch(/Retry review|>Retry</);
    expect(container.querySelector('.current-activity-band[aria-disabled="true"]')).toBeTruthy();
    expect(container.querySelector(".editor-live-surface")).toBeTruthy();
    expect(container.querySelector('.cm-content[contenteditable="false"][aria-disabled="true"]')).toBeTruthy();
    expect(container.textContent).toContain("unsent local draft remains visible");
    expect(container.textContent).toContain("Keep the acceptance marker.");
    expect(container.textContent).not.toContain("Updating feedback…");
    expect(container.querySelector(".practice-feedback-spinner")).toBeNull();

    const textarea = container.querySelector<HTMLTextAreaElement>(".timeline-input textarea")!;
    const send = container.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')!;
    expect(textarea.disabled).toBe(true);
    expect(send.disabled).toBe(true);
    textarea.value = "must not send";
    await act(async () => {
      textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
      send.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "POST")).toHaveLength(0);
  });

  it("keeps a fatal terminal visible while disabling input, insertion, and stale busy status", async () => {
    let socket: FakeWebSocket | undefined;
    class FakeWebSocket {
      static CONNECTING = 0; static OPEN = 1; static CLOSED = 3;
      readyState = FakeWebSocket.OPEN;
      listeners = new Map<string, Array<() => void>>();
      constructor() { socket = this; }
      addEventListener(type: string, listener: () => void) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
      emit(type: string) { for (const listener of this.listeners.get(type) ?? []) listener(); }
      send = vi.fn();
      close() { this.readyState = FakeWebSocket.CLOSED; }
    }
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const insertion = vi.fn();
    const terminalBlock = lesson.blocks[1]!;
    const container = await mount(createElement(BlockView, {
      block: terminalBlock,
      progress: activeBlockProgress(terminalBlock, { terminal: { phase: "checking" } } as any),
      refresh: vi.fn(),
      disabled: true,
      onTerminalInsertionChange: insertion,
    }), (win) => {
      vi.stubGlobal("location", win.location);
      vi.stubGlobal("addEventListener", win.addEventListener.bind(win) as any);
      vi.stubGlobal("removeEventListener", win.removeEventListener.bind(win) as any);
    });
    await act(async () => { await Promise.resolve(); });

    expect(container.querySelector(".embedded-terminal-panel")).toBeTruthy();
    expect(container.querySelector('.embedded-terminal[aria-disabled="true"][inert]')).toBeTruthy();
    expect(terminalInstances.at(-1)?.options.disableStdin).toBe(true);
    expect(insertion).not.toHaveBeenCalledWith(expect.any(Function));
    expect(container.textContent).not.toContain("Checking…");
    expect(container.querySelector(".practice-feedback-spinner")).toBeNull();
    await act(async () => { socket!.emit("error"); });
    expect(container.textContent).not.toMatch(/connection failed|refresh the page|try again/i);
  });

  it("renders fatal continuation as disabled and never calls completion", async () => {
    const state = {
      workbook: { title: "Workbook" }, introduction: "Intro.", introductionComplete: true,
      chapters: [chapter()], progress, adapter: {},
      fatal: { kind: "tutor-infrastructure", message: "The AI tutor provider is unavailable. Fix or reconnect the provider, then restart this workbook to continue." },
      timeline: [{ type: "message", id: "course", sequence: 1, at: "2026-08-21T00:00:00.000Z", lessonId: lesson.id, blockId: "orientation", role: "assistant", source: "authored", presentation: "course", text: "## Orientation\n\nRead carefully." }]
    } as any;
    const fetchMock = vi.fn(async (_input?: RequestInfo | URL, _init?: RequestInit) => ({ ok: true, json: async () => state }));
    vi.stubGlobal("fetch", fetchMock);
    const container = await mount(createElement(App), stubAppShellGlobals);
    await act(async () => { await Promise.resolve(); });

    const continueButton = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.startsWith("Continue"))!;
    expect(continueButton).toBeTruthy();
    expect(continueButton.disabled).toBe(true);
    await act(async () => { continueButton.dispatchEvent(new window.MouseEvent("click", { bubbles: true })); await Promise.resolve(); });
    expect(fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "POST")).toHaveLength(0);
  });

  it.each([
    ["terminal", lesson.blocks[1]!, activeBlockProgress(lesson.blocks[1]!, { terminal: { phase: "complete", message: "Terminal accepted." } } as any), "Terminal accepted."],
    ["editor", editorBlock, activeEditorProgress({ editorStatus: undefined, checkpoint: { status: "accepted", successMessage: "Editor accepted.", evidence: { kind: "editor", text: "accepted answer text" } } } as any), "Editor accepted."]
  ])("renders only the timeline continuation for accepted %s practice in timeline mode", async (_kind, block, acceptedProgress, acceptedText) => {
    const state = {
      workbook: { title: "Workbook" },
      introduction: "Intro.",
      introductionComplete: true,
      chapters: [chapter({ lesson: { ...lesson, blocks: [block] } as any })],
      progress: acceptedProgress,
      adapter: {},
      timeline: [
        { type: "message", id: "course", sequence: 1, at: "2026-08-21T00:00:00.000Z", lessonId: lesson.id, blockId: block.id, role: "assistant", source: "authored", presentation: "course", text: `## ${block.title}\n\nDo the work.` },
        { type: "message", id: "review", sequence: 2, at: "2026-08-21T00:00:01.000Z", lessonId: lesson.id, blockId: block.id, role: "assistant", source: "main_tutor", presentation: "review", text: acceptedText }
      ]
    } as any;
    const nextState = { ...state, progress: { ...acceptedProgress, activeBlockId: "transition" } };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => ({ ok: true, json: async () => init?.method === "POST" ? nextState : state }));
    vi.stubGlobal("fetch", fetchMock);

    const container = await mount(createElement(App), stubAppShellGlobals);
    await act(async () => { await Promise.resolve(); });

    expect(container.textContent).toContain(acceptedText);
    expect(container.querySelector(".current-activity-band")).toBeNull();
    expect(container.textContent).not.toContain("Get a hint");
    const continueButtons = [...container.querySelectorAll<HTMLButtonElement>("button")].filter((button) => button.textContent === "Continue");
    expect(continueButtons).toHaveLength(1);
    expect(container.querySelectorAll(".continuation-controls")).toHaveLength(1);

    await act(async () => { continueButtons[0]!.dispatchEvent(new window.MouseEvent("click", { bubbles: true })); });

    const eventCall = fetchMock.mock.calls.find(([url]) => url === "api/workbook/complete-block");
    expect(eventCall).toBeTruthy();
    expect(JSON.parse((eventCall![1] as RequestInit).body as string)).toEqual({ blockId: block.id });
  });

  it("routes active reflection composer sends through the reflection event path without a sticky hint", async () => {
    const reflectionProgress: Progress = {
      ...progress,
      activeBlockId: "reflect",
      blocks: [{ id: "reflect", type: "reflection", ready: true, active: true, completed: false, verified: false, emerged: true }],
      reflectionConversations: {}
    };
    const state = {
      workbook: { title: "Workbook" },
      introduction: "Intro.",
      introductionComplete: true,
      chapters: [chapter({ lesson: { ...lesson, blocks: [lesson.blocks[2]!] } as any })],
      progress: reflectionProgress,
      adapter: {},
      timeline: [{ type: "message", id: "course", sequence: 1, at: "2026-08-21T00:00:00.000Z", lessonId: lesson.id, blockId: "reflect", role: "assistant", source: "authored", presentation: "course", text: "## Reflect\n\nWhat changed?" }]
    } as any;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => ({ ok: true, json: async () => init?.method === "POST" ? state : state }));
    vi.stubGlobal("fetch", fetchMock);

    const container = await mount(createElement(App), stubAppShellGlobals);
    await act(async () => { await Promise.resolve(); });

    expect(container.textContent).not.toContain("Get a hint");
    expect(container.textContent).not.toContain("Your reflection");
    expect(container.querySelector(".timeline-composer-dock.fixed-composer")).not.toBeNull();
    const textarea = container.querySelector<HTMLTextAreaElement>(".timeline-input textarea")!;
    textarea.value = "My reflection answer";
    await act(async () => { textarea.dispatchEvent(new window.Event("input", { bubbles: true })); });
    const sendButton = container.querySelector<HTMLButtonElement>("button[aria-label='Send message']")!;
    await act(async () => { sendButton.dispatchEvent(new window.MouseEvent("click", { bubbles: true })); });

    const eventCall = fetchMock.mock.calls.find(([url]) => url === "api/workbook/events");
    expect(eventCall).toBeTruthy();
    expect(JSON.parse((eventCall![1] as RequestInit).body as string)).toEqual({ blockId: "reflect", action: "reflection-submit", response: "My reflection answer" });
  });

  it("renders accepted reflection continuation in the timeline and advances through the block event path", async () => {
    const reflectionProgress: Progress = {
      ...progress,
      activeBlockId: "reflect",
      blocks: [{ id: "reflect", type: "reflection", ready: true, active: true, completed: false, verified: false, emerged: true, checkpoint: { status: "accepted", successMessage: "Reflection accepted.", evidence: { kind: "reflection", conversation: [{ role: "learner", text: "First answer" }, { role: "tutor", text: "Accepted." }] } } } as any],
      reflectionConversations: { reflect: [{ role: "learner", text: "First answer" }] }
    };
    const state = {
      workbook: { title: "Workbook" },
      introduction: "Intro.",
      introductionComplete: true,
      chapters: [chapter({ lesson: { ...lesson, blocks: [lesson.blocks[2]!] } as any })],
      progress: reflectionProgress,
      adapter: {},
      timeline: [
        { type: "message", id: "course", sequence: 1, at: "2026-08-21T00:00:00.000Z", lessonId: lesson.id, blockId: "reflect", role: "assistant", source: "authored", presentation: "course", text: "## Reflect\n\nWhat changed?" },
        { type: "message", id: "learner", sequence: 2, at: "2026-08-21T00:00:01.000Z", lessonId: lesson.id, blockId: "reflect", role: "user", source: "learner", presentation: "chat", text: "First answer" },
        { type: "message", id: "review", sequence: 3, at: "2026-08-21T00:00:02.000Z", lessonId: lesson.id, blockId: "reflect", role: "assistant", source: "main_tutor", presentation: "review", text: "Accepted." }
      ]
    } as any;
    const nextState = { ...state, progress: { ...reflectionProgress, activeBlockId: "transition" } };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => ({ ok: true, json: async () => init?.method === "POST" ? nextState : state }));
    vi.stubGlobal("fetch", fetchMock);

    const container = await mount(createElement(App), stubAppShellGlobals);
    await act(async () => { await Promise.resolve(); });

    expect(container.textContent).toContain("Accepted.");
    expect(container.querySelector(".current-activity-band")).toBeNull();
    const continueButton = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Continue");
    expect(continueButton).toBeTruthy();
    expect(container.querySelector<HTMLTextAreaElement>(".timeline-input textarea")!.disabled).toBe(true);

    await act(async () => { continueButton!.dispatchEvent(new window.MouseEvent("click", { bubbles: true })); });

    const eventCall = fetchMock.mock.calls.find(([url]) => url === "api/workbook/complete-block");
    expect(eventCall).toBeTruthy();
    expect(JSON.parse((eventCall![1] as RequestInit).body as string)).toEqual({ blockId: "reflect" });
    expect(fetchMock.mock.calls.find(([url]) => url === "api/workbook/messages")).toBeUndefined();
  });

  it("disables reflection follow-up while the current attempt is reviewing", async () => {
    const reflectionProgress: Progress = {
      ...progress,
      activeBlockId: "reflect",
      blocks: [{ id: "reflect", type: "reflection", ready: true, active: true, completed: false, verified: false, emerged: true, checkpoint: { status: "reviewing", evidence: { kind: "reflection", conversation: [{ role: "learner", text: "First answer" }] } } } as any],
      reflectionConversations: { reflect: [{ role: "learner", text: "First answer" }] }
    };
    const state = {
      workbook: { title: "Workbook" },
      introduction: "Intro.",
      introductionComplete: true,
      chapters: [chapter({ lesson: { ...lesson, blocks: [lesson.blocks[2]!] } as any })],
      progress: reflectionProgress,
      adapter: {},
      timeline: [
        { type: "message", id: "course", sequence: 1, at: "2026-08-21T00:00:00.000Z", lessonId: lesson.id, blockId: "reflect", role: "assistant", source: "authored", presentation: "course", text: "## Reflect\n\nWhat changed?" },
        { type: "message", id: "learner", sequence: 2, at: "2026-08-21T00:00:01.000Z", lessonId: lesson.id, blockId: "reflect", role: "user", source: "learner", presentation: "chat", text: "First answer" }
      ]
    } as any;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => ({ ok: true, json: async () => init?.method === "POST" ? state : state }));
    vi.stubGlobal("fetch", fetchMock);

    const container = await mount(createElement(App), stubAppShellGlobals);
    await act(async () => { await Promise.resolve(); });

    const textarea = container.querySelector<HTMLTextAreaElement>(".timeline-input textarea")!;
    const sendButton = container.querySelector<HTMLButtonElement>("button[aria-label='Send message']")!;
    expect(textarea.disabled).toBe(true);
    expect(sendButton.disabled).toBe(true);
  });

  it("routes a second reflection message as a follow-up while a reflection draft is working", async () => {
    const reflectionProgress: Progress = {
      ...progress,
      activeBlockId: "reflect",
      blocks: [{ id: "reflect", type: "reflection", ready: true, active: true, completed: false, verified: false, emerged: true, checkpoint: { status: "working", evidence: { kind: "reflection", conversation: [{ role: "learner", text: "First answer" }] } } } as any],
      reflectionConversations: { reflect: [{ role: "learner", text: "First answer" }] }
    };
    const state = {
      workbook: { title: "Workbook" },
      introduction: "Intro.",
      introductionComplete: true,
      chapters: [chapter({ lesson: { ...lesson, blocks: [lesson.blocks[2]!] } as any })],
      progress: reflectionProgress,
      adapter: {},
      timeline: [
        { type: "message", id: "course", sequence: 1, at: "2026-08-21T00:00:00.000Z", lessonId: lesson.id, blockId: "reflect", role: "assistant", source: "authored", presentation: "course", text: "## Reflect\n\nWhat changed?" },
        { type: "message", id: "learner", sequence: 2, at: "2026-08-21T00:00:01.000Z", lessonId: lesson.id, blockId: "reflect", role: "user", source: "learner", presentation: "chat", text: "First answer" }
      ]
    } as any;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => ({ ok: true, json: async () => init?.method === "POST" ? state : state }));
    vi.stubGlobal("fetch", fetchMock);

    const container = await mount(createElement(App), stubAppShellGlobals);
    await act(async () => { await Promise.resolve(); });

    const textarea = container.querySelector<HTMLTextAreaElement>(".timeline-input textarea")!;
    textarea.value = "Second answer";
    await act(async () => { textarea.dispatchEvent(new window.Event("input", { bubbles: true })); });
    const sendButton = container.querySelector<HTMLButtonElement>("button[aria-label='Send message']")!;
    await act(async () => { sendButton.dispatchEvent(new window.MouseEvent("click", { bubbles: true })); });

    const eventCall = fetchMock.mock.calls.find(([url]) => url === "api/workbook/events");
    expect(eventCall).toBeTruthy();
    expect(JSON.parse((eventCall![1] as RequestInit).body as string)).toEqual({ blockId: "reflect", action: "reflection-follow-up", response: "Second answer" });
  });

  it("rejects a malformed tutor message response instead of rendering it", async () => {
    const state = {
      workbook: { title: "Workbook" },
      introduction: "Intro.",
      introductionComplete: false,
      chapters: [chapter({ lesson: undefined } as any)],
      progress,
      adapter: {},
      timeline: [{ type: "message", id: "intro", sequence: 1, at: "2026-08-21T00:00:00.000Z", lessonId: "workbook--introduction", blockId: "workbook--introduction", role: "assistant", source: "authored", presentation: "course", text: "# Workbook\n\nTimeline intro copy." }]
    } as any;
    const malformed = { error: "MALFORMED_TUTOR_REPLY" };
    const fetchMock = vi.fn(async (input?: RequestInfo | URL) => ({ ok: true, json: async () => String(input).endsWith("api/workbook/messages") ? malformed : state }));
    vi.stubGlobal("fetch", fetchMock);

    const container = await mount(createElement(App), stubAppShellGlobals);
    await act(async () => { await Promise.resolve(); });

    const textarea = container.querySelector<HTMLTextAreaElement>("textarea[name='message']")!;
    textarea.value = "Is this thing on?";
    await act(async () => { textarea.dispatchEvent(new window.Event("input", { bubbles: true })); });

    const rejections: unknown[] = [];
    const onUnhandledRejection = (error: unknown) => { rejections.push(error); };
    process.on("unhandledRejection", onUnhandledRejection);
    try {
      const sendButton = container.querySelector<HTMLButtonElement>("button[aria-label='Send message']")!;
      await act(async () => { sendButton.dispatchEvent(new window.MouseEvent("click", { bubbles: true })); });
      await act(async () => { await Promise.resolve().then(() => Promise.resolve()); });
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }

    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("api/workbook/messages"))).toBe(true);
    expect(rejections.map((error) => String(error)).join(" ")).toContain("invalid public state");
    expect(container.textContent).toContain("Timeline intro copy.");
    expect(container.textContent).not.toContain("MALFORMED_TUTOR_REPLY");
    expect(textarea.value).toBe("Is this thing on?");
  });

  it("addresses every workbook request relatively so a workbook mounted under a sub-path still reaches its own API", async () => {
    const state = {
      workbook: { title: "Workbook" },
      introduction: "Intro.",
      introductionComplete: false,
      chapters: [chapter({ lesson: undefined } as any)],
      progress,
      adapter: {},
      timeline: [
        { type: "message", id: "intro", sequence: 1, at: "2026-08-21T00:00:00.000Z", lessonId: "workbook--introduction", blockId: "workbook--introduction", role: "assistant", source: "authored", presentation: "course", text: "# Workbook\n\nTimeline intro copy." }
      ]
    } as any;
    FakeEventSource.reset();
    const fetchMock = vi.fn(async (input?: RequestInfo | URL) => ({ ok: true, json: async () => String(input).endsWith("api/workbook/complete-block") ? { outcome: "already-completed", state } : state }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("EventSource", FakeEventSource as any);

    const container = await mount(createElement(App), stubAppShellGlobals);
    await act(async () => { await Promise.resolve(); });

    const textarea = container.querySelector<HTMLTextAreaElement>("textarea[name='message']")!;
    textarea.value = "Where do I start?";
    await act(async () => { textarea.dispatchEvent(new window.Event("input", { bubbles: true })); });
    const sendButton = container.querySelector<HTMLButtonElement>("button[aria-label='Send message']")!;
    await act(async () => { sendButton.dispatchEvent(new window.MouseEvent("click", { bubbles: true })); });

    const continueButton = [...container.querySelectorAll("button")].find((button) => button.textContent === "Ready to continue")!;
    await act(async () => { continueButton.dispatchEvent(new window.MouseEvent("click", { bubbles: true })); });

    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(urls.filter((url) => url.startsWith("/"))).toEqual([]);
    expect(new Set(urls)).toEqual(new Set(["api/workbook/state", "api/workbook/messages", "api/workbook/complete-block"]));
    expect(FakeEventSource.instances[0]!.url).toBe("api/workbook/timeline");
  });

  it("addresses the terminal socket relatively so a workbook mounted under a sub-path still reaches its own socket", async () => {
    class FakeWebSocket {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;
      static instances: FakeWebSocket[] = [];
      readyState = FakeWebSocket.CONNECTING;
      readonly url: string;
      private listeners = new Map<string, Array<(event: any) => void>>();
      constructor(url: string) { this.url = url; FakeWebSocket.instances.push(this); }
      addEventListener(type: string, listener: (event: any) => void) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
      send() {}
      close() { this.readyState = FakeWebSocket.CLOSED; this.emit("close"); }
      emit(type: string, event: any = {}) { for (const listener of this.listeners.get(type) ?? []) listener(event); }
    }
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const state = {
      workbook: { title: "Workbook" },
      introduction: "Intro.",
      introductionComplete: true,
      chapters: [chapter()],
      progress: activeBlockProgress(lesson.blocks[1]!),
      adapter: {},
      timeline: [{ type: "message", id: "course", sequence: 1, at: "2026-08-21T00:00:00.000Z", lessonId: lesson.id, blockId: "practice", role: "assistant", source: "authored", presentation: "course", text: "## Practice\n\nRun the authored command." }]
    } as any;
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => state })));

    const container = await mount(createElement(App), (win) => {
      stubAppShellGlobals(win);
      // The workbook is served under a prefix, on an origin whose scheme and host differ from the
      // page the harness loads (http://localhost/workbook). The assertion below therefore fails on
      // every part of an address rebuilt from `location` instead of from the document's base.
      const base = win.document.createElement("base");
      base.href = "https://workbook.example/courses/factory/";
      win.document.head.append(base);
      vi.stubGlobal("location", win.location);
    });
    await act(async () => { await Promise.resolve(); });

    expect(container.querySelector(".terminal-connection-status")).toBeTruthy();
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0]!.url).toBe("wss://workbook.example/courses/factory/api/workbook/terminal");
  });
});
