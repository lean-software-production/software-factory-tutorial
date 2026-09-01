import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { TimelineThread, computeTutorReplyRevealScrollDelta } from "../web-workbook/src/timeline-thread.js";

const noopSend = vi.fn(async () => undefined);

describe("TimelineThread", () => {
  it("distinguishes authored, tutor, learner, and review messages in chronological order", () => {
    const markup = renderToStaticMarkup(createElement(TimelineThread, {
      activeLessonId: "lesson",
      activeBlockId: "write",
      onSend: noopSend,
      records: [
        { type: "message", id: "1", sequence: 1, at: "2026-08-21T00:00:00.000Z", lessonId: "lesson", blockId: "write", role: "assistant", source: "authored", presentation: "course", text: "## Course note\n\nWrite the file." },
        { type: "message", id: "2", sequence: 2, at: "2026-08-21T00:00:01.000Z", lessonId: "lesson", blockId: "write", role: "user", source: "learner", presentation: "chat", text: "Which directory?" },
        { type: "message", id: "3", sequence: 3, at: "2026-08-21T00:00:02.000Z", lessonId: "lesson", blockId: "write", role: "assistant", source: "main_tutor", presentation: "review", text: "Use `.tmp`." },
      ]
    }));

    expect(markup).toContain('class="timeline-authored-content"');
    expect(markup).not.toContain('class="timeline-message authored"');
    expect(markup).toContain('class="timeline-message learner"');
    expect(markup).toContain('class="timeline-message tutor review"');
    expect(markup.indexOf("Course note")).toBeLessThan(markup.indexOf("Which directory?"));
    expect(markup).toContain("Tutor review");
  });

  it("renders main and block tutor public sources as Tutor bubbles and hides internal block tutor records", () => {
    const markup = renderToStaticMarkup(createElement(TimelineThread, {
      activeLessonId: "lesson",
      activeBlockId: "write",
      onSend: noopSend,
      records: [
        { type: "block_tutor_briefed", id: "brief", sequence: 1, at: "2026-08-21T00:00:00.000Z", lessonId: "lesson", blockId: "write", text: "Private briefing", coveredThroughId: "course" },
        { type: "block_tutor_readiness", id: "ready", sequence: 2, at: "2026-08-21T00:00:01.000Z", lessonId: "lesson", blockId: "write", attemptId: "attempt", readiness: "likely_ready", text: "Private readiness" },
        { type: "message", id: "main", sequence: 3, at: "2026-08-21T00:00:02.000Z", lessonId: "lesson", blockId: "write", role: "assistant", source: "main_tutor", presentation: "chat", text: "Main tutor reply" },
        { type: "message", id: "hint", sequence: 4, at: "2026-08-21T00:00:03.000Z", lessonId: "lesson", blockId: "write", role: "assistant", source: "main_tutor", presentation: "review", text: "Block tutor hint" },
      ] as any
    }));

    expect(markup).toContain('class="timeline-message tutor"');
    expect(markup).toContain('class="timeline-message tutor review"');
    expect(markup.match(/<b>Tutor(?: review)?<\/b>/g)).toHaveLength(2);
    expect(markup).toContain("Main tutor reply");
    expect(markup).toContain("Block tutor hint");
    expect(markup).not.toContain("Private briefing");
    expect(markup).not.toContain("Private readiness");
  });

  it("places a ready terminal practice surface under its own authored record", () => {
    const markup = renderToStaticMarkup(createElement(TimelineThread, {
      activeLessonId: "lesson",
      activeBlockId: "orientation",
      onSend: noopSend,
      practiceSurfaceBlockId: "practice",
      practiceSurface: createElement("output", { "aria-label": "Ready terminal canvas" }, "terminal canvas"),
      records: [
        { type: "message", id: "orientation", sequence: 1, at: "2026-08-21T00:00:00.000Z", lessonId: "lesson", blockId: "orientation", role: "assistant", source: "authored", presentation: "course", text: "## Orientation" },
        { type: "message", id: "practice", sequence: 2, at: "2026-08-21T00:00:01.000Z", lessonId: "lesson", blockId: "practice", role: "assistant", source: "authored", presentation: "course", text: "## Practice" },
      ]
    }));

    const orientationEnd = markup.indexOf("</section>");
    const practiceStart = markup.indexOf('id="practice"');
    const surface = markup.indexOf('aria-label="Ready terminal canvas"');
    expect(orientationEnd).toBeLessThan(practiceStart);
    expect(practiceStart).toBeLessThan(surface);
    expect(markup.match(/Ready terminal canvas/g)).toHaveLength(1);
  });

  it("places one matching practice history surface under its authored record while keeping the live surface under the current record", () => {
    const markup = renderToStaticMarkup(createElement(TimelineThread, {
      activeLessonId: "lesson",
      activeBlockId: "editor-b",
      onSend: noopSend,
      practiceSurfaceBlockId: "editor-b",
      practiceSurface: createElement("output", { "aria-label": "Live editor B" }, "live editor B"),
      renderPracticeHistory: (record) => record.blockId === "terminal-a"
        ? createElement("output", { "aria-label": "History terminal A" }, "history terminal A")
        : null,
      records: [
        { type: "message", id: "intro", sequence: 1, at: "2026-08-21T00:00:00.000Z", lessonId: "lesson", blockId: "intro", role: "assistant", source: "authored", presentation: "course", text: "## Intro" },
        { type: "message", id: "terminal-a", sequence: 2, at: "2026-08-21T00:00:01.000Z", lessonId: "lesson", blockId: "terminal-a", role: "assistant", source: "authored", presentation: "course", text: "## Terminal A" },
        { type: "message", id: "editor-b", sequence: 3, at: "2026-08-21T00:00:02.000Z", lessonId: "lesson", blockId: "editor-b", role: "assistant", source: "authored", presentation: "course", text: "## Editor B" },
      ]
    }));

    expect(markup.indexOf("Terminal A")).toBeLessThan(markup.indexOf("history terminal A"));
    expect(markup.indexOf("history terminal A")).toBeLessThan(markup.indexOf("Editor B"));
    expect(markup.indexOf("Editor B")).toBeLessThan(markup.indexOf("live editor B"));
    expect(markup.match(/History terminal A/g)).toHaveLength(1);
    expect(markup.match(/Live editor B/g)).toHaveLength(1);
    expect(markup).not.toContain("history intro");
  });

  it("uses the generic practice history seam once even if the renderer returns nodes for duplicate authored records", () => {
    const records = [
      { type: "message", id: "first", sequence: 1, at: "2026-08-21T00:00:00.000Z", lessonId: "lesson", blockId: "practice", role: "assistant", source: "authored", presentation: "course", text: "## Practice" },
      { type: "message", id: "duplicate", sequence: 2, at: "2026-08-21T00:00:01.000Z", lessonId: "lesson", blockId: "practice", role: "assistant", source: "authored", presentation: "course", text: "## Practice again" },
    ] as const;

    const markup = renderToStaticMarkup(createElement(TimelineThread, {
      activeLessonId: "lesson",
      activeBlockId: "next",
      onSend: noopSend,
      records,
      renderPracticeHistory: (record) => record.blockId === "practice"
        ? createElement("output", { "aria-label": `History for ${record.id}` }, "historical surface")
        : null,
    }));

    expect(markup.match(/historical surface/g)).toHaveLength(1);
  });

  it("only gives authored course records the Mermaid diagram path", () => {
    const diagram = "```mermaid\ngraph TD\n  A --> B\n```";
    const markup = renderToStaticMarkup(createElement(TimelineThread, {
      activeLessonId: "lesson",
      activeBlockId: "write",
      onSend: noopSend,
      records: [
        { type: "message", id: "course", sequence: 1, at: "2026-08-21T00:00:00.000Z", lessonId: "lesson", blockId: "write", role: "assistant", source: "authored", presentation: "course", text: diagram },
        { type: "message", id: "tutor", sequence: 2, at: "2026-08-21T00:00:01.000Z", lessonId: "lesson", blockId: "write", role: "assistant", source: "main_tutor", presentation: "chat", text: diagram },
      ]
    }));

    expect(markup).toContain('class="mermaid-diagram"');
    expect(markup).toContain('class="code-block"');
    expect(markup).toContain('aria-label="Copy code"');
  });

  it("uses the course compass only for authored lesson frames", () => {
    const lessonFrame = "# Build a doer\n\nA short dek.\n\n## What you will learn\n\n- Create a doer.\n\nIntroduction.";
    const markup = renderToStaticMarkup(createElement(TimelineThread, {
      activeLessonId: "lesson",
      activeBlockId: "lesson--lesson",
      onSend: noopSend,
      records: [
        { type: "message", id: "frame", sequence: 1, at: "2026-08-21T00:00:00.000Z", lessonId: "lesson--lesson", blockId: "lesson--lesson", role: "assistant", source: "authored", presentation: "course", text: lessonFrame },
        { type: "message", id: "block", sequence: 2, at: "2026-08-21T00:00:01.000Z", lessonId: "lesson--lesson", blockId: "lesson--lesson--note", role: "assistant", source: "authored", presentation: "course", text: lessonFrame },
      ] as any
    }));

    expect(markup.match(/class="course-compass"/g)).toHaveLength(1);
    expect(markup).toContain("<ul><li><p>Create a doer.</p></li></ul>");
    expect(markup).toContain("<ul>\n<li>Create a doer.</li>\n</ul>");
  });

  it("renders assistant chat, hint, and review text as Markdown instead of literal syntax", () => {
    const markup = renderToStaticMarkup(createElement(TimelineThread, {
      activeLessonId: "lesson",
      activeBlockId: "write",
      onSend: noopSend,
      records: [
        { type: "message", id: "chat", sequence: 1, at: "2026-08-21T00:00:00.000Z", lessonId: "lesson", blockId: "write", role: "assistant", source: "main_tutor", presentation: "chat", text: "Run `git status` and **check** the diff." },
        { type: "message", id: "hint", sequence: 2, at: "2026-08-21T00:00:01.000Z", lessonId: "lesson", blockId: "write", role: "assistant", source: "main_tutor", presentation: "review", text: "Try *this* next." },
        { type: "message", id: "review", sequence: 3, at: "2026-08-21T00:00:02.000Z", lessonId: "lesson", blockId: "write", role: "assistant", source: "main_tutor", presentation: "review", text: "Use `.tmp` for **scratch** files." },
      ]
    }));

    expect(markup).not.toContain("**check**");
    expect(markup).not.toContain("`git status`");
    expect(markup).not.toContain("*this*");
    expect(markup).not.toContain("**scratch**");
    expect(markup).toContain("<strong>check</strong>");
    expect(markup).toContain("<code>git status</code>");
    expect(markup).toContain("<em>this</em>");
    expect(markup).toContain("<strong>scratch</strong>");
  });

  it("keeps the tutor thinking status visible while an active reflection is reviewing only", () => {
    const records = [
      { type: "message", id: "course", sequence: 1, at: "2026-08-21T00:00:00.000Z", lessonId: "lesson", blockId: "reflect", role: "assistant", source: "authored", presentation: "course", text: "## Reflect\n\nWhy did it work?" },
      { type: "message", id: "learner", sequence: 2, at: "2026-08-21T00:00:01.000Z", lessonId: "lesson", blockId: "reflect", role: "user", source: "learner", presentation: "chat", text: "Because flow is visible." },
    ] as const;
    const reviewingMarkup = renderToStaticMarkup(createElement(TimelineThread, {
      activeLessonId: "lesson",
      activeBlockId: "reflect",
      onSend: noopSend,
      activeReflectionReviewing: true,
      records
    }));
    const acceptedMarkup = renderToStaticMarkup(createElement(TimelineThread, {
      activeLessonId: "lesson",
      activeBlockId: "reflect",
      onSend: noopSend,
      activeReflectionReviewing: false,
      records: [...records, { type: "message", id: "review", sequence: 3, at: "2026-08-21T00:00:02.000Z", lessonId: "lesson", blockId: "reflect", role: "assistant", source: "main_tutor", presentation: "review", text: "Accepted." }]
    }));

    expect(reviewingMarkup).toContain('role="status"');
    expect(reviewingMarkup).toContain('aria-label="Tutor is thinking"');
    expect(reviewingMarkup).toContain("Thinking");
    expect(acceptedMarkup).toContain("Tutor review");
    expect(acceptedMarkup).not.toContain('class="timeline-message tutor thinking"');
    expect(acceptedMarkup).not.toContain("Thinking");
  });

  describe("computeTutorReplyRevealScrollDelta", () => {
    it("keeps an already-visible reply stable above the fixed composer", () => {
      expect(computeTutorReplyRevealScrollDelta({
        replyTop: 220,
        replyBottom: 520,
        viewportHeight: 900,
        composerTop: 780,
        gapPx: 14,
      })).toBe(0);
    });

    it("moves a reply obscured by the composer by only the distance needed to reveal its bottom", () => {
      expect(computeTutorReplyRevealScrollDelta({
        replyTop: 650,
        replyBottom: 830,
        viewportHeight: 900,
        composerTop: 790,
        gapPx: 14,
      })).toBe(54);
    });
  });
});
