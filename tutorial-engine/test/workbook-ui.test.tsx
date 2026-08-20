import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { BlockView, LessonRail, LessonView, type Chapter, type Progress } from "../web-workbook/src/workbook-ui.js";

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

describe("workbook lesson UI", () => {
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
