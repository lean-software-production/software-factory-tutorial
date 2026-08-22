import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@codemirror/state", () => ({
  EditorState: { create: (config: any) => config }
}));

vi.mock("@codemirror/view", () => {
  const listenerMarker = "__cmUpdateListener";
  const flatten = (value: any): any[] => Array.isArray(value) ? value.flatMap(flatten) : [value];
  class EditorView {
    static updateListener = { of: (listener: (update: any) => void) => ({ [listenerMarker]: listener }) };
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

vi.mock("../src/workbook/lesson-links.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/workbook/lesson-links.js")>();
  return { ...actual, lessonElementId: vi.fn(actual.lessonElementId) };
});

import { AcceptanceConfetti, App, BlockView, LessonRail, LessonView, scrollActiveLessonIntoView, type Chapter, type Progress } from "../web-workbook/src/workbook-ui.js";
import { lessonAnchorHref, lessonElementId } from "../src/workbook/lesson-links.js";

const progress: Progress = {
  activeLessonId: "part/lesson-one",
  activeBlockId: "orientation",
  completedLessons: [],
  blocks: [
    { id: "orientation", type: "narrative", ready: true, active: true, completed: false, verified: false, emerged: true },
    { id: "practice", type: "terminal-practice", ready: false, active: false, completed: false, verified: false, emerged: false },
    { id: "reflect", type: "reflection", ready: false, active: false, completed: false, verified: false, emerged: false },
    { id: "transition", type: "lesson-transition", ready: false, active: false, completed: false, verified: false, emerged: false },
  ],
  unexpected: {},
  reflections: {},
  reflectionConversations: {},
};

const lesson = {
  id: "part/lesson-one",
  title: "Markdown Lesson",
  dek: "Dek paragraph.",
  durationMinutes: 14,
  outcomes: ["Run the supplied command.", "Explain what changed."],
  blocks: [
    { id: "orientation", type: "narrative", title: "Orientation", markdown: "Read **carefully**.\n\n- One\n- Two", tutor: "private narrative note" },
    { id: "practice", type: "terminal-practice", title: "Practice", markdown: "Run this:\n\n```sh command\necho hi \\\n  | cat\n```", tutor: "private practice guidance" },
    { id: "reflect", type: "reflection", title: "Reflect", markdown: "Why did it work?", tutor: "private reflection prompt" },
    { id: "transition", type: "lesson-transition", title: "Next", markdown: "Continue to **lesson two**." },
  ],
};

function html(element: ReturnType<typeof createElement>) {
  return renderToStaticMarkup(element);
}

function chapter(overrides: Partial<Chapter> = {}): Chapter & { lesson: typeof lesson } {
  return { id: lesson.id, part: "Part One", partMarkdown: "Part copy.", partNumber: 1, lessonNumber: 1, title: lesson.title, lesson, ...overrides } as Chapter & { lesson: typeof lesson };
}

function progressWithActiveDuplicate(blockId: string): Progress {
  return {
    ...progress,
    activeLessonId: "part/lesson-two",
    activeBlockId: blockId,
    completedLessons: ["part/lesson-one"],
    blocks: progress.blocks.map((block) => ({
      ...block,
      active: block.id === blockId,
      ready: block.id === blockId || block.completed,
      completed: block.id === "orientation" && blockId !== "orientation",
      verified: false,
      emerged: block.id === blockId || block.completed,
    })),
  };
}

const editorBlock = {
  id: "edit-answer",
  type: "editor-practice",
  title: "Edit the answer",
  markdown: "Update the answer file so it contains the acceptance marker.",
  path: "factory/answer.md",
  tutor: "Private editor rubric: require the acceptance marker."
} as any;

function activeEditorProgress(overrides: Partial<Progress["blocks"][number]> = {}): Progress {
  return {
    ...progress,
    activeBlockId: editorBlock.id,
    blocks: [{ id: editorBlock.id, type: "editor-practice", ready: true, active: true, completed: false, verified: false, emerged: true, editorStatus: "editing", ...overrides } as any],
  };
}

function activeBlockProgress(block: { id: string; type: string }, overrides: Partial<Progress["blocks"][number]> = {}): Progress {
  return {
    ...progress,
    activeBlockId: block.id,
    blocks: [{ id: block.id, type: block.type, ready: true, active: true, completed: false, verified: false, emerged: true, ...overrides } as any],
  };
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

describe("workbook lesson UI", () => {
  it("renders an active editor-practice block without exposing private tutor text", () => {
    const markup = html(createElement(BlockView, { block: editorBlock, progress: activeEditorProgress(), refresh: vi.fn() }));

    expect(markup).toContain("Edit the answer");
    expect(markup).toContain("factory/answer.md");
    expect(markup).toContain("editor-surface");
    expect(markup).toContain("role=\"status\"");
    expect(markup).toMatch(/editing|review/i);
    expect(markup).not.toContain("Private editor rubric");
    expect(markup).not.toContain("Save");
    expect(markup).not.toContain("Review");
  });

  it("does not render live editor-practice surface or status for inactive and completed blocks", () => {
    const inactiveMarkup = html(createElement(BlockView, {
      block: editorBlock,
      progress: activeEditorProgress({ ready: false, active: false, completed: false, editorStatus: undefined, feedback: "Hold this feedback until the block is active." } as any),
      refresh: vi.fn()
    }));
    const completedMarkup = html(createElement(BlockView, {
      block: editorBlock,
      progress: activeEditorProgress({ active: false, completed: true, editorStatus: "unlocked", feedback: "Approved: the answer is accepted." } as any),
      refresh: vi.fn()
    }));

    expect(inactiveMarkup).toContain("Edit the answer");
    expect(inactiveMarkup).toContain("factory/answer.md");
    expect(inactiveMarkup).not.toContain("editor-surface");
    expect(inactiveMarkup).not.toContain("role=\"status\"");
    expect(inactiveMarkup).not.toMatch(/Editing —|Reviewing your latest revision/);

    expect(completedMarkup).toContain("factory/answer.md");
    expect(completedMarkup).toContain("Accepted revision unlocked the next step.");
    expect(completedMarkup).toContain("Approved: the answer is accepted.");
    expect(completedMarkup).not.toContain("editor-surface");
    expect(completedMarkup).not.toContain("role=\"status\"");
    expect(completedMarkup).not.toMatch(/Editing —|Reviewing your latest revision/);
  });

  it("renders shared accepted checkpoints with read-only evidence for editor, terminal, and reflection work", () => {
    const editorMarkup = html(createElement(BlockView, {
      block: editorBlock,
      progress: activeEditorProgress({
        editorStatus: undefined,
        checkpoint: { status: "accepted", successMessage: "Tutor says the editor work is ready.", evidence: { kind: "editor", text: "accepted answer text" } }
      } as any),
      refresh: vi.fn()
    }));
    expect(editorMarkup).toContain("Tutor says the editor work is ready.");
    expect(editorMarkup).toContain("accepted answer text");
    expect(editorMarkup).toContain("Continue");
    expect(editorMarkup).toContain("success-checkpoint");
    expect(editorMarkup).not.toContain("editor-surface");

    const terminalMarkup = html(createElement(BlockView, {
      block: lesson.blocks[1],
      progress: activeBlockProgress(lesson.blocks[1], {
        checkpoint: { status: "accepted", successMessage: "Tutor accepted the terminal result.", evidence: { kind: "terminal", terminalHtml: "<pre class=\"frozen-terminal-output\">terminal transcript</pre>" } }
      } as any),
      refresh: vi.fn()
    }));
    expect(terminalMarkup).toContain("Tutor accepted the terminal result.");
    expect(terminalMarkup).toContain("terminal transcript");
    expect(terminalMarkup).toContain("Frozen terminal session");
    expect(terminalMarkup).toContain("Continue");
    expect(terminalMarkup).not.toContain("Embedded terminal");

    const reflectionMarkup = html(createElement(BlockView, {
      block: lesson.blocks[2],
      progress: activeBlockProgress(lesson.blocks[2], {
        checkpoint: { status: "accepted", successMessage: "Tutor accepted the reflection.", evidence: { kind: "reflection", conversation: [{ role: "learner", text: "My answer" }, { role: "tutor", text: "Tutor note" }] } }
      } as any),
      refresh: vi.fn()
    }));
    expect(reflectionMarkup).toContain("Tutor accepted the reflection.");
    expect(reflectionMarkup).toContain("My answer");
    expect(reflectionMarkup).toContain("Tutor note");
    expect(reflectionMarkup).toContain("Continue");
    expect(reflectionMarkup).not.toContain("Your reflection");
  });

  it("does not show checkpoint Continue for nonaccepted evaluated blocks", () => {
    const terminalMarkup = html(createElement(BlockView, { block: lesson.blocks[1], progress: activeBlockProgress(lesson.blocks[1]), refresh: vi.fn() }));
    const reflectionMarkup = html(createElement(BlockView, { block: lesson.blocks[2], progress: activeBlockProgress(lesson.blocks[2]), refresh: vi.fn() }));
    const editorMarkup = html(createElement(BlockView, { block: editorBlock, progress: activeEditorProgress({ checkpoint: { status: "feedback", feedback: "Try again.", evidence: { kind: "editor", text: "draft" } } } as any), refresh: vi.fn() }));

    expect(terminalMarkup).not.toContain("success-checkpoint");
    expect(terminalMarkup).not.toContain("Continue");
    expect(reflectionMarkup).not.toContain("success-checkpoint");
    expect(reflectionMarkup).not.toContain("Continue");
    expect(editorMarkup).not.toContain("success-checkpoint");
    expect(editorMarkup).not.toContain("Continue");
  });

  it("keeps a focused editor through feedback refreshes and removes it only after acceptance", async () => {
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

    await act(async () => {
      mountedRoot!.render(createElement(BlockView, { block: editorBlock, progress: activeEditorProgress({ revision: 2, editorStatus: undefined, checkpoint: { status: "accepted", successMessage: "Accepted.", evidence: { kind: "editor", text: "accepted text" } } } as any), refresh }));
    });

    expect(container.querySelector("[role='textbox'][contenteditable='true']")).toBeNull();
    expect(container.textContent).toContain("Accepted.");
    expect(container.textContent).toContain("accepted text");
  });

  it("shows one-second pointer-inert confetti only for new accepted keys and respects reduced motion", async () => {
    vi.useFakeTimers();
    const matchMedia = vi.fn((query: string) => ({ matches: false, media: query, onchange: null, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn() }));
    vi.stubGlobal("matchMedia", matchMedia);
    const container = await mount(createElement(AcceptanceConfetti, { acceptedKey: undefined }));
    expect(container.querySelector(".acceptance-confetti")).toBeNull();

    await act(async () => { mountedRoot!.render(createElement(AcceptanceConfetti, { acceptedKey: "lesson/block/editor/1" })); });
    const layer = container.querySelector<HTMLElement>(".acceptance-confetti");
    expect(layer).not.toBeNull();
    expect(layer!.getAttribute("aria-hidden")).toBe("true");
    expect(layer!.style.pointerEvents).toBe("none");

    await act(async () => { vi.advanceTimersByTime(999); });
    expect(container.querySelector(".acceptance-confetti")).not.toBeNull();
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(container.querySelector(".acceptance-confetti")).toBeNull();

    await act(async () => { mountedRoot!.render(createElement(AcceptanceConfetti, { acceptedKey: "lesson/block/editor/1" })); });
    expect(container.querySelector(".acceptance-confetti")).toBeNull();

    matchMedia.mockReturnValue({ matches: true, media: "(prefers-reduced-motion: reduce)", onchange: null, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn() });
    await act(async () => { mountedRoot!.render(createElement(AcceptanceConfetti, { acceptedKey: "lesson/block/editor/2" })); });
    expect(container.querySelector(".acceptance-confetti")).toBeNull();
  });

  it("debounces editor-practice edits and posts only the latest text at the next revision", async () => {
    vi.useFakeTimers();
    const refresh = vi.fn();
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ progress: activeEditorProgress({ revision: 1, editorStatus: "reviewing" } as any) }) }));
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
    expect(fetchMock.mock.calls[0][0]).toBe("/api/workbook/editor");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "POST", headers: { "Content-Type": "application/json" } });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ blockId: "edit-answer", revision: 1, text: "second draft" });
  });

  it("preserves editor focus while refreshed state arrives", async () => {
    const refresh = vi.fn();
    const container = await mount(createElement(BlockView, { block: editorBlock, progress: activeEditorProgress({ revision: 0, draftText: "" } as any), refresh }));
    const editor = container.querySelector<HTMLElement>("[role='textbox'][contenteditable='true']");
    editor!.focus();
    expect(document.activeElement).toBe(editor);

    await act(async () => {
      mountedRoot!.render(createElement(BlockView, { block: editorBlock, progress: activeEditorProgress({ revision: 1, draftText: "first draft", editorStatus: "waiting" } as any), refresh }));
    });

    expect(document.activeElement).toBe(container.querySelector("[role='textbox'][contenteditable='true']"));
  });

  it("continues submitting after a refreshed draft recreates the editor", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ progress: activeEditorProgress({ revision: 1, draftText: "first draft", editorStatus: "waiting" } as any) }) }));
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
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ blockId: "edit-answer", revision: 2, text: "second draft" });
  });

  it("polls public state while an editor review is in flight and refreshes on completion", async () => {
    vi.useFakeTimers();
    const unlockedState = { progress: activeEditorProgress({ active: false, completed: true, revision: 1, editorStatus: "unlocked", feedback: "Accepted." } as any) };
    const refresh = vi.fn();
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => unlockedState }));
    vi.stubGlobal("fetch", fetchMock);

    await mount(createElement(BlockView, { block: editorBlock, progress: activeEditorProgress({ revision: 1, editorStatus: "reviewing" } as any), refresh }));
    await act(async () => {
      vi.advanceTimersByTime(250);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/workbook/state");
    expect(refresh).toHaveBeenCalledWith(unlockedState);
    fetchMock.mockClear();
    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stops editor review polling when the active editor unmounts", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ progress: activeEditorProgress({ revision: 1, editorStatus: "reviewing" } as any) }) }));
    vi.stubGlobal("fetch", fetchMock);

    await mount(createElement(BlockView, { block: editorBlock, progress: activeEditorProgress({ revision: 1, editorStatus: "reviewing" } as any), refresh: vi.fn() }));
    await act(async () => {
      vi.advanceTimersByTime(250);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => { mountedRoot!.unmount(); });
    mountedRoot = undefined;
    fetchMock.mockClear();
    await act(async () => {
      vi.advanceTimersByTime(2_000);
      await Promise.resolve();
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("renders the Markdown manifest lesson header, fixed outcomes section, and ordered Markdown blocks", () => {
    const markup = html(createElement(LessonView, { chapter: chapter(), progress, refresh: vi.fn() }));

    expect(markup).toContain('<header id="lesson-part-lesson-one"><p class="eyebrow">Lesson 1</p><h1>Markdown Lesson</h1><p class="dek">Dek paragraph.</p><div class="lesson-meta"><span class="chip duration">14 min</span></div></header>');
    expect(markup).toContain("What you will learn");
    expect(markup).toContain("Run the supplied command.");
    expect(markup.indexOf("Orientation")).toBeLessThan(markup.indexOf("Practice"));
    expect(markup).toContain("<strong>carefully</strong>");
    expect(markup).toContain("<li>One</li>");
    expect(markup).toContain('class="hljs language-sh"');
    expect(markup).not.toContain("private");
  });

  it("shows continuation controls and scroll sentinels only for active narrative and transition blocks", () => {
    const activeNarrative = html(createElement(BlockView, { block: lesson.blocks[0], progress, refresh: vi.fn() }));
    expect(activeNarrative).toContain("Continue");
    expect(activeNarrative).toContain('data-completion-action="continue"');

    const activeTransitionProgress = { ...progress, activeBlockId: "transition", blocks: progress.blocks.map((block) => ({ ...block, active: block.id === "transition", ready: true, emerged: true })) };
    const activeTransition = html(createElement(BlockView, { block: lesson.blocks[3], progress: activeTransitionProgress, refresh: vi.fn() }));
    expect(activeTransition).toContain("Continue");
    expect(activeTransition).toContain('data-completion-action="continue"');

    const activeTerminalProgress = { ...progress, activeBlockId: "practice", blocks: progress.blocks.map((block) => ({ ...block, active: block.id === "practice", ready: true, emerged: true })) };
    const activeTerminal = html(createElement(BlockView, { block: lesson.blocks[1], progress: activeTerminalProgress, refresh: vi.fn() }));
    expect(activeTerminal).not.toContain('data-completion-action="continue"');

    const activeReflectionProgress = { ...progress, activeBlockId: "reflect", blocks: progress.blocks.map((block) => ({ ...block, active: block.id === "reflect", ready: true, emerged: true })) };
    const activeReflection = html(createElement(BlockView, { block: lesson.blocks[2], progress: activeReflectionProgress, refresh: vi.fn() }));
    expect(activeReflection).not.toContain('data-completion-action="continue"');
  });

  it("keeps embedded terminal as the only terminal path and inserts only authored command fences", () => {
    const activeTerminalProgress = { ...progress, activeBlockId: "practice", blocks: progress.blocks.map((block) => ({ ...block, active: block.id === "practice", ready: true, emerged: true })) };
    const withCommand = html(createElement(BlockView, { block: lesson.blocks[1], progress: activeTerminalProgress, refresh: vi.fn() }));
    expect(withCommand).toContain("Embedded terminal");
    expect(withCommand).toContain("Insert command");
    expect(withCommand).not.toContain("Use your own terminal");
    expect(withCommand).not.toContain("fallback");

    const scriptSnippetBlock = { ...lesson.blocks[1], markdown: "Create this script:\n\n```sh\n#!/usr/bin/env bash\necho script body\n```" };
    const withSnippet = html(createElement(BlockView, { block: scriptSnippetBlock, progress: activeTerminalProgress, refresh: vi.fn() }));
    expect(withSnippet).toContain("Embedded terminal");
    expect(withSnippet).not.toContain("Insert command");

    const clueOnlyBlock = { ...lesson.blocks[1], markdown: "Try the command you just edited, then compare its output." };
    const withoutCommand = html(createElement(BlockView, { block: clueOnlyBlock, progress: activeTerminalProgress, refresh: vi.fn() }));
    expect(withoutCommand).toContain("Embedded terminal");
    expect(withoutCommand).not.toContain("Insert command");
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

  it("labels the rail rows and lesson header with global lesson numbers across parts", () => {
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

    const lessonMarkup = html(createElement(LessonView, { chapter: chapterOne, progress: railProgress, refresh: vi.fn() }));
    expect(lessonMarkup).toContain('<p class="eyebrow">Lesson 1</p>');
    expect(lessonMarkup).not.toMatch(/<p class="eyebrow">Lesson 1\d/);
  });

  it("renders each part roadmap once even when a part has multiple lessons", async () => {
    const partALessonOne = { ...lesson, id: "part-a/lesson-one", title: "Part A Lesson One" };
    const partALessonTwo = { ...lesson, id: "part-a/lesson-two", title: "Part A Lesson Two" };
    const partBLessonOne = { ...lesson, id: "part-b/lesson-one", title: "Part B Lesson One" };
    const chapters: Chapter[] = [
      { id: partALessonOne.id, title: partALessonOne.title, part: "Part A", partMarkdown: "Part A copy.", partNumber: 1, lessonNumber: 1, lesson: partALessonOne },
      { id: partALessonTwo.id, title: partALessonTwo.title, part: "Part A", partMarkdown: "Part A copy.", partNumber: 1, lessonNumber: 2, lesson: partALessonTwo },
      { id: partBLessonOne.id, title: partBLessonOne.title, part: "Part B", partMarkdown: "Part B copy.", partNumber: 2, lessonNumber: 3, lesson: partBLessonOne },
    ];
    const appProgress: Progress = { ...progress, activeLessonId: partALessonOne.id, completedLessons: [] };
    const state = { workbook: { title: "Workbook" }, introduction: "Intro.", introductionComplete: true, chapters, progress: appProgress, adapter: {} };
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => state }));
    vi.stubGlobal("fetch", fetchMock);

    const container = await mount(createElement(App), stubAppShellGlobals);

    expect(container.querySelectorAll(".part-chapter")).toHaveLength(2);
    expect(container.textContent).toContain("Part A copy.");
    expect(container.textContent).toContain("Part B copy.");
  });

  it("scrolls to the active lesson's sanitized DOM id", () => {
    const scrollIntoView = vi.fn();
    const getElementById = vi.fn((id: string) => id === "lesson-part-two-lesson-two" ? { scrollIntoView } : null);

    scrollActiveLessonIntoView({ getElementById }, "part two/lesson#two");

    expect(getElementById).toHaveBeenCalledWith("lesson-part-two-lesson-two");
    expect(getElementById).not.toHaveBeenCalledWith("lesson-part two/lesson#two");
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });
  });

  it("links lesson outlines to lesson-scoped safe block DOM ids", () => {
    const unsafeLesson = { ...lesson, id: "part two/lesson#two", blocks: [{ ...lesson.blocks[0], id: "repeat block?" }] };
    const chapters: Chapter[] = [{ id: unsafeLesson.id, title: "Unsafe", part: "Part Two", partMarkdown: "", partNumber: 2, lessonNumber: 1, lesson: unsafeLesson }];
    const railProgress = { ...progress, activeLessonId: unsafeLesson.id, activeBlockId: "repeat block?", blocks: [{ id: "repeat block?", type: "narrative", ready: true, active: true, completed: false, verified: false, emerged: true }] };
    const railMarkup = html(createElement(LessonRail, { title: "Workbook", chapters, progress: railProgress, viewedLessonId: unsafeLesson.id, setViewedLesson: vi.fn() }));
    const lessonMarkup = html(createElement(LessonView, { chapter: chapters[0] as Chapter & { lesson: typeof unsafeLesson }, progress: railProgress, refresh: vi.fn() }));

    expect(railMarkup).toContain('href="#lesson-part-two-lesson-two"');
    expect(lessonMarkup).toContain('id="lesson-part-two-lesson-two"');
    expect(railMarkup).toContain('href="#lesson-part-two-lesson-two-block-repeat-block-"');
    expect(lessonMarkup).toContain('id="lesson-part-two-lesson-two-block-repeat-block-"');
    expect(railMarkup).not.toContain('href="#repeat block?"');
  });

  it("renders resolved lesson reference links and the lesson header using the shared lesson anchor helper", () => {
    const targetId = "part/lesson-one";
    const referencedBlock = { ...lesson.blocks[0], markdown: `See [Lesson 1: Markdown Lesson](${lessonAnchorHref(targetId)}) for background.` };
    const referencedChapter = chapter({ lesson: { ...lesson, blocks: [referencedBlock] } });

    const markup = html(createElement(LessonView, { chapter: referencedChapter, progress, refresh: vi.fn() }));

    expect(markup).toContain('href="#lesson-part-lesson-one"');
    expect(markup).toContain('<header id="lesson-part-lesson-one">');
    expect(vi.mocked(lessonElementId)).toHaveBeenCalledWith(targetId);
  });

  it("does not let a completed lesson's duplicate narrative block continue the active lesson", () => {
    const oldChapter = chapter();
    const activeLesson = { ...lesson, id: "part/lesson-two", title: "Active Duplicate Lesson" };
    const activeChapter = chapter({ id: activeLesson.id, lessonNumber: 2, title: activeLesson.title, lesson: activeLesson });
    const duplicateProgress = progressWithActiveDuplicate("orientation");

    const completedMarkup = html(createElement(LessonView, { chapter: oldChapter, progress: duplicateProgress, refresh: vi.fn() }));
    const activeMarkup = html(createElement(LessonView, { chapter: activeChapter, progress: duplicateProgress, refresh: vi.fn() }));

    expect(completedMarkup).not.toContain('class="continuation-controls"');
    expect(completedMarkup).not.toContain('data-completion-action="continue"');
    expect(activeMarkup).toContain('class="continuation-controls"');
    expect(activeMarkup).toContain('data-completion-action="continue"');
  });

  it("renders a completed lesson's duplicate terminal block frozen instead of live", () => {
    const oldChapter = chapter();
    const activeLesson = { ...lesson, id: "part/lesson-two", title: "Active Duplicate Lesson" };
    const activeChapter = chapter({ id: activeLesson.id, lessonNumber: 2, title: activeLesson.title, lesson: activeLesson });
    const duplicateProgress = progressWithActiveDuplicate("practice");

    const completedMarkup = html(createElement(LessonView, { chapter: oldChapter, progress: duplicateProgress, refresh: vi.fn() }));
    const activeMarkup = html(createElement(LessonView, { chapter: activeChapter, progress: duplicateProgress, refresh: vi.fn() }));

    expect(completedMarkup).toContain("Frozen terminal session");
    expect(completedMarkup).not.toContain("Embedded terminal");
    expect(completedMarkup).not.toContain("Insert command");
    expect(activeMarkup).toContain("Embedded terminal");
    expect(activeMarkup).toContain("Insert command");
  });

  it("renders the active narrative timeline note with a manual Continue before the fixed composer", async () => {
    const state = {
      workbook: { title: "Workbook" },
      introduction: "Intro.",
      introductionComplete: true,
      chapters: [chapter()],
      progress,
      adapter: {},
      timeline: [{ type: "message", id: "course", sequence: 1, at: "2026-08-21T00:00:00.000Z", lessonId: lesson.id, blockId: "orientation", role: "assistant", source: "authored", presentation: "course", text: "## Orientation\n\nAuthored Orientation note." }]
    } as any;
    const continuedState = { ...state, progress: { ...progress, blocks: progress.blocks.map((block) => block.id === "orientation" ? { ...block, completed: true } : block) } };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => ({ ok: true, json: async () => init?.method === "POST" ? continuedState : state }));
    vi.stubGlobal("fetch", fetchMock);

    const container = await mount(createElement(App), stubAppShellGlobals);
    await act(async () => { await Promise.resolve(); });

    const text = container.textContent ?? "";
    expect(text).toContain("Authored Orientation note.");
    expect(text.indexOf("Authored Orientation note.")).toBeLessThan(text.indexOf("Continue"));
    expect(text.indexOf("Continue")).toBeLessThan(text.indexOf("Message the tutor"));

    const continueButton = [...container.querySelectorAll("button")].find((button) => button.textContent === "Continue")!;
    await act(async () => { continueButton.dispatchEvent(new window.MouseEvent("click", { bubbles: true })); });

    const eventCall = fetchMock.mock.calls.find(([url]) => url === "api/workbook/events");
    expect(eventCall).toBeTruthy();
    expect(JSON.parse((eventCall![1] as RequestInit).body as string)).toEqual({ blockId: "orientation", action: "continue" });
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
        { id: "transition", type: "lesson-transition", ready: false, active: false, completed: false, verified: false, emerged: false },
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

    const eventCall = fetchMock.mock.calls.find(([url]) => url === "api/workbook/events");
    expect(eventCall).toBeTruthy();
    expect(JSON.parse((eventCall![1] as RequestInit).body as string)).toEqual({ blockId: "orientation", action: "continue" });
    expect(container.textContent).toContain("Next");
  });

  it("posts a block hint from the sticky terminal/editor band and disables the hint button while pending", async () => {
    let resolveHint: ((value: any) => void) | undefined;
    const hintedState = {
      workbook: { title: "Workbook" },
      introduction: "Intro.",
      introductionComplete: true,
      chapters: [chapter({ lesson: { ...lesson, blocks: [editorBlock] } as any })],
      progress: activeEditorProgress(),
      adapter: {},
      timeline: [{ type: "message", id: "hint", sequence: 1, at: "2026-08-21T00:00:00.000Z", lessonId: lesson.id, blockId: editorBlock.id, role: "assistant", source: "block_tutor", presentation: "hint", text: "Check the requested marker." }]
    } as any;
    const initialState = { ...hintedState, timeline: [] };
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (input === "/api/workbook/hints") return new Promise((resolve) => { resolveHint = resolve; });
      return Promise.resolve({ ok: true, json: async () => init?.method === "POST" ? hintedState : initialState });
    });
    vi.stubGlobal("fetch", fetchMock);

    const container = await mount(createElement(App), stubAppShellGlobals);
    await act(async () => { await Promise.resolve(); });
    const hintButton = [...container.querySelectorAll("button")].filter((button) => button.textContent === "Get a hint");

    expect(hintButton).toHaveLength(1);
    act(() => { hintButton[0]!.dispatchEvent(new window.MouseEvent("click", { bubbles: true })); });
    expect(hintButton[0]!.disabled).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith("/api/workbook/hints", expect.objectContaining({ method: "POST" }));
    const hintCall = fetchMock.mock.calls.find(([url]) => url === "/api/workbook/hints")!;
    expect(JSON.parse((hintCall[1] as RequestInit).body as string)).toEqual({ blockId: editorBlock.id });

    await act(async () => {
      resolveHint!({ ok: true, json: async () => hintedState });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.textContent).toContain("Check the requested marker.");
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
      chapters: [chapter({ lesson: { ...lesson, blocks: [lesson.blocks[2]] } as any })],
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
    expect(container.querySelector(".timeline-input.fixed-composer")).not.toBeNull();
    const textarea = container.querySelector<HTMLTextAreaElement>(".timeline-input textarea")!;
    textarea.value = "My reflection answer";
    await act(async () => { textarea.dispatchEvent(new window.Event("input", { bubbles: true })); });
    const sendButton = [...container.querySelectorAll("button")].find((button) => button.textContent === "Send")!;
    await act(async () => { sendButton.dispatchEvent(new window.MouseEvent("click", { bubbles: true })); });

    const eventCall = fetchMock.mock.calls.find(([url]) => url === "api/workbook/events");
    expect(eventCall).toBeTruthy();
    expect(JSON.parse((eventCall![1] as RequestInit).body as string)).toEqual({ blockId: "reflect", action: "reflection-submit", response: "My reflection answer" });
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
      chapters: [chapter({ lesson: { ...lesson, blocks: [lesson.blocks[2]] } as any })],
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
    const sendButton = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Send")!;
    expect(textarea.disabled).toBe(true);
    expect(sendButton.disabled).toBe(true);
  });

  it("routes a second reflection message as a follow-up after quiet working state", async () => {
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
      chapters: [chapter({ lesson: { ...lesson, blocks: [lesson.blocks[2]] } as any })],
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
    const sendButton = [...container.querySelectorAll("button")].find((button) => button.textContent === "Send")!;
    await act(async () => { sendButton.dispatchEvent(new window.MouseEvent("click", { bubbles: true })); });

    const eventCall = fetchMock.mock.calls.find(([url]) => url === "api/workbook/events");
    expect(eventCall).toBeTruthy();
    expect(JSON.parse((eventCall![1] as RequestInit).body as string)).toEqual({ blockId: "reflect", action: "reflection-follow-up", response: "Second answer" });
  });
});
