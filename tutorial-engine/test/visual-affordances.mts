#!/usr/bin/env npx tsx
/**
 * Real-browser validation for the workbook's scroll-driven visual affordances.
 *
 * JSDOM has no layout engine, so the unit tests can only exercise the geometry maths against
 * fabricated rects and assert the stylesheet as a string. Neither notices if the selector stops
 * matching, a later rule wins, or the scroll listener never fires. This harness serves the built
 * workbook UI to Chromium and measures what a learner would actually see.
 *
 *   npx tsx test/visual-affordances.mts             validate
 *   npx tsx test/visual-affordances.mts --update    rewrite the golden masters
 */
import { createReadStream } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { extname, resolve } from "node:path";

const webRoot = resolve(import.meta.dirname, "../dist/web-workbook");
const baselineRoot = resolve(import.meta.dirname, "visual/baselines");
const outputRoot = resolve(import.meta.dirname, ".tmp/visual");
const updating = process.argv.includes("--update");
const mime: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };

/** A differing pixel must differ by more than this per channel; antialiasing moves by less. */
const CHANNEL_TOLERANCE = 12;
/** Share of pixels allowed to differ before a golden master counts as changed. */
const PIXEL_BUDGET = 0.005;

const failures: string[] = [];
function check(condition: boolean, description: string): void {
  if (!condition) failures.push(description);
}
function expectClose(actual: number, expected: number, slack: number, description: string): void {
  check(Math.abs(actual - expected) <= slack, `${description}: expected ~${expected} (±${slack}), measured ${actual}`);
}

const paragraphs = (count: number, word: string) =>
  Array.from({ length: count }, (_, index) => `${word} paragraph ${index + 1}. ${"Filler prose to make the page scroll. ".repeat(6)}`).join("\n\n");

const lesson = {
  id: "01-visual/01-affordances",
  title: "Affordance lesson",
  dek: "A lesson tall enough to scroll.",
  durationMinutes: 5,
  outcomes: ["Exercise the scroll-driven affordances."],
  blocks: [
    { id: "orientation", type: "narrative", title: "Orientation", markdown: paragraphs(6, "Orientation") },
    { id: "practice", type: "terminal-practice", title: "Practice", markdown: "Run this:\n\n```sh\necho affordance\n```" },
  ],
};

type Stage = "intro" | "orientation" | "practice";
let sequence = 0;
const authored = (lessonId: string, blockId: string, text: string) => ({
  type: "message" as const, id: `record-${blockId}`, sequence: sequence++, at: "2026-01-01T00:00:00.000Z",
  lessonId, blockId, role: "assistant" as const, source: "authored" as const, presentation: "course" as const, text,
});

function state(stage: Stage) {
  const past = stage !== "intro";
  const practising = stage === "practice";
  return {
    workbook: { title: "Affordance workbook" },
    introduction: "Introduction to the affordance workbook.",
    introductionComplete: past,
    timeline: [
      authored("workbook--introduction", "workbook--introduction", "# Affordance workbook\n\nIntroduction to the affordance workbook."),
      ...(past ? [
        authored(lesson.id, "orientation", `## Orientation\n\n${paragraphs(6, "Orientation")}`),
        authored(lesson.id, "practice", "## Practice\n\nRun this:\n\n```sh\necho affordance\n```"),
      ] : []),
    ],
    // The runway is the spacer that makes the successor reachable: without it the page cannot
    // scroll far enough for the next block to cross the reading line.
    readyBlockIds: past && !practising ? ["practice"] : [],
    chapters: [{ id: lesson.id, title: lesson.title, part: "Part 1", partMarkdown: "# Part 1", partNumber: 1, lessonNumber: 1, lesson: past ? lesson : undefined }],
    progress: {
      activeLessonId: past ? lesson.id : "workbook--introduction",
      activeBlockId: practising ? "practice" : past ? "orientation" : "workbook--introduction",
      completedLessons: [],
      blocks: [
        { id: "orientation", type: "narrative", ready: true, active: past && !practising, completed: practising, verified: false, emerged: past },
        // Ready while orientation is active: the reading line watches the ready successor, and
        // completes the active block when that successor crosses it.
        { id: "practice", type: "terminal-practice", ready: past, active: practising, completed: false, verified: false, emerged: practising },
      ],
      reflections: {},
      reflectionConversations: {},
    },
    adapter: { modelBackedHelp: false, note: "Visual harness server." },
  };
}

function sendJson(response: ServerResponse, body: unknown): void {
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

/**
 * Compare in the browser we already have running, so validating a golden master needs no image
 * dependency: both PNGs go onto canvases and the pixel arrays are differenced.
 */
async function compareGolden(page: any, name: string, shot: Buffer): Promise<void> {
  await mkdir(outputRoot, { recursive: true });
  await writeFile(resolve(outputRoot, `${name}.png`), shot);
  const baselinePath = resolve(baselineRoot, `${name}.png`);
  if (updating) {
    await mkdir(baselineRoot, { recursive: true });
    await writeFile(baselinePath, shot);
    console.log(`  updated golden master ${name}.png`);
    return;
  }
  let baseline: Buffer;
  try { baseline = await readFile(baselinePath); }
  catch {
    failures.push(`${name}: no golden master yet — review test/.tmp/visual/${name}.png, then re-run with --update`);
    return;
  }
  const verdict = await page.evaluate(async ([a, b, tolerance]: [string, string, number]) => {
    const load = (data: string) => new Promise<HTMLImageElement>((done, fail) => {
      const image = new Image();
      image.onload = () => done(image); image.onerror = fail; image.src = `data:image/png;base64,${data}`;
    });
    const [expected, actual] = await Promise.all([load(a), load(b)]);
    if (expected.width !== actual.width || expected.height !== actual.height) {
      return { sizeMismatch: `${actual.width}x${actual.height} vs golden ${expected.width}x${expected.height}`, ratio: 1 };
    }
    const pixels = (image: HTMLImageElement) => {
      const canvas = document.createElement("canvas");
      canvas.width = image.width; canvas.height = image.height;
      canvas.getContext("2d")!.drawImage(image, 0, 0);
      return canvas.getContext("2d")!.getImageData(0, 0, image.width, image.height).data;
    };
    const [left, right] = [pixels(expected), pixels(actual)];
    let differing = 0;
    for (let index = 0; index < left.length; index += 4) {
      if (Math.abs(left[index] - right[index]) > tolerance
        || Math.abs(left[index + 1] - right[index + 1]) > tolerance
        || Math.abs(left[index + 2] - right[index + 2]) > tolerance) differing++;
    }
    return { sizeMismatch: undefined, ratio: differing / (left.length / 4) };
  }, [baseline.toString("base64"), shot.toString("base64"), CHANNEL_TOLERANCE]);

  if (verdict.sizeMismatch) failures.push(`${name}: screenshot is ${verdict.sizeMismatch}. Compare test/.tmp/visual/${name}.png`);
  else if (verdict.ratio > PIXEL_BUDGET) failures.push(`${name}: ${(verdict.ratio * 100).toFixed(2)}% of pixels changed (budget ${(PIXEL_BUDGET * 100).toFixed(2)}%). Compare test/.tmp/visual/${name}.png, then re-run with --update to accept`);
}

async function main(): Promise<void> {
  try { await access(resolve(webRoot, "index.html")); }
  catch { throw new Error("Build the workbook UI first: npm run --workspace=tutorial-engine build:web:workbook"); }
  const moduleName = "playwright";
  let playwright: { chromium: { launch(options?: unknown): Promise<any> } };
  try { playwright = await import(moduleName) as typeof playwright; }
  catch { throw new Error("Visual validation needs Playwright. Install it with `npm install --no-save -D playwright`, then `npx playwright install chromium`."); }

  let stage: Stage = "intro";
  const completions: string[] = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/api/workbook/state") return sendJson(response, state(stage));
    if (request.method === "POST" && url.pathname === "/api/workbook/introduction") { stage = "orientation"; return sendJson(response, state(stage)); }
    if (request.method === "POST" && url.pathname === "/api/workbook/complete-block") {
      let body = ""; for await (const chunk of request) body += String(chunk);
      const blockId = (JSON.parse(body || "{}") as { blockId?: string }).blockId ?? "";
      completions.push(blockId);
      if (blockId === "workbook--introduction") stage = "orientation";
      if (blockId === "orientation") stage = "practice";
      return sendJson(response, state(stage));
    }
    if (url.pathname.startsWith("/api/")) { response.writeHead(404).end(); return; }
    const candidate = resolve(webRoot, `.${url.pathname === "/" ? "/index.html" : url.pathname}`);
    if (!candidate.startsWith(webRoot)) { response.writeHead(403).end(); return; }
    try { await access(candidate); } catch { response.writeHead(404).end(); return; }
    response.writeHead(200, { "Content-Type": mime[extname(candidate)] ?? "application/octet-stream" });
    createReadStream(candidate).pipe(response);
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not start the visual harness server.");

  const browser = await playwright.chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1, reducedMotion: "reduce" });
    // tsx compiles with esbuild's keepNames, which references a __name helper. Functions handed to
    // page.evaluate are serialized without it, so provide it inside the page.
    await page.addInitScript(() => { (globalThis as unknown as { __name: unknown }).__name = (value: unknown) => value; });
    await page.goto(`http://127.0.0.1:${address.port}`);
    // Golden masters compare pixels, so nothing may still be easing when the shot is taken.
    await page.addStyleTag({ content: "*, *::before, *::after { transition: none !important; animation: none !important; caret-color: transparent !important; }" });
    await page.getByRole("heading", { name: "Affordance workbook" }).waitFor();
    await page.getByRole("button", { name: "Ready to continue" }).click();
    await page.getByRole("heading", { name: "Orientation" }).waitFor();

    // ---- Affordance 1: the reading line promotes the block it passes -------------------------
    await page.evaluate(() => window.scrollTo(0, 0));
    check(!completions.includes("orientation"), "reading line: orientation completed before it reached the reading line");
    // The observer watches the ready successor, not the active block: when the successor's top
    // crosses READING_LINE_TOP_PX (120), the block the learner has scrolled past is completed.
    const successorTop = await page.evaluate(() => {
      const element = document.getElementById("practice");
      return element ? element.getBoundingClientRect().top + window.scrollY : null;
    });
    check(successorTop !== null, "reading line: no #practice successor element to scroll past the line");
    await page.evaluate((target) => window.scrollTo(0, target), (successorTop ?? 0) - 60);
    const promoted = await page.waitForFunction(() => Boolean(document.querySelector(".current-activity-band")), undefined, { timeout: 10_000 })
      .then(() => true)
      .catch(() => { failures.push("reading line: scrolling the successor past the line did not promote the practice block"); return false; });
    check(completions.includes("orientation"), "reading line: crossing the line did not post complete-block for orientation");

    // ---- Affordance 2: the activity band expands as it rises ---------------------------------
    // Without promotion there is no band to measure; report that once rather than timing out on
    // every locator below it.
    if (promoted) {
    const layout = await page.evaluate(() => {
      const band = document.querySelector(".current-activity-band") as HTMLElement;
      let top = 0; let current: HTMLElement | null = band;
      while (current) { top += current.offsetTop; current = current.offsetParent as HTMLElement | null; }
      return { bandDocumentTop: top };
    });
    const measure = async () => page.evaluate(() => {
      const band = document.querySelector(".current-activity-band") as HTMLElement | null;
      const main = document.querySelector("main") as HTMLElement | null;
      const work = band?.querySelector(".work-block")?.getBoundingClientRect();
      if (!band || !main || !work) return null;
      const mainRect = main.getBoundingClientRect();
      return {
        expand: Number(getComputedStyle(band).getPropertyValue("--activity-expand")) || 0,
        width: Math.round(work.width), left: Math.round(work.left),
        mainLeft: Math.round(mainRect.left), mainWidth: Math.round(mainRect.width),
      };
    });
    const at = async (naturalTop: number) => {
      await page.evaluate((target) => window.scrollTo(0, target), layout.bandDocumentTop - naturalTop);
      await page.waitForTimeout(150);
      const sample = await measure();
      if (!sample) { failures.push(`activity band: could not measure the band at naturalTop ${naturalTop}`); }
      return sample;
    };

    const rest = await at(320);
    const rising = [await at(160), await at(100), await at(40)];
    const full = await at(0);

    check(Boolean(rest && full && rising.every(Boolean)), "activity band: could not measure the band at every sample point");
    if (rest && full && rising.every(Boolean)) {
      const series = [rest, ...rising as NonNullable<typeof rest>[], full];
      check(rest.expand === 0, `activity band: expected no expansion at rest, measured --activity-expand ${rest.expand}`);
      check(full.expand === 1, `activity band: expected full expansion at the top, measured --activity-expand ${full.expand}`);
      for (let index = 1; index < series.length; index++) {
        check(series[index].width > series[index - 1].width, `activity band: width did not grow between samples ${index - 1} and ${index} (${series[index - 1].width} then ${series[index].width})`);
        check(series[index].left < series[index - 1].left, `activity band: band did not widen leftwards between samples ${index - 1} and ${index}`);
      }
      // At rest it sits inline; fully expanded it fills main minus the 24px canvas inset.
      expectClose(full.left, full.mainLeft + 24, 1, "activity band: expanded left edge");
      expectClose(full.width, full.mainWidth - 48, 2, "activity band: expanded width");
      expectClose(full.left + full.width / 2, full.mainLeft + full.mainWidth / 2, 2, "activity band: expanded centre");
      for (const sample of series) {
        check(sample.left >= sample.mainLeft - 1, `activity band: overflowed the left edge of main (${sample.left} < ${sample.mainLeft})`);
        check(sample.left + sample.width <= sample.mainLeft + sample.mainWidth + 1, "activity band: overflowed the right edge of main");
      }
      // Scrolling back must undo it, not leave the band stuck wide.
      const returned = await at(320);
      if (returned) {
        check(returned.expand === 0, `activity band: expansion did not reverse on scroll back (--activity-expand ${returned.expand})`);
        expectClose(returned.width, rest.width, 1, "activity band: width did not return to its inline size");
      }
    }

    // Shoot the whole page, not just the band: the affordance is how wide the band sits relative
    // to the column around it, which a crop of the band's own interior cannot show. The terminal
    // is masked because xterm's canvas is not reproducible between runs.
    const terminal = page.locator(".embedded-terminal");
    await at(320);
    await compareGolden(page, "activity-band-at-rest", await page.screenshot({ mask: [terminal] }));
    await at(0);
    await compareGolden(page, "activity-band-expanded", await page.screenshot({ mask: [terminal] }));
    }

    // ---- Affordance 3: the composer grows with the draft, then caps and scrolls ---------------
    const composer = page.locator(".timeline-composer-textarea");
    const composerHeight = async () => page.evaluate(() => {
      const field = document.querySelector(".timeline-composer-textarea") as HTMLTextAreaElement | null;
      return field ? { height: Math.round(field.getBoundingClientRect().height), overflowY: getComputedStyle(field).overflowY } : null;
    });
    await composer.fill("one line");
    const oneLine = await composerHeight();
    await composer.fill(Array.from({ length: 3 }, (_, index) => `line ${index + 1}`).join("\n"));
    const threeLines = await composerHeight();
    await composer.fill(Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join("\n"));
    const overflowing = await composerHeight();

    check(Boolean(oneLine && threeLines && overflowing), "composer: could not measure the composer textarea");
    if (oneLine && threeLines && overflowing) {
      check(threeLines.height > oneLine.height, `composer: did not grow from one line (${oneLine.height}) to three (${threeLines.height})`);
      // composerMaxHeightPx is 160.
      expectClose(overflowing.height, 160, 2, "composer: capped height");
      check(overflowing.height < 30 * oneLine.height, "composer: grew past its cap instead of scrolling");
      check(overflowing.overflowY === "auto", `composer: expected overflowY auto once capped, measured ${overflowing.overflowY}`);
      check(oneLine.overflowY !== "auto", `composer: expected no scrollbar at one line, measured overflowY ${oneLine.overflowY}`);
    }
    await compareGolden(page, "composer-capped", await composer.screenshot());
  } finally {
    await browser.close();
    await new Promise<void>((done, fail) => server.close((error) => error ? fail(error) : done()));
  }

  if (failures.length) {
    console.error(`Visual affordance validation failed (${failures.length}):`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log(updating
    ? "Visual affordance golden masters updated."
    : "Visual affordance validation passed: reading-line promotion, activity band expansion, composer auto-resize.");
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
