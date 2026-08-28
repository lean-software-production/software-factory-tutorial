import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureFreshWebBundle, inspectWebBundle } from "./support/web-bundle.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const BUILT_AT_MS = 1_700_000_000_000;

async function touch(path: string, mtimeMs: number): Promise<void> {
  await utimes(path, mtimeMs / 1000, mtimeMs / 1000);
}

/** An engine root shaped like tutorial-engine's: the sources vite reads, all modified at one time. */
async function engineRoot(sourcesAtMs: number): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "web-bundle-"));
  roots.push(root);
  await mkdir(join(root, "web-workbook", "src"), { recursive: true });
  await mkdir(join(root, "src", "workbook"), { recursive: true });
  const files = [
    [join(root, "web-workbook", "index.html"), "<!doctype html>"],
    [join(root, "web-workbook", "src", "main.tsx"), "export {};"],
    [join(root, "src", "workbook", "public-contract.ts"), "export {};"],
    [join(root, "vite.config.ts"), "export default {};"],
    [join(root, "package.json"), "{}"],
  ] as const;
  for (const [path, contents] of files) {
    await writeFile(path, contents);
    await touch(path, sourcesAtMs);
  }
  return root;
}

/** What `build:web:workbook` leaves behind, written at a known time. */
function buildBundle(root: string, builtAtMs: number): void {
  const directory = join(root, "dist", "web-workbook");
  mkdirSync(join(directory, "assets"), { recursive: true });
  for (const path of [join(directory, "index.html"), join(directory, "assets", "workbook.js")]) {
    writeFileSync(path, "built");
    utimesSync(path, builtAtMs / 1000, builtAtMs / 1000);
  }
}

describe("inspectWebBundle", () => {
  it("reports a bundle that was never built as missing", async () => {
    const root = await engineRoot(BUILT_AT_MS);

    const report = inspectWebBundle(root);

    expect(report.status).toBe("missing");
    expect(report.message).toContain("dist/web-workbook");
  });

  it("reports a bundle built after every source as fresh", async () => {
    const root = await engineRoot(BUILT_AT_MS - 60_000);
    buildBundle(root, BUILT_AT_MS);

    expect(inspectWebBundle(root).status).toBe("fresh");
  });

  it("names the source that outdates a stale bundle", async () => {
    const root = await engineRoot(BUILT_AT_MS - 60_000);
    buildBundle(root, BUILT_AT_MS);
    await touch(join(root, "web-workbook", "src", "main.tsx"), BUILT_AT_MS + 60_000);

    const report = inspectWebBundle(root);

    expect(report.status).toBe("stale");
    expect(report.changedSource).toBe(join("web-workbook", "src", "main.tsx"));
    expect(report.message).toContain("is stale");
  });

  it("notices a change under src/, which the bundle imports from", async () => {
    const root = await engineRoot(BUILT_AT_MS - 60_000);
    buildBundle(root, BUILT_AT_MS);
    await touch(join(root, "src", "workbook", "public-contract.ts"), BUILT_AT_MS + 60_000);

    expect(inspectWebBundle(root).status).toBe("stale");
  });

  it("dates the build by its oldest file, so a partly refreshed bundle still reads as stale", async () => {
    const root = await engineRoot(BUILT_AT_MS);
    buildBundle(root, BUILT_AT_MS - 60_000);
    await touch(join(root, "dist", "web-workbook", "index.html"), BUILT_AT_MS + 60_000);

    expect(inspectWebBundle(root).status).toBe("stale");
  });
});

describe("ensureFreshWebBundle", () => {
  it("does not build a fresh bundle, so npm run check builds it exactly once", async () => {
    const root = await engineRoot(BUILT_AT_MS - 60_000);
    buildBundle(root, BUILT_AT_MS);
    const builds: string[] = [];
    const lines: string[] = [];

    const report = ensureFreshWebBundle(root, { build: (target) => { builds.push(target); }, writeLine: (line) => { lines.push(line); } });

    expect(builds).toEqual([]);
    expect(lines).toEqual([]);
    expect(report.status).toBe("fresh");
  });

  it("builds a stale bundle once and then reports it fresh", async () => {
    const root = await engineRoot(BUILT_AT_MS + 60_000);
    buildBundle(root, BUILT_AT_MS);
    const builds: string[] = [];
    const lines: string[] = [];

    const report = ensureFreshWebBundle(root, {
      build: (target) => { builds.push(target); buildBundle(target, BUILT_AT_MS + 120_000); },
      writeLine: (line) => { lines.push(line); },
    });

    expect(builds).toEqual([root]);
    expect(report.status).toBe("fresh");
    expect(lines[0]).toContain("is stale");
  });

  it("builds a bundle that is missing altogether", async () => {
    const root = await engineRoot(BUILT_AT_MS);
    const builds: string[] = [];

    const report = ensureFreshWebBundle(root, {
      build: (target) => { builds.push(target); buildBundle(target, BUILT_AT_MS + 60_000); },
      writeLine: () => {},
    });

    expect(builds).toEqual([root]);
    expect(report.status).toBe("fresh");
  });

  it("throws rather than serving a bundle the build left stale", async () => {
    const root = await engineRoot(BUILT_AT_MS + 60_000);
    buildBundle(root, BUILT_AT_MS);

    expect(() => ensureFreshWebBundle(root, { build: () => {}, writeLine: () => {} }))
      .toThrow(/still not current after building it/);
  });
});
