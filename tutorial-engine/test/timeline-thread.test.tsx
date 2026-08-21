import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { TimelineThread } from "../web-workbook/src/timeline-thread.js";

describe("TimelineThread", () => {
  it("distinguishes authored, tutor, learner, and review messages in chronological order", () => {
    const markup = renderToStaticMarkup(createElement(TimelineThread, {
      activeBlockId: "write",
      onSend: vi.fn(async () => undefined),
      onRetry: vi.fn(async () => undefined),
      records: [
        { type: "message", id: "1", sequence: 1, at: "2026-08-21T00:00:00.000Z", lessonId: "lesson", blockId: "write", role: "assistant", source: "authored", presentation: "course", text: "## Course note\n\nWrite the file." },
        { type: "message", id: "2", sequence: 2, at: "2026-08-21T00:00:01.000Z", lessonId: "lesson", blockId: "write", role: "user", source: "learner", presentation: "chat", text: "Which directory?" },
        { type: "message", id: "3", sequence: 3, at: "2026-08-21T00:00:02.000Z", lessonId: "lesson", blockId: "write", role: "assistant", source: "tutor", presentation: "review", text: "Use `.tmp`." },
      ]
    }));

    expect(markup).toContain('class="timeline-message authored"');
    expect(markup).toContain('class="timeline-message learner"');
    expect(markup).toContain('class="timeline-message tutor review"');
    expect(markup.indexOf("Course note")).toBeLessThan(markup.indexOf("Which directory?"));
    expect(markup).toContain("Tutor review");
  });
});
