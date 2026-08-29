import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActivityBand } from "../web-workbook/src/activity-band.js";
import type { Block, Progress } from "../web-workbook/src/workbook-ui.js";

const terminalTransitionStylesPath = fileURLToPath(new URL("../web-workbook/src/activity-band.css", import.meta.url));
const workbookStylesPath = fileURLToPath(new URL("../web-workbook/src/styles.css", import.meta.url));
const mainSourcePath = fileURLToPath(new URL("../web-workbook/src/main.tsx", import.meta.url));

const editorBlock: Block = {
  id: "edit-answer",
  type: "editor-practice",
  title: "Edit the answer",
  markdown: "Update the answer file.",
  path: "factory/answer.md"
};

const completedEditorProgress: Progress = {
  activeLessonId: "part/lesson",
  activeBlockId: editorBlock.id,
  completedLessons: [],
  blocks: [{ id: editorBlock.id, type: editorBlock.type, ready: true, active: true, completed: true, verified: true, emerged: true, editorStatus: "unlocked" }],
  reflections: {},
  reflectionConversations: {}
};

const terminalBlock: Block = {
  id: "run-command",
  type: "terminal-practice",
  title: "Run the command",
  markdown: "Run the command."
};

const completedTerminalProgress: Progress = {
  activeLessonId: "part/lesson",
  activeBlockId: terminalBlock.id,
  completedLessons: [],
  blocks: [{ id: terminalBlock.id, type: terminalBlock.type, ready: true, active: true, completed: true, verified: true, emerged: true }],
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
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setup?.(dom.window);
  const container = dom.window.document.getElementById("root")!;
  root = createRoot(container);
  await act(async () => { root!.render(element); });
  return container;
}

function rect(left: number, width: number, top = 300) {
  return { left, width, top } as DOMRect;
}

describe("ActivityBand stability", () => {
  it("keeps terminal and editor practice sticky and scroll-linked while terminal work-block transitions stay disabled", () => {
    expect(existsSync(terminalTransitionStylesPath)).toBe(true);
    const terminalStyles = readFileSync(terminalTransitionStylesPath, "utf8");
    const workbookStyles = readFileSync(workbookStylesPath, "utf8");
    const mainSource = readFileSync(mainSourcePath, "utf8");

    expect(mainSource).toContain('import "./activity-band.css"');
    expect(terminalStyles).not.toMatch(/\.current-activity-band\[data-activity-type="terminal-practice"\]\s*\{/);
    expect(terminalStyles).toMatch(/\.current-activity-band\[data-activity-type="terminal-practice"\]\s*>\s*\.work-block\s*\{[^}]*transition:\s*none;/);
    expect(workbookStyles).toMatch(/\.current-activity-band\s*\{[^}]*position:\s*sticky;[^}]*top:\s*0;/);
    expect(workbookStyles).toMatch(/\.current-activity-band\s*\{[^}]*top:\s*var\(--activity-top\);/);
    expect(workbookStyles).toMatch(/\.current-activity-band\s*>\s*\.work-block\s*\{[^}]*left:\s*var\(--activity-left-offset\);[^}]*width:\s*var\(--activity-width\);[^}]*transition:\s*left 80ms linear, width 80ms linear;/);
  });

  it("does not auto-focus terminal practice but keeps editor auto-focus", async () => {
    class FakeIntersectionObserver {
      static instances: FakeIntersectionObserver[] = [];
      observed: Element[] = [];
      constructor(_callback: IntersectionObserverCallback) { FakeIntersectionObserver.instances.push(this); }
      observe(element: Element) { this.observed.push(element); }
      disconnect() {}
    }

    const container = await mount(createElement(ActivityBand, {
      lessonId: "part/lesson",
      activeBlock: terminalBlock,
      progress: completedTerminalProgress,
      refresh: vi.fn()
    }), () => vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver));

    expect(FakeIntersectionObserver.instances).toHaveLength(0);

    await act(async () => { root!.render(createElement(ActivityBand, {
      lessonId: "part/lesson",
      activeBlock: editorBlock,
      progress: completedEditorProgress,
      refresh: vi.fn()
    })); });

    expect(FakeIntersectionObserver.instances).toHaveLength(1);
    expect(FakeIntersectionObserver.instances[0]!.observed).toEqual([container.querySelector(".current-activity-band")]);
  });

  it("registers terminal practice for scroll-linked geometry and expands as the band rises", async () => {
    class FakeResizeObserver {
      static instances: FakeResizeObserver[] = [];
      observed: Element[] = [];
      constructor(private readonly callback: ResizeObserverCallback) { FakeResizeObserver.instances.push(this); }
      observe(element: Element) { this.observed.push(element); }
      disconnect() {}
      trigger(target: Element) {
        this.callback([{ target } as ResizeObserverEntry], this as unknown as ResizeObserver);
      }
    }

    const listenerTypes: string[] = [];
    let viewportScrollY = 0;
    const container = await mount(createElement("main", null,
      createElement("div", { "data-inline-source": "" }),
      createElement(ActivityBand, {
        lessonId: "part/lesson",
        activeBlock: terminalBlock,
        progress: completedTerminalProgress,
        refresh: vi.fn()
      })
    ), (window) => {
      Object.defineProperty(window, "ResizeObserver", { value: FakeResizeObserver, configurable: true });
      Object.defineProperty(window, "requestAnimationFrame", { value: (callback: FrameRequestCallback) => { callback(0); return 1; }, configurable: true });
      Object.defineProperty(window, "scrollY", { get: () => viewportScrollY, configurable: true });
      const addEventListener = window.addEventListener.bind(window) as (type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => void;
      window.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
        listenerTypes.push(type);
        addEventListener(type, listener, options);
      }) as typeof window.addEventListener;
    });

    const main = container.querySelector<HTMLElement>("main")!;
    const inlineSource = container.querySelector("[data-inline-source]")!;
    const band = container.querySelector<HTMLElement>(".current-activity-band")!;
    const observer = FakeResizeObserver.instances[0]!;
    Object.defineProperty(main, "offsetTop", { value: 80, configurable: true });
    Object.defineProperty(band, "offsetTop", { value: 240, configurable: true });
    Object.defineProperty(band, "offsetParent", { value: main, configurable: true });
    Object.defineProperty(main, "getBoundingClientRect", { value: () => rect(100, 1000), configurable: true });
    Object.defineProperty(inlineSource, "getBoundingClientRect", { value: () => rect(240, 720), configurable: true });

    expect(FakeResizeObserver.instances).toHaveLength(1);
    expect(observer.observed).toContain(inlineSource);
    expect(observer.observed).toContain(main);
    expect(listenerTypes).toContain("scroll");
    expect(listenerTypes).toContain("resize");
    expect(band.getAttribute("data-activity-layout")).toBe("scroll-linked");

    await act(async () => { observer.trigger(inlineSource); });
    expect(band.style.getPropertyValue("--activity-expand")).toBe("0.000");
    expect(band.style.getPropertyValue("--activity-width")).toBe("720px");

    viewportScrollY = 320;
    await act(async () => { dom!.window.dispatchEvent(new dom!.window.Event("scroll")); });
    expect(band.style.getPropertyValue("--activity-expand")).toBe("1.000");
    expect(band.style.getPropertyValue("--activity-width")).toBe("952px");
  });

  it("observes the inline source and main, but never the band whose feedback can change height", async () => {
    class FakeResizeObserver {
      static instances: FakeResizeObserver[] = [];
      observed: Element[] = [];
      constructor(private readonly callback: ResizeObserverCallback) { FakeResizeObserver.instances.push(this); }
      observe(element: Element) { this.observed.push(element); }
      disconnect() {}
      trigger(target: Element) {
        this.callback([{ target } as ResizeObserverEntry], this as unknown as ResizeObserver);
      }
    }

    const container = await mount(createElement("main", null,
      createElement("div", { "data-inline-source": "" }),
      createElement(ActivityBand, {
        lessonId: "part/lesson",
        activeBlock: editorBlock,
        progress: completedEditorProgress,
        refresh: vi.fn()
      })
    ), (window) => {
      Object.defineProperty(window, "ResizeObserver", { value: FakeResizeObserver, configurable: true });
      Object.defineProperty(window, "requestAnimationFrame", { value: (callback: FrameRequestCallback) => { callback(0); return 1; }, configurable: true });
    });

    const main = container.querySelector("main")!;
    const inlineSource = container.querySelector("[data-inline-source]")!;
    const band = container.querySelector<HTMLElement>(".current-activity-band")!;
    let mainRect = rect(100, 1000);
    let inlineRect = rect(240, 720);
    let bandRect = rect(240, 720);
    Object.defineProperty(main, "getBoundingClientRect", { value: () => mainRect, configurable: true });
    Object.defineProperty(inlineSource, "getBoundingClientRect", { value: () => inlineRect, configurable: true });
    Object.defineProperty(band, "getBoundingClientRect", { value: () => bandRect, configurable: true });

    const observer = FakeResizeObserver.instances[0]!;
    expect(FakeResizeObserver.instances).toHaveLength(1);
    expect(observer.observed).toContain(inlineSource);
    expect(observer.observed).toContain(main);
    expect(observer.observed).not.toContain(band);

    await act(async () => { observer.trigger(inlineSource); });
    expect(band.style.getPropertyValue("--activity-inline-width")).toBe("720px");
    expect(band.style.getPropertyValue("--activity-expanded-width")).toBe("952px");

    inlineRect = rect(240, 680);
    await act(async () => { observer.trigger(inlineSource); });
    expect(band.style.getPropertyValue("--activity-inline-width")).toBe("680px");
    expect(band.style.getPropertyValue("--activity-width")).toBe("680px");

    mainRect = rect(100, 900);
    await act(async () => { observer.trigger(main); });
    expect(band.style.getPropertyValue("--activity-expanded-width")).toBe("852px");
    expect(band.style.getPropertyValue("--activity-canvas-center")).toBe("550px");

    // A feedback insertion can grow the band, but it is not an observed sizing source.
    bandRect = rect(240, 720, 500);
    expect(observer.observed).not.toContain(band);
  });
});
