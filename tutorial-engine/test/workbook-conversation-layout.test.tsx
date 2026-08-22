import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ActivityBand } from "../web-workbook/src/activity-band.js";
import { TimelineThread } from "../web-workbook/src/timeline-thread.js";
import type { Block, Progress } from "../web-workbook/src/workbook-ui.js";

const editorBlock: Block = {
  id: "edit-answer",
  type: "editor-practice",
  title: "Edit the answer",
  markdown: "Update the answer file.",
  path: "factory/answer.md"
};

const reflectionBlock: Block = {
  id: "reflect",
  type: "reflection",
  title: "Reflect",
  markdown: "What changed?"
};

const progress: Progress = {
  activeLessonId: "part/lesson",
  activeBlockId: editorBlock.id,
  completedLessons: [],
  blocks: [{ id: editorBlock.id, type: editorBlock.type, ready: true, active: true, completed: false, verified: false, emerged: true, editorStatus: "editing" }],
  unexpected: {},
  reflections: {},
  reflectionConversations: {}
};

describe("workbook fixed conversation layout", () => {
  it("places one sticky hint control with the live terminal/editor activity before the fixed composer thread", () => {
    const markup = renderToStaticMarkup(createElement("main", null,
      createElement(ActivityBand, { lessonId: "part/lesson", activeBlock: editorBlock, progress, refresh: vi.fn(), onHint: vi.fn(async () => undefined) }),
      createElement(TimelineThread, {
        activeBlockId: editorBlock.id,
        onSend: vi.fn(async () => undefined),
        onRetry: vi.fn(async () => undefined),
        records: [{ type: "message", id: "course", sequence: 1, at: "2026-08-21T00:00:00.000Z", lessonId: "part/lesson", blockId: editorBlock.id, role: "assistant", source: "authored", presentation: "course", text: "Course note" }]
      })
    ));

    expect(markup).toContain('class="current-activity-band"');
    expect(markup).toContain("Get a hint");
    expect(markup.match(/Get a hint/g)).toHaveLength(1);
    expect(markup.indexOf("current-activity-band")).toBeLessThan(markup.indexOf("timeline-thread"));
    expect(markup).toContain('class="timeline-thread has-fixed-composer"');
    expect(markup).toContain('class="timeline-input fixed-composer"');
    expect(markup).toContain("Message the tutor");
  });

  it("does not make reflections a sticky work surface", () => {
    const reflectionProgress: Progress = {
      ...progress,
      activeBlockId: reflectionBlock.id,
      blocks: [{ id: reflectionBlock.id, type: reflectionBlock.type, ready: true, active: true, completed: false, verified: false, emerged: true }]
    };

    const markup = renderToStaticMarkup(createElement(ActivityBand, {
      lessonId: "part/lesson",
      activeBlock: reflectionBlock,
      progress: reflectionProgress,
      refresh: vi.fn(),
      onHint: vi.fn(async () => undefined)
    }));

    expect(markup).toBe("");
  });

  it("keeps main tutor and block tutor messages left aligned as Tutor bubbles", () => {
    const markup = renderToStaticMarkup(createElement(TimelineThread, {
      activeBlockId: editorBlock.id,
      onSend: vi.fn(async () => undefined),
      onRetry: vi.fn(async () => undefined),
      records: [
        { type: "message", id: "main", sequence: 1, at: "2026-08-21T00:00:00.000Z", lessonId: "part/lesson", blockId: editorBlock.id, role: "assistant", source: "main_tutor", presentation: "chat", text: "Main reply" },
        { type: "message", id: "hint", sequence: 2, at: "2026-08-21T00:00:01.000Z", lessonId: "part/lesson", blockId: editorBlock.id, role: "assistant", source: "block_tutor", presentation: "hint", text: "Hint reply" },
        { type: "message", id: "learner", sequence: 3, at: "2026-08-21T00:00:02.000Z", lessonId: "part/lesson", blockId: editorBlock.id, role: "user", source: "learner", presentation: "chat", text: "Learner reply" }
      ]
    }));

    expect(markup).toContain('class="timeline-message tutor"');
    expect(markup).toContain('class="timeline-message tutor hint"');
    expect(markup).toContain('class="timeline-message learner"');
    expect(markup.match(/<b>Tutor<\/b>/g)).toHaveLength(2);
  });
});
