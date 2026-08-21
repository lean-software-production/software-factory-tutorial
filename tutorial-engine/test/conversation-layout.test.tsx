import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ActivityBand } from "../web-workbook/src/activity-band.js";
import { TimelineThread } from "../web-workbook/src/timeline-thread.js";
import type { Block, Progress } from "../web-workbook/src/workbook-ui.js";

const terminalBlock: Block = {
  id: "run-command",
  type: "terminal-practice",
  title: "Run the command",
  markdown: "Run the command in the terminal."
};

const progress: Progress = {
  activeLessonId: "part/lesson",
  activeBlockId: terminalBlock.id,
  completedLessons: [],
  blocks: [{ id: terminalBlock.id, type: terminalBlock.type, ready: true, active: true, completed: false, verified: false, emerged: true }],
  unexpected: {},
  reflections: {},
  reflectionConversations: {}
};

describe("workbook conversation layout", () => {
  it("places the sticky live activity before the chronological thread", () => {
    const band = createElement(ActivityBand, { lessonId: "part/lesson", activeBlock: terminalBlock, progress, refresh: vi.fn() });
    const thread = createElement(TimelineThread, {
      activeBlockId: terminalBlock.id,
      onSend: vi.fn(async () => undefined),
      onRetry: vi.fn(async () => undefined),
      records: [{ type: "message", id: "course", sequence: 1, at: "2026-08-21T00:00:00.000Z", lessonId: "part/lesson", blockId: terminalBlock.id, role: "assistant", source: "authored", presentation: "course", text: "Course note" }]
    });
    const markup = renderToStaticMarkup(createElement("main", null, band, thread));

    expect(markup).toContain('class="current-activity-band"');
    expect(markup).toContain("Embedded terminal");
    expect(markup.indexOf("current-activity-band")).toBeLessThan(markup.indexOf("timeline-thread"));
  });

  it("keeps authored and tutor messages left while learner messages use the learner alignment class", () => {
    const markup = renderToStaticMarkup(createElement(TimelineThread, {
      activeBlockId: terminalBlock.id,
      onSend: vi.fn(async () => undefined),
      onRetry: vi.fn(async () => undefined),
      records: [
        { type: "message", id: "course", sequence: 1, at: "2026-08-21T00:00:00.000Z", lessonId: "part/lesson", blockId: terminalBlock.id, role: "assistant", source: "authored", presentation: "course", text: "Course note" },
        { type: "message", id: "tutor", sequence: 2, at: "2026-08-21T00:00:01.000Z", lessonId: "part/lesson", blockId: terminalBlock.id, role: "assistant", source: "tutor", presentation: "chat", text: "Tutor reply" },
        { type: "message", id: "learner", sequence: 3, at: "2026-08-21T00:00:02.000Z", lessonId: "part/lesson", blockId: terminalBlock.id, role: "user", source: "learner", presentation: "chat", text: "Learner reply" }
      ]
    }));

    expect(markup).toContain('class="timeline-message authored"');
    expect(markup).toContain('class="timeline-message tutor"');
    expect(markup).toContain('class="timeline-message learner"');
  });
});
