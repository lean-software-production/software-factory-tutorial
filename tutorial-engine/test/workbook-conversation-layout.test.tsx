import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
  reflections: {},
  reflectionConversations: {}
};

const workbookStyles = readFileSync(fileURLToPath(new URL("../web-workbook/src/styles.css", import.meta.url)), "utf8");
const workbookUiSource = readFileSync(fileURLToPath(new URL("../web-workbook/src/workbook-ui.tsx", import.meta.url)), "utf8");

function declarationsFor(selector: string, occurrence: "first" | "last" = "first") {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = [...workbookStyles.matchAll(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, "g"))];
  return (occurrence === "last" ? matches.at(-1) : matches[0])?.[1] ?? "";
}

describe("workbook fixed conversation layout", () => {
  it("places the live terminal/editor activity before the fixed composer thread without a hint control", () => {
    const markup = renderToStaticMarkup(createElement("main", null,
      createElement(ActivityBand, { lessonId: "part/lesson", activeBlock: editorBlock, progress, refresh: vi.fn() }),
      createElement(TimelineThread, {
        activeLessonId: "part/lesson",
        activeBlockId: editorBlock.id,
        onSend: vi.fn(async () => undefined),
        onRetry: vi.fn(async () => undefined),
        records: [{ type: "message", id: "course", sequence: 1, at: "2026-08-21T00:00:00.000Z", lessonId: "part/lesson", blockId: editorBlock.id, role: "assistant", source: "authored", presentation: "course", text: "Course note" }]
      })
    ));

    expect(markup).toContain('class="current-activity-band"');
    expect(markup).toContain('data-activity-layout="scroll-linked"');
    expect(markup).not.toContain("Get a hint");
    expect(markup.indexOf("current-activity-band")).toBeLessThan(markup.indexOf("timeline-thread"));
    expect(markup).toContain('class="timeline-thread has-fixed-composer"');
    expect(markup).toContain('class="timeline-input fixed-composer"');
    expect(markup).toContain("Message the tutor");
  });

  it("uses measured CSS variables instead of binary width or viewport centering hacks", () => {
    const inlineBand = (workbookStyles.match(/\.current-activity-band\s*\{[^}]*--activity-expand[^}]*\}/)?.[0] ?? "").split("{")[1] ?? "";
    const visualWorkBlock = declarationsFor(".current-activity-band > .work-block");
    const activityBandRules = workbookStyles.match(/\.current-activity-band[^{}]*\{[^}]*\}/g) ?? [];

    expect(inlineBand).toContain("--activity-expand: 0");
    expect(inlineBand).toContain("--activity-expanded-width: var(--activity-inline-width)");
    expect(inlineBand).toContain("width: var(--activity-inline-width)");
    expect(inlineBand).toContain("top: var(--activity-top)");
    expect(visualWorkBlock).toContain("position: relative");
    expect(visualWorkBlock).toContain("left: var(--activity-left-offset)");
    expect(visualWorkBlock).toContain("width: var(--activity-width)");
    expect(inlineBand).toContain("padding: 0");
    expect(inlineBand).toContain("border: 0");
    expect(activityBandRules.join("\n")).not.toContain("margin-left");
    expect(activityBandRules.join("\n")).not.toContain("transform");
  });

  it("uses larger readable code and terminal font sizes without a code header row", () => {
    const codeBlock = declarationsFor(".code-block");
    const copyButton = declarationsFor(".copy-code");
    const codePre = declarationsFor(".code-block pre");
    const terminalElement = declarationsFor(".embedded-terminal");

    expect(workbookUiSource).toContain("fontSize: 16");
    expect(codeBlock).toContain("position: relative");
    expect(copyButton).toContain("position: absolute");
    expect(copyButton).toContain("right: 9px");
    expect(codePre).toContain("font: 1rem/1.65");
    expect(terminalElement).toContain("height: 180px");
    expect(terminalElement).toContain("padding: 6px 6px 18px");
    expect(terminalElement).toContain("overflow: hidden");
  });

  it("visually attaches terminal feedback to the terminal bottom instead of overlaying output", () => {
    const terminalSurface = declarationsFor(".terminal-live-surface");
    const terminalWithFeedback = declarationsFor(".terminal-live-surface.has-feedback .embedded-terminal-panel");
    const feedbackPanel = declarationsFor(".terminal-feedback-overlay");
    const feedbackMarkdownBody = declarationsFor(".live-block-feedback .markdown p, .live-block-feedback .markdown ul, .live-block-feedback .markdown ol");
    const feedbackMarkdownTail = declarationsFor(".live-block-feedback .markdown > :last-child");

    expect(terminalSurface).toContain("position: relative");
    expect(terminalWithFeedback).toContain("border-bottom: 0");
    expect(terminalWithFeedback).toContain("border-radius: 9px 9px 0 0");
    expect(feedbackPanel).toContain("margin: 0 0 12px");
    expect(feedbackPanel).toContain("border-radius: 0 0 9px 9px");
    expect(feedbackMarkdownBody).toContain("font: inherit");
    expect(feedbackMarkdownTail).toContain("margin-bottom: 0");
    expect(feedbackPanel).not.toContain("position: absolute");
    expect(feedbackPanel).not.toContain("bottom:");
    expect(feedbackPanel).not.toContain("left:");
    expect(feedbackPanel).not.toContain("max-height");
    expect(feedbackPanel).not.toContain("overflow");
    expect(feedbackPanel).not.toContain("backdrop-filter");
    expect(feedbackPanel).not.toContain("blur");
  });

  it("attaches editor feedback to the editor bottom the same way the terminal does", () => {
    const editorSurface = declarationsFor(".editor-live-surface");
    const editorWithFeedback = declarationsFor(".editor-live-surface.has-feedback .editor-surface");
    const feedbackPanel = declarationsFor(".editor-feedback-overlay");

    expect(editorSurface).toContain("position: relative");
    expect(editorWithFeedback).toContain("border-bottom: 0");
    expect(editorWithFeedback).toContain("border-radius: 9px 9px 0 0");
    expect(feedbackPanel).toContain("margin: 0 0 12px");
    expect(feedbackPanel).toContain("border-radius: 0 0 9px 9px");
    // The green advice palette means accepted; feedback asks for a revision, so both practice
    // blocks use the same informational treatment.
    expect(feedbackPanel).not.toContain("var(--green-pale)");
    expect(feedbackPanel).not.toContain("position: absolute");
  });

  it("drops the editor's own card inside the band, where the terminal has none", () => {
    // Outside the band the card gives the editor an identity. Inside it the authored content is
    // suppressed, so the card is chrome the terminal does not draw around the same activity.
    const inBandEditor = declarationsFor(".current-activity-band > .editor-practice");

    expect(inBandEditor).toContain("padding: 0");
    expect(inBandEditor).toContain("border: 0");
    expect(inBandEditor).toContain("box-shadow: none");
    expect(inBandEditor).toContain("outline: 0");
    // The card itself still exists for the inline rendering.
    expect(declarationsFor(".editor-practice")).toContain("padding: 31px");
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
      refresh: vi.fn()
    }));

    expect(markup).toBe("");
  });

  it("keeps main tutor and block tutor messages left aligned as Tutor bubbles", () => {
    const markup = renderToStaticMarkup(createElement(TimelineThread, {
      activeLessonId: "part/lesson",
      activeBlockId: editorBlock.id,
      onSend: vi.fn(async () => undefined),
      onRetry: vi.fn(async () => undefined),
      records: [
        { type: "message", id: "main", sequence: 1, at: "2026-08-21T00:00:00.000Z", lessonId: "part/lesson", blockId: editorBlock.id, role: "assistant", source: "main_tutor", presentation: "chat", text: "Main reply" },
        { type: "message", id: "hint", sequence: 2, at: "2026-08-21T00:00:01.000Z", lessonId: "part/lesson", blockId: editorBlock.id, role: "assistant", source: "main_tutor", presentation: "review", text: "Hint reply" },
        { type: "message", id: "learner", sequence: 3, at: "2026-08-21T00:00:02.000Z", lessonId: "part/lesson", blockId: editorBlock.id, role: "user", source: "learner", presentation: "chat", text: "Learner reply" }
      ]
    }));

    expect(markup).toContain('class="timeline-message tutor"');
    expect(markup).toContain('class="timeline-message tutor review"');
    expect(markup).toContain('class="timeline-message learner"');
    expect(markup.match(/<b>Tutor(?: review)?<\/b>/g)).toHaveLength(2);
  });
});
