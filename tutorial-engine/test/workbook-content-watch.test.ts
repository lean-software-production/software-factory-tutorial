import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isAuthoredWorkbookMarkdown, watchWorkbookContent, type ContentWatchFactory } from "../src/workbook/content-watch.js";

const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function rootFixture() {
  const root = await mkdtemp(resolve(tmpdir(), "workbook-watch-"));
  roots.push(root);
  await mkdir(resolve(root, "parts/nested"), { recursive: true });
  await mkdir(resolve(root, "lessons/001-first/blocks"), { recursive: true });
  await mkdir(resolve(root, "factory"), { recursive: true });
  await writeFile(resolve(root, "workbook.md"), "---\n---\n# Workbook\n");
  await writeFile(resolve(root, "parts/loop.md"), "---\n---\n# Part\n");
  await writeFile(resolve(root, "parts/nested/extra.md"), "---\n---\n# Extra\n");
  await writeFile(resolve(root, "lessons/001-first/lesson.md"), "---\nblocks: []\n---\n# Lesson\n\nDek.\n");
  await writeFile(resolve(root, "lessons/001-first/blocks/one.md"), "---\ntype: narrative\n---\n## One\n\nText.\n");
  return root;
}

function fakeWatchFactory() {
  const listeners = new Map<string, (eventType: string, filename: string | Buffer | null) => void>();
  const closed: string[] = [];
  const factory: ContentWatchFactory = (path, listener) => {
    listeners.set(path, listener);
    return { close: () => closed.push(path) };
  };
  return { factory, listeners, closed, emit: (dir: string, filename: string | null) => listeners.get(dir)?.("change", filename) };
}

describe("workbook content watch", () => {
  it("recognizes only authored Markdown locations", () => {
    const root = "/tutorial";
    expect(isAuthoredWorkbookMarkdown(root, "/tutorial/workbook.md")).toBe(true);
    expect(isAuthoredWorkbookMarkdown(root, "/tutorial/parts/loop.md")).toBe(true);
    expect(isAuthoredWorkbookMarkdown(root, "/tutorial/parts/nested/loop.md")).toBe(true);
    expect(isAuthoredWorkbookMarkdown(root, "/tutorial/lessons/001/lesson.md")).toBe(true);
    expect(isAuthoredWorkbookMarkdown(root, "/tutorial/lessons/001/blocks/a.md")).toBe(true);
    expect(isAuthoredWorkbookMarkdown(root, "/tutorial/.tutorial/session/workbook.md")).toBe(false);
    expect(isAuthoredWorkbookMarkdown(root, "/tutorial/factory/refactor.md")).toBe(false);
    expect(isAuthoredWorkbookMarkdown(root, "/tutorial/calculator/README.md")).toBe(false);
    expect(isAuthoredWorkbookMarkdown(root, "/tutorial/lessons/001/notes.md")).toBe(false);
    expect(isAuthoredWorkbookMarkdown(root, "/tutorial/lessons/001/blocks/a.md.swp")).toBe(false);
  });

  it("debounces coalesced authored Markdown events and ignores unrelated files", async () => {
    vi.useFakeTimers();
    const root = await rootFixture();
    const fake = fakeWatchFactory();
    const onChange = vi.fn();
    const watch = watchWorkbookContent(root, onChange, vi.fn(), { watchFactory: fake.factory, debounceMs: 150 });
    await watch.rescan();

    fake.emit(root, "README.md");
    fake.emit(root, "factory");
    await vi.advanceTimersByTimeAsync(200);
    expect(onChange).not.toHaveBeenCalled();

    fake.emit(root, "workbook.md");
    fake.emit(resolve(root, "lessons/001-first/blocks"), "one.md");
    await vi.advanceTimersByTimeAsync(149);
    expect(onChange).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onChange).toHaveBeenCalledTimes(1);
    watch.close();
  });

  it("rescans so newly added lesson and block directories are observed", async () => {
    vi.useFakeTimers();
    const root = await rootFixture();
    const fake = fakeWatchFactory();
    const onChange = vi.fn();
    const watch = watchWorkbookContent(root, onChange, vi.fn(), { watchFactory: fake.factory, debounceMs: 10 });
    await watch.rescan();
    expect(fake.listeners.has(resolve(root, "lessons/002-second/blocks"))).toBe(false);

    await mkdir(resolve(root, "lessons/002-second/blocks"), { recursive: true });
    await writeFile(resolve(root, "lessons/002-second/lesson.md"), "---\nblocks:\n  - two\n---\n# Second\n\nDek.\n");
    await writeFile(resolve(root, "lessons/002-second/blocks/two.md"), "---\ntype: narrative\n---\n## Two\n\nText.\n");
    await watch.rescan();
    expect(fake.listeners.has(resolve(root, "lessons/002-second"))).toBe(true);
    expect(fake.listeners.has(resolve(root, "lessons/002-second/blocks"))).toBe(true);

    fake.emit(resolve(root, "lessons/002-second/blocks"), "two.md");
    await vi.advanceTimersByTimeAsync(10);
    expect(onChange).toHaveBeenCalledTimes(1);
    watch.close();
  });

  it("close removes subscriptions and prevents later callbacks", async () => {
    vi.useFakeTimers();
    const root = await rootFixture();
    const fake = fakeWatchFactory();
    const onChange = vi.fn();
    const watch = watchWorkbookContent(root, onChange, vi.fn(), { watchFactory: fake.factory, debounceMs: 10 });
    await watch.rescan();
    expect(fake.listeners.size).toBeGreaterThan(0);
    watch.close();
    expect(fake.closed.length).toBe(fake.listeners.size);
    fake.emit(root, "workbook.md");
    await vi.advanceTimersByTimeAsync(20);
    expect(onChange).not.toHaveBeenCalled();
  });
});
