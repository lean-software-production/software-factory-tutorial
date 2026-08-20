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
    { id: "practice", type: "terminal-practice", title: "Practice", markdown: "Run this:\n\n```sh\necho hi \\\n  | cat\n```", tutor: "private practice guidance" },
    { id: "reflect", type: "reflection", title: "Reflect", markdown: "Why did it work?", tutor: "private reflection prompt" },
    { id: "transition", type: "lesson-transition", title: "Next", markdown: "Continue to **lesson two**." },
  ],
};

function html(element: ReturnType<typeof createElement>) {
  return renderToStaticMarkup(element);
}

describe("workbook lesson UI", () => {
  it("renders the Markdown manifest lesson header, fixed outcomes section, and ordered Markdown blocks", () => {
    const markup = html(createElement(LessonView, { chapter: { id: lesson.id, part: "Part One", partMarkdown: "Part copy.", partNumber: 1, lessonNumber: 1, title: lesson.title, lesson }, progress, refresh: vi.fn() }));

    expect(markup).toContain("<h1>Markdown Lesson</h1>");
    expect(markup).toContain("Dek paragraph.");
    expect(markup).toContain("14 min");
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

  it("keeps embedded terminal as the only terminal path and inserts only authored shell fences", () => {
    const activeTerminalProgress = { ...progress, activeBlockId: "practice", blocks: progress.blocks.map((block) => ({ ...block, active: block.id === "practice", ready: true, emerged: true })) };
    const withCommand = html(createElement(BlockView, { block: lesson.blocks[1], progress: activeTerminalProgress, refresh: vi.fn() }));
    expect(withCommand).toContain("Embedded terminal");
    expect(withCommand).toContain("Insert command");
    expect(withCommand).not.toContain("Use your own terminal");
    expect(withCommand).not.toContain("fallback");

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
});
