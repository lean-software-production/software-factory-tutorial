import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalBlockInView, READING_LINE_TOP_PX, readySuccessorCrossedReadingLine, subscribeViewport } from "../web-workbook/src/reading-line.js";
import type { PublicWorkbookState } from "../src/workbook/public-contract.js";

let dom: JSDOM | undefined;

afterEach(() => {
  dom?.window.close();
  dom = undefined;
  vi.unstubAllGlobals();
});

function stubDom(html: string) {
  dom = new JSDOM(html, { url: "http://localhost/workbook" });
  vi.stubGlobal("window", dom.window as unknown as Window & typeof globalThis);
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("addEventListener", dom.window.addEventListener.bind(dom.window) as any);
  vi.stubGlobal("removeEventListener", dom.window.removeEventListener.bind(dom.window) as any);
  return dom.window;
}

describe("subscribeViewport", () => {
  it("coalesces scroll and resize events into one frame when frames exist", () => {
    const win = stubDom("<!doctype html><html><body></body></html>");
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
    const onFrame = vi.fn();

    const unsubscribe = subscribeViewport(onFrame);
    win.dispatchEvent(new win.Event("scroll"));
    win.dispatchEvent(new win.Event("scroll"));
    win.dispatchEvent(new win.Event("resize"));
    expect(onFrame).not.toHaveBeenCalled();
    expect(frames).toHaveLength(1);

    frames[0]!(0);
    expect(onFrame).toHaveBeenCalledTimes(1);

    win.dispatchEvent(new win.Event("scroll"));
    expect(frames).toHaveLength(2);
    unsubscribe();
    win.dispatchEvent(new win.Event("scroll"));
    expect(frames).toHaveLength(2);
  });

  it("answers synchronously where there are no animation frames", () => {
    const win = stubDom("<!doctype html><html><body></body></html>");
    vi.stubGlobal("requestAnimationFrame", undefined);
    const onFrame = vi.fn();

    const unsubscribe = subscribeViewport(onFrame);
    win.dispatchEvent(new win.Event("scroll"));
    expect(onFrame).toHaveBeenCalledTimes(1);
    unsubscribe();
  });
});

describe("reading line", () => {
  it("completes the predecessor once the ready successor's top reaches the line", () => {
    expect(readySuccessorCrossedReadingLine(READING_LINE_TOP_PX + 1)).toBe(false);
    expect(readySuccessorCrossedReadingLine(READING_LINE_TOP_PX)).toBe(true);
    expect(readySuccessorCrossedReadingLine(-400)).toBe(true);
  });

  it("names the revealed block under the line with hysteresis so the answer does not flicker", () => {
    const win = stubDom('<!doctype html><html><body><section id="one"></section><section id="two"></section></body></html>');
    const tops = { one: 0, two: 180 };
    win.document.getElementById("one")!.getBoundingClientRect = () => ({ top: tops.one } as DOMRect);
    win.document.getElementById("two")!.getBoundingClientRect = () => ({ top: tops.two } as DOMRect);
    const state = { progress: { activeBlockId: "two", blocks: [] }, revealedBlockIds: ["one", "two"], orderedBlocks: [{ id: "one" }, { id: "two" }] } as unknown as PublicWorkbookState;

    expect(canonicalBlockInView(state)).toBe("one");
    tops.two = 109;
    expect(canonicalBlockInView(state, "one")).toBe("one");
    tops.two = 108;
    expect(canonicalBlockInView(state, "one")).toBe("two");
    tops.two = 131;
    expect(canonicalBlockInView(state, "two")).toBe("two");
    tops.two = 132;
    expect(canonicalBlockInView(state, "two")).toBe("one");
  });
});
