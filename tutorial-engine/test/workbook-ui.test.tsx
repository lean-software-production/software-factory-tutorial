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

import { BlockView, LessonRail, LessonView, scrollActiveLessonIntoView, type Chapter, type Progress } from "../web-workbook/src/workbook-ui.js";

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

async function mount(element: ReturnType<typeof createElement>) {
  dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", { url: "http://localhost/workbook" });
  vi.stubGlobal("window", dom.window as any);
  vi.stubGlobal("document", dom.window.document as any);
  vi.stubGlobal("HTMLElement", dom.window.HTMLElement as any);
  vi.stubGlobal("Event", dom.window.Event as any);
  vi.stubGlobal("CustomEvent", dom.window.CustomEvent as any);
  vi.stubGlobal("MutationObserver", dom.window.MutationObserver as any);
  vi.stubGlobal("navigator", dom.window.navigator as any);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = dom.window.document.getElementById("root")!;
  mountedRoot = createRoot(container);
  await act(async () => { mountedRoot!.render(element); });
  return container;
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

    expect(markup).toContain('<header id="lesson-part-lesson-one"><h1>Markdown Lesson</h1><p class="dek">Dek paragraph.</p><div class="lesson-meta"><span class="chip duration">14 min</span></div></header>');
    expect(markup).not.toContain('class="eyebrow"');
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
});
