/**
 * Scroll-ownership telemetry for real-browser tests.
 *
 * The workbook's scroll defects were never about one scroll call: they were about several owners
 * moving the viewport for their own reasons, and a stylesheet that changed layout in response.
 * A screenshot shows where the page ended up; it cannot say who moved it. This probe can. It wraps
 * every entry point that moves the window — `scrollIntoView`, `scrollTo`, `scrollBy`, `focus` —
 * and records the scroll events that follow, so a test can state the owner of every movement in
 * a recorded journey and assert that nothing but the learner and the one navigation authority
 * moved the page.
 *
 * Install it before navigation with `installScrollTelemetry(page)`; read it back with
 * `readScrollTelemetry(page, sinceIndex)`. Harness scrolls (the test positioning the page) can be
 * marked with `harnessScrollTo(page, top)` so they are distinguishable from the application's own.
 */
import type { Page } from "playwright";

export type ScrollTelemetryKind =
  | "scroll-event"
  | "scrollIntoView"
  | "window.scrollTo"
  | "window.scrollBy"
  | "element.scrollTo"
  | "element.scrollBy"
  | "focus"
  | "hashchange";

export interface ScrollTelemetryEntry {
  readonly index: number;
  readonly atMs: number;
  readonly kind: ScrollTelemetryKind;
  readonly scrollX: number;
  readonly scrollY: number;
  /** Compact description of the element that was scrolled, focused, or emitted the event. */
  readonly target?: string;
  /** The call's arguments, for programmatic scrolls. */
  readonly options?: unknown;
  /** Who set `note` on the window when the call happened — "harness" for the test's own scrolls. */
  readonly note?: string;
  /** A trimmed stack for programmatic calls. Minified bundles leave only file:line, which is still enough to tell library from application code apart across runs. */
  readonly caller?: string;
}

export const SCROLL_TELEMETRY_GLOBAL = "__workbookScrollTelemetry";
export const SCROLL_TELEMETRY_NOTE_GLOBAL = "__workbookScrollTelemetryNote";

const initScript = `(() => {
  // tsx/esbuild wraps arrow functions in a __name helper that Playwright's serialized evaluate
  // callbacks then reference inside the page; every browser harness here needs this shim.
  if (typeof globalThis.__name !== "function") globalThis.__name = (value) => value;
  const log = [];
  Object.defineProperty(window, ${JSON.stringify(SCROLL_TELEMETRY_GLOBAL)}, { value: log, configurable: true });
  const describe = (element) => {
    if (element === window) return "window";
    if (element === document) return "document";
    if (!(element instanceof Element)) return String(element);
    const classes = typeof element.className === "string" && element.className ? "." + element.className.trim().split(/\\s+/).slice(0, 3).join(".") : "";
    return element.tagName.toLowerCase() + (element.id ? "#" + element.id : "") + classes;
  };
  const push = (entry) => {
    log.push(Object.assign({ index: log.length, atMs: Math.round(performance.now()), scrollX: Math.round(window.scrollX), scrollY: Math.round(window.scrollY), note: window[${JSON.stringify(SCROLL_TELEMETRY_NOTE_GLOBAL)}] }, entry));
  };
  const caller = () => (new Error().stack || "").split("\\n").slice(2, 6).map((line) => line.trim()).join(" | ");
  const cloneArgument = (value) => value && typeof value === "object" ? Object.assign({}, value) : value;
  const wrap = (owner, name, kind, describeSelf) => {
    const original = owner[name];
    if (typeof original !== "function") return;
    owner[name] = function (...args) {
      push({ kind, target: describeSelf ? describe(this) : undefined, options: args.map(cloneArgument), caller: caller() });
      return original.apply(this, args);
    };
  };
  wrap(Element.prototype, "scrollIntoView", "scrollIntoView", true);
  wrap(Element.prototype, "scrollTo", "element.scrollTo", true);
  wrap(Element.prototype, "scrollBy", "element.scrollBy", true);
  wrap(window, "scrollTo", "window.scrollTo", false);
  wrap(window, "scrollBy", "window.scrollBy", false);
  wrap(HTMLElement.prototype, "focus", "focus", true);
  window.addEventListener("scroll", (event) => push({ kind: "scroll-event", target: describe(event.target) }), { capture: true, passive: true });
  window.addEventListener("hashchange", () => push({ kind: "hashchange", target: location.hash }));
})();`;

export async function installScrollTelemetry(page: Page): Promise<void> {
  await page.addInitScript(initScript);
}

export async function readScrollTelemetry(page: Page, sinceIndex = 0): Promise<ScrollTelemetryEntry[]> {
  return page.evaluate(({ globalName, since }) => {
    const log = (window as unknown as Record<string, ScrollTelemetryEntry[] | undefined>)[globalName] ?? [];
    return log.slice(since);
  }, { globalName: SCROLL_TELEMETRY_GLOBAL, since: sinceIndex });
}

export async function scrollTelemetryLength(page: Page): Promise<number> {
  return page.evaluate((globalName) => ((window as unknown as Record<string, unknown[] | undefined>)[globalName] ?? []).length, SCROLL_TELEMETRY_GLOBAL);
}

/** An instant scroll issued by the test itself, marked so it is never mistaken for the application's. */
export async function harnessScrollTo(page: Page, top: number): Promise<void> {
  await page.evaluate(({ noteName, target }) => {
    const host = window as unknown as Record<string, unknown>;
    host[noteName] = "harness";
    try { window.scrollTo({ top: target, left: window.scrollX, behavior: "instant" }); }
    finally { host[noteName] = undefined; }
  }, { noteName: SCROLL_TELEMETRY_NOTE_GLOBAL, target: top });
}

/** Window scroll events that were not the immediate result of a harness scroll. */
export function applicationScrollEvents(entries: readonly ScrollTelemetryEntry[]): ScrollTelemetryEntry[] {
  let harnessTarget: number | undefined;
  const result: ScrollTelemetryEntry[] = [];
  for (const entry of entries) {
    if (entry.note === "harness" && entry.kind === "window.scrollTo") {
      const options = (entry.options as Array<{ top?: number } | number> | undefined)?.[0];
      harnessTarget = typeof options === "number" ? options : options?.top;
      continue;
    }
    if (entry.kind !== "scroll-event" || entry.target !== "document") continue;
    if (harnessTarget !== undefined && Math.abs(entry.scrollY - harnessTarget) < 1) { harnessTarget = undefined; continue; }
    result.push(entry);
  }
  return result;
}

/** Programmatic scroll calls made by the application, excluding the harness's own. */
export function applicationScrollCalls(entries: readonly ScrollTelemetryEntry[]): ScrollTelemetryEntry[] {
  return entries.filter((entry) => entry.kind !== "scroll-event" && entry.kind !== "hashchange" && entry.kind !== "focus" && entry.note !== "harness");
}

/** The largest distance the window moved from `fromScrollY` across the given entries. */
export function maxScrollExcursion(entries: readonly ScrollTelemetryEntry[], fromScrollY: number): number {
  return entries.reduce((max, entry) => entry.kind === "scroll-event" && entry.target === "document" ? Math.max(max, Math.abs(entry.scrollY - fromScrollY)) : max, 0);
}
