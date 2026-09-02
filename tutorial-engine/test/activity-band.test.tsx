import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActivityBand } from "../web-workbook/src/activity-band.js";
import type { Block, Progress } from "../web-workbook/src/workbook-ui.js";

const workbookStylesPath = fileURLToPath(new URL("../web-workbook/src/styles.css", import.meta.url));
const activityBandSourcePath = fileURLToPath(new URL("../web-workbook/src/activity-band.tsx", import.meta.url));

const editorBlock: Block = {
  id: "edit-answer",
  type: "editor-practice",
  title: "Edit the answer",
  markdown: "Update the answer file.",
  path: "factory/answer.md"
};

const activeEditorProgress: Progress = {
  activeLessonId: "part/lesson",
  activeBlockId: editorBlock.id,
  completedLessons: [],
  blocks: [{ id: editorBlock.id, type: editorBlock.type, ready: true, active: true, completed: false, verified: true, emerged: true, editorStatus: "editing" } as any],
  reflections: {},
  reflectionConversations: {}
};

const terminalBlock: Block = {
  id: "run-command",
  type: "terminal-practice",
  title: "Run the command",
  markdown: "Run the command."
};

const activeTerminalProgress: Progress = {
  activeLessonId: "part/lesson",
  activeBlockId: terminalBlock.id,
  completedLessons: [],
  blocks: [{ id: terminalBlock.id, type: terminalBlock.type, ready: true, active: true, completed: false, verified: true, emerged: true } as any],
  reflections: {},
  reflectionConversations: {}
};

let dom: JSDOM | undefined;
let root: Root | undefined;

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = undefined;
  dom?.window.close();
  dom = undefined;
  vi.unstubAllGlobals();
});

async function mount(element: ReturnType<typeof createElement>, setup?: (window: JSDOM["window"]) => void) {
  dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", { url: "http://localhost/workbook" });
  vi.stubGlobal("window", dom.window as unknown as Window & typeof globalThis);
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("Window", dom.window.Window);
  vi.stubGlobal("MutationObserver", dom.window.MutationObserver);
  Object.defineProperty(dom.window, "requestAnimationFrame", { value: (callback: FrameRequestCallback) => { const handle = dom!.window.setTimeout(() => callback(Date.now()), 0); return Number(handle); }, configurable: true });
  Object.defineProperty(dom.window, "cancelAnimationFrame", { value: (handle: number) => dom!.window.clearTimeout(handle), configurable: true });
  Object.defineProperty(dom.window, "matchMedia", { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }), configurable: true });
  class DefaultFakeWebSocket { static OPEN = 1; readyState = DefaultFakeWebSocket.OPEN; addEventListener() {} send() {} close() {} }
  vi.stubGlobal("WebSocket", DefaultFakeWebSocket);
  vi.stubGlobal("addEventListener", dom.window.addEventListener.bind(dom.window) as any);
  vi.stubGlobal("removeEventListener", dom.window.removeEventListener.bind(dom.window) as any);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setup?.(dom.window);
  const container = dom.window.document.getElementById("root")!;
  root = createRoot(container);
  await act(async () => { root!.render(element); });
  return container;
}

describe("ActivityBand stability", () => {
  it("is a sticky surface whose geometry the stylesheet fixes, never the scroll position", () => {
    const workbookStyles = readFileSync(workbookStylesPath, "utf8");
    const source = readFileSync(activityBandSourcePath, "utf8");

    // One declaration owns the band's shape: sticky at the top, the column's width, and an editor
    // that scrolls inside its own box so the band never outgrows the window.
    expect(workbookStyles).toMatch(/\.current-activity-band\s*\{[^}]*position:\s*sticky;[^}]*top:\s*0;[^}]*width:\s*min\(720px, 100%\);/);
    expect(workbookStyles).toMatch(/\.current-activity-band \.editor-surface \.cm-scroller\s*\{[^}]*max-height:\s*min\(48vh, 420px\);[^}]*overflow-y:\s*auto;/);
    // The scroll-linked expansion is gone: no measured variables, no transitions that animated them.
    expect(workbookStyles).not.toContain("--activity-");
    const bandRules = workbookStyles.match(/\.current-activity-band[^{}]*\{[^}]*\}/g) ?? [];
    expect(bandRules.join("\n")).not.toContain("transition");
    expect(bandRules.join("\n")).not.toContain("transform");
    // And the component reads nothing from the viewport to produce that shape.
    expect(source).not.toContain("scrollY");
    expect(source).not.toContain("getBoundingClientRect");
    expect(source).not.toContain("ResizeObserver");
    expect(source).not.toContain("IntersectionObserver");
  });

  it("renders the editor as a sticky band that never restyles itself on scroll or takes focus", async () => {
    const focusCalls: string[] = [];
    class FakeResizeObserver {
      static instances = 0;
      constructor() { FakeResizeObserver.instances += 1; }
      observe() {}
      disconnect() {}
    }
    const container = await mount(createElement(ActivityBand, {
      lessonId: "part/lesson",
      activeBlock: editorBlock,
      progress: activeEditorProgress,
      refresh: vi.fn()
    }), (window) => {
      // CodeMirror keeps its own observers for its measurements; the band creates none. The
      // resize observer is defined on the window alone, which is where the band used to look.
      Object.defineProperty(window, "ResizeObserver", { value: FakeResizeObserver, configurable: true });
      window.HTMLElement.prototype.focus = function () { focusCalls.push(this.className); };
    });

    const band = container.querySelector<HTMLElement>(".current-activity-band")!;
    expect(band.getAttribute("data-activity-type")).toBe("editor-practice");
    expect(band.getAttribute("data-activity-layout")).toBe("sticky");
    expect(band.getAttribute("style")).toBeNull();
    expect(FakeResizeObserver.instances).toBe(0);

    await act(async () => { dom!.window.dispatchEvent(new dom!.window.Event("scroll")); });
    await act(async () => { dom!.window.dispatchEvent(new dom!.window.Event("resize")); });
    expect(band.getAttribute("style")).toBeNull();
    expect(focusCalls).toEqual([]);
  });

  it("lets a terminal band keep its fit observer but never watches the viewport for itself", async () => {
    const listenerTypes: string[] = [];
    class FakeIntersectionObserver {
      static instances = 0;
      constructor() { FakeIntersectionObserver.instances += 1; }
      observe() {}
      disconnect() {}
    }
    const container = await mount(createElement(ActivityBand, {
      lessonId: "part/lesson",
      activeBlock: terminalBlock,
      progress: activeTerminalProgress,
      refresh: vi.fn()
    }), (window) => {
      vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
      vi.stubGlobal("location", window.location);
      const addEventListener = window.addEventListener.bind(window) as (type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => void;
      window.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
        listenerTypes.push(type);
        addEventListener(type, listener, options);
      }) as typeof window.addEventListener;
    });

    const band = container.querySelector<HTMLElement>(".current-activity-band")!;
    expect(band.getAttribute("data-activity-type")).toBe("terminal-practice");
    expect(band.getAttribute("data-activity-layout")).toBe("sticky");
    expect(listenerTypes).not.toContain("scroll");
    expect(FakeIntersectionObserver.instances).toBe(0);
  });

  it("keeps accepted-but-incomplete editor and terminal practice live in the sticky band", async () => {
    const acceptedEditorProgress: Progress = {
      ...activeEditorProgress,
      blocks: [{ id: editorBlock.id, type: editorBlock.type, ready: false, active: true, completed: false, verified: true, emerged: true, revision: 1, draftText: "accepted editor draft", editorStatus: "accepted", checkpoint: { status: "accepted", successMessage: "Editor accepted.", evidence: { kind: "editor", text: "accepted editor draft" } } } as any],
    };
    const editorContainer = await mount(createElement(ActivityBand, {
      lessonId: "part/lesson",
      activeBlock: editorBlock,
      progress: acceptedEditorProgress,
      refresh: vi.fn()
    }));

    expect(editorContainer.querySelector(".current-activity-band")?.getAttribute("data-activity-type")).toBe("editor-practice");
    expect(editorContainer.querySelector(".editor-live-surface")).toBeTruthy();
    expect(editorContainer.querySelector("[role='textbox']")?.getAttribute("contenteditable")).toBe("true");
    expect(editorContainer.textContent).toContain("Editor accepted.");

    await act(async () => { root!.unmount(); });
    root = undefined;

    const acceptedTerminalProgress: Progress = {
      ...activeTerminalProgress,
      blocks: [{ id: terminalBlock.id, type: terminalBlock.type, ready: false, active: true, completed: false, verified: true, emerged: true, terminal: { phase: "accepted", message: "Terminal accepted." } } as any],
    };
    class FakeWebSocket {
      static OPEN = 1;
      readyState = FakeWebSocket.OPEN;
      addEventListener() {}
      send() {}
      close() {}
    }
    const terminalContainer = await mount(createElement(ActivityBand, {
      lessonId: "part/lesson",
      activeBlock: terminalBlock,
      progress: acceptedTerminalProgress,
      refresh: vi.fn()
    }), (window) => {
      vi.stubGlobal("WebSocket", FakeWebSocket);
      vi.stubGlobal("location", window.location);
      vi.stubGlobal("addEventListener", window.addEventListener.bind(window) as any);
      vi.stubGlobal("removeEventListener", window.removeEventListener.bind(window) as any);
    });

    expect(terminalContainer.querySelector(".current-activity-band")?.getAttribute("data-activity-type")).toBe("terminal-practice");
    expect(terminalContainer.querySelector(".terminal-live-surface")).toBeTruthy();
    expect(terminalContainer.querySelector(".embedded-terminal")).toBeTruthy();
    expect(terminalContainer.textContent).toContain("Terminal accepted.");
    expect(terminalContainer.querySelector(".terminal-history")).toBeNull();
  });
});
