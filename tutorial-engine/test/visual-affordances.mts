#!/usr/bin/env npx tsx
/**
 * Real-browser validation for the workbook's scroll-driven visual affordances.
 *
 * JSDOM has no layout engine, so the unit tests can only exercise the geometry maths against
 * fabricated rects and assert the stylesheet as a string. Neither notices if the selector stops
 * matching, a later rule wins, or the scroll listener never fires. This harness serves the built
 * workbook UI to Chromium and measures what a learner would actually see.
 *
 * It runs the real workbook server against the fixture workbook in test/fixtures/visual-workbook,
 * copied to a temporary directory, with a tutor that answers from a queue instead of a model. The
 * state the browser renders is therefore the server's own projection: a fixture that drifted from
 * what the server emits could otherwise keep these checks passing against a fiction.
 *
 * Screenshots are approval tests. Each one is compared against its .approved.png; a mismatch
 * writes the .received.png beside it and fails, so the two can be opened side by side. Approve a
 * deliberate change with `npm run approve:visual`, which renames received over approved.
 *
 *   npx tsx test/visual-affordances.mts    validate
 */
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { startWorkbookServer } from "../src/workbook/server.js";
import type { TerminalPty } from "../src/workbook/terminal.js";
import { QueuedMainTutor, RecordingPracticeCoach } from "./support/fake-tutors.js";

const webRoot = resolve(import.meta.dirname, "../dist/web-workbook");
const fixtureRoot = resolve(import.meta.dirname, "fixtures/visual-workbook");
const approvalRoot = resolve(import.meta.dirname, "visual");

/** A differing pixel must differ by more than this per channel; antialiasing moves by less. */
const CHANNEL_TOLERANCE = 12;
/** Share of pixels allowed to differ before an approved screenshot counts as changed. */
const PIXEL_BUDGET = 0.005;

/** The tutor's verdict on the first editor draft, which the welded feedback panel then shows. */
const EDITOR_FEEDBACK = "Name the acceptance marker in the answer, then pause for another review.";

/** The terminal never runs anything here; it only has to exist and echo. */
class EchoPty implements TerminalPty {
  #data?: (data: string) => void;
  write(data: string): void { this.#data?.(`\r\nran:${data}`); }
  resize(): void {}
  kill(): void {}
  onData(callback: (data: string) => void): void { this.#data = callback; }
  onExit(): void {}
}

const failures: string[] = [];
function check(condition: boolean, description: string): void {
  if (!condition) failures.push(description);
}
function expectClose(actual: number, expected: number, slack: number, description: string): void {
  check(Math.abs(actual - expected) <= slack, `${description}: expected ~${expected} (±${slack}), measured ${actual}`);
}

/**
 * Compare in the browser we already have running, so an approval test needs no image dependency:
 * both PNGs go onto canvases and the pixel arrays are differenced.
 *
 * On a mismatch the received file is left on disk next to the approved one, which is what makes
 * the pair openable in a diff tool. On a match it is removed, so a stale received file always
 * means "this one is waiting on you".
 */
async function approve(page: any, name: string, shot: Buffer): Promise<void> {
  await mkdir(approvalRoot, { recursive: true });
  const approvedPath = resolve(approvalRoot, `${name}.approved.png`);
  const receivedPath = resolve(approvalRoot, `${name}.received.png`);
  const reject = async (message: string) => {
    await writeFile(receivedPath, shot);
    failures.push(message);
  };
  const accept = async () => { await rm(receivedPath, { force: true }); };

  let approved: Buffer;
  try { approved = await readFile(approvedPath); }
  catch {
    await reject(`${name}: nothing approved yet — review test/visual/${name}.received.png, then run \`npm run approve:visual\``);
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
      if (Math.abs(left[index]! - right[index]!) > tolerance
        || Math.abs(left[index + 1]! - right[index + 1]!) > tolerance
        || Math.abs(left[index + 2]! - right[index + 2]!) > tolerance) differing++;
    }
    return { sizeMismatch: undefined, ratio: differing / (left.length / 4) };
  }, [approved.toString("base64"), shot.toString("base64"), CHANNEL_TOLERANCE]);

  if (verdict.sizeMismatch) await reject(`${name}: received ${verdict.sizeMismatch}. Compare test/visual/${name}.received.png with ${name}.approved.png`);
  else if (verdict.ratio > PIXEL_BUDGET) await reject(`${name}: ${(verdict.ratio * 100).toFixed(2)}% of pixels differ (budget ${(PIXEL_BUDGET * 100).toFixed(2)}%). Compare test/visual/${name}.received.png with ${name}.approved.png, then \`npm run approve:visual\` to accept`);
  else await accept();
}

async function main(): Promise<void> {
  try { await readFile(resolve(webRoot, "index.html")); }
  catch { throw new Error("Build the workbook UI first: npm run --workspace=tutorial-engine build:web:workbook"); }
  const moduleName = "playwright";
  let playwright: { chromium: { launch(options?: unknown): Promise<any> } };
  try { playwright = await import(moduleName) as typeof playwright; }
  catch { throw new Error("Visual validation needs Playwright. Install it with `npm install --no-save -D playwright`, then `npx playwright install chromium`."); }

  // The embedded terminal refuses to start without a key. Nothing here reaches a model — the
  // tutors are fakes and the pty only echoes — so a placeholder is what the engine's own server
  // tests use too.
  process.env.OPENCODE_API_KEY ??= "visual-affordances-fixture-key";

  // Copy the fixture so the server's own writes never touch the committed workbook.
  const workspace = await mkdtemp(resolve(tmpdir(), "visual-affordances-"));
  await cp(fixtureRoot, workspace, { recursive: true });
  await mkdir(resolve(workspace, "factory"), { recursive: true });
  await writeFile(resolve(workspace, "factory/answer.md"), "A first draft of the answer.\n");

  // The first editor draft draws feedback, which is what the welded panel has to show; the second
  // is accepted, which is how the terminal block becomes the active surface.
  const mainTutor = new QueuedMainTutor(
    { outcome: "feedback", message: EDITOR_FEEDBACK },
    { outcome: "accepted", message: "Editor draft accepted." },
  );
  const server = await startWorkbookServer({
    target: workspace,
    webRoot,
    port: 0,
    mainTutor,
    practiceCoach: new RecordingPracticeCoach(),
    terminalPtyFactory: () => new EchoPty(),
    terminalDebounceMs: 1,
  });
  const browser = await playwright.chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1, reducedMotion: "reduce" });
    // tsx compiles with esbuild's keepNames, which references a __name helper. Functions handed to
    // page.evaluate are serialized without it, so provide it inside the page.
    await page.addInitScript(() => { (globalThis as unknown as { __name: unknown }).__name = (value: unknown) => value; });
    await page.goto(server.url);
    // Golden masters compare pixels, so nothing may still be easing when the shot is taken.
    await page.addStyleTag({ content: "*, *::before, *::after { transition: none !important; animation: none !important; caret-color: transparent !important; }" });
    // Walk the authored preamble with the Continue control, but only until the block after
    // orientation has been revealed. Clicking past that would promote by button and never exercise
    // the reading line, which is the affordance under test.
    const successorSelector = 'section[id$="--editing"]';
    for (let step = 0; step < 6; step++) {
      if (await page.locator(successorSelector).count() > 0) break;
      const button = page.locator("button").filter({ hasText: /^Continue/ }).first();
      if (await button.count() === 0) break;
      await button.click({ force: true });
      await page.waitForTimeout(500);
    }
    check(await page.locator(successorSelector).count() > 0, "reading line: the successor block was never revealed by the Continue control");

    // ---- Affordance 1: the reading line promotes the block it passes -------------------------
    // Completion is read back from the server rather than from a counter in this file, so the
    // assertion is about what was actually recorded.
    // The server records canonical ids (lesson--001-affordances--orientation), not the authored
    // block name, so match on the suffix or the assertion can never be true.
    const orientationCompleted = async (): Promise<boolean> =>
      page.evaluate(async () => ((await (await fetch("api/workbook/state")).json()).progress.completedBlocks ?? [])
        .some((id: string) => id.endsWith("--orientation")));

    await page.evaluate(() => window.scrollTo(0, 0));
    check(!(await orientationCompleted()), "reading line: orientation completed before it reached the reading line");
    // The observer watches the ready successor, not the active block: when the successor's top
    // crosses READING_LINE_TOP_PX (120), the block the learner has scrolled past is completed.
    const successorTop = await page.evaluate((selector: string) => {
      const element = document.querySelector(selector);
      return element ? element.getBoundingClientRect().top + window.scrollY : null;
    }, successorSelector);
    check(successorTop !== null, "reading line: no successor element to scroll past the line");
    await page.evaluate((target: number) => window.scrollTo(0, target), (successorTop ?? 0) - 60);
    const promoted = await page.waitForFunction(() => Boolean(document.querySelector(".current-activity-band")), undefined, { timeout: 10_000 })
      .then(() => true)
      .catch(() => { failures.push("reading line: scrolling the successor past the line did not promote the block behind it"); return false; });
    check(await orientationCompleted(), "reading line: crossing the line did not complete the orientation block");

    // ---- Affordance 2: the activity band expands as it rises ---------------------------------
    // Both practice blocks ride the same band, so the same measurements must hold for each.
    const validateBand = async (label: string) => {
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
        await page.evaluate((target: number) => window.scrollTo(0, target), layout.bandDocumentTop - naturalTop);
        await page.waitForTimeout(150);
        const sample = await measure();
        if (!sample) failures.push(`${label} band: could not measure the band at naturalTop ${naturalTop}`);
        return sample;
      };

      const rest = await at(320);
      const rising = [await at(160), await at(100), await at(40)];
      const full = await at(0);

      check(Boolean(rest && full && rising.every(Boolean)), `${label} band: could not measure the band at every sample point`);
      if (rest && full && rising.every(Boolean)) {
        const series = [rest, ...rising as NonNullable<typeof rest>[], full];
        check(rest.expand === 0, `${label} band: expected no expansion at rest, measured --activity-expand ${rest.expand}`);
        check(full.expand === 1, `${label} band: expected full expansion at the top, measured --activity-expand ${full.expand}`);
        for (let index = 1; index < series.length; index++) {
          check(series[index].width > series[index - 1].width, `${label} band: width did not grow between samples ${index - 1} and ${index} (${series[index - 1].width} then ${series[index].width})`);
          check(series[index].left < series[index - 1].left, `${label} band: band did not widen leftwards between samples ${index - 1} and ${index}`);
        }
        // At rest it sits inline; fully expanded it fills main minus the 24px canvas inset.
        expectClose(full.left, full.mainLeft + 24, 1, `${label} band: expanded left edge`);
        expectClose(full.width, full.mainWidth - 48, 2, `${label} band: expanded width`);
        expectClose(full.left + full.width / 2, full.mainLeft + full.mainWidth / 2, 2, `${label} band: expanded centre`);
        for (const sample of series) {
          check(sample.left >= sample.mainLeft - 1, `${label} band: overflowed the left edge of main (${sample.left} < ${sample.mainLeft})`);
          check(sample.left + sample.width <= sample.mainLeft + sample.mainWidth + 1, `${label} band: overflowed the right edge of main`);
        }
        // Scrolling back must undo it, not leave the band stuck wide.
        const returned = await at(320);
        if (returned) {
          check(returned.expand === 0, `${label} band: expansion did not reverse on scroll back (--activity-expand ${returned.expand})`);
          expectClose(returned.width, rest.width, 1, `${label} band: width did not return to its inline size`);
        }
      }

      // Shoot the visible main canvas, not just the band: the affordance is how wide the band sits
      // relative to the column around it, which a crop of the band's own interior cannot show. The
      // lesson rail is outside this affordance, and Chromium can incompletely capture its sticky
      // descendants immediately after a deep scroll, so including it would approve compositor noise.
      // Both work surfaces are masked — xterm's canvas and CodeMirror's caret and selection do not
      // reproduce between runs — which leaves the band's own chrome, including its welded feedback.
      const masked = page.locator(".embedded-terminal, .cm-editor");
      // The band focuses its work surface when it scrolls into view, and :focus-within paints a
      // ring. Whether that has landed by the time the shot is taken depends on how the scroll
      // crossed the observer's margin, so settle on the unfocused state rather than approving a
      // ring that comes and goes. The auto-focus itself stays uncovered: asserting it here failed
      // two runs in three, because jumping the scroll position skips the crossing it waits for.
      const shoot = async () => {
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
        await page.waitForTimeout(80);
        const clip = await page.evaluate(() => {
          const main = document.querySelector("main") as HTMLElement | null;
          if (!main) throw new Error("Cannot screenshot the band without a main canvas");
          const rect = main.getBoundingClientRect();
          const x = Math.max(0, Math.round(rect.left));
          const y = 0;
          const width = Math.max(1, Math.round(window.innerWidth - x));
          const height = Math.max(1, Math.round(window.innerHeight));
          return { x, y, width, height };
        });
        return page.screenshot({ clip, mask: [masked] });
      };
      await at(320);
      await approve(page, `${label}-band-at-rest`, await shoot());
      await at(0);
      await approve(page, `${label}-band-expanded`, await shoot());
    };

    // ---- Affordance 4: the editor rides the same band, and wears the same feedback ------------
    // The band approvals are about the band's geometry inside the main canvas, not about the
    // decorative notebook grid. The grid is anchored to the document, so unrelated content above
    // the practice can require a different absolute scrollY to put the same band at the same
    // viewport position, shifting the 25px grid phase while the band geometry remains correct.
    const bandGridNeutralizer = await page.addStyleTag({ content: "main { background-image: none !important; }" });
    if (promoted) {
      const editorReached = await page.waitForFunction(() => document.querySelector('.current-activity-band[data-activity-type="editor-practice"]') !== null, undefined, { timeout: 10_000 })
        .then(() => true)
        .catch(() => { failures.push("editor band: the editor block never became the active practice surface"); return false; });

      if (editorReached) {
        // Draw the tutor's first queued verdict, so the welded panel has feedback to show.
        await page.locator(".cm-content").fill("A first draft of the answer.");
        await page.waitForFunction(() => Boolean(document.querySelector(".editor-feedback-overlay")?.textContent?.includes("acceptance marker")), undefined, { timeout: 15_000 })
          .catch(() => failures.push("editor feedback: the tutor's review never reached the editor's feedback panel"));
        await validateBand("editor");
        const editorMarkup = await page.evaluate(() => {
          const band = document.querySelector(".current-activity-band") as HTMLElement | null;
          const overlay = band?.querySelector(".editor-feedback-overlay") as HTMLElement | null;
          const surface = band?.querySelector(".editor-surface") as HTMLElement | null;
          if (!band || !overlay || !surface) return null;
          const overlayRect = overlay.getBoundingClientRect();
          const surfaceRect = surface.getBoundingClientRect();
          return {
            weldedBelow: Math.round(overlayRect.top - surfaceRect.bottom),
            sameWidth: Math.round(overlayRect.width - surfaceRect.width),
            background: getComputedStyle(overlay).backgroundColor,
            usesLiveBlockFeedback: overlay.classList.contains("live-block-feedback"),
            statusStrip: Boolean(band.querySelector(".editor-status")),
          };
        });
        check(Boolean(editorMarkup), "editor feedback: could not measure the editor's feedback overlay");
        if (editorMarkup) {
          // The terminal welds its feedback to the bottom of its surface; the editor now does too.
          expectClose(editorMarkup.weldedBelow, 0, 1, "editor feedback: gap between the editor surface and its feedback");
          expectClose(editorMarkup.sameWidth, 0, 1, "editor feedback: overlay width differs from the editor surface");
          check(editorMarkup.usesLiveBlockFeedback, "editor feedback: does not use the shared live-block-feedback treatment");
          check(!editorMarkup.statusStrip, "editor feedback: the separate status strip is still rendered alongside the feedback");
        }

        // The terminal is the block after the editor, so reaching it means getting a draft
        // accepted — the tutor's second queued verdict — and continuing.
        await page.locator(".cm-content").fill("A second draft naming the acceptance marker.");
        // The band unmounts once its checkpoint is accepted, so wait on the server's own state
        // rather than on anything the band renders.
        const accepted = await page.waitForFunction(async () => {
          const next = await (await fetch("api/workbook/state")).json();
          return next.progress.blocks.some((block: any) => block.id.endsWith("--editing") && block.checkpoint?.status === "accepted");
        }, undefined, { timeout: 15_000 })
          .then(() => true)
          .catch(() => { failures.push("terminal band: the editor draft was never accepted, so the terminal block was never reached"); return false; });
        if (accepted) {
          await page.locator("button").filter({ hasText: /^Continue/ }).first().click({ force: true });
          const terminalReached = await page.waitForFunction(() => document.querySelector('.current-activity-band[data-activity-type="terminal-practice"]') !== null, undefined, { timeout: 10_000 })
            .then(() => true)
            .catch(() => { failures.push("terminal band: the terminal block never became the active practice surface"); return false; });
          if (terminalReached) await validateBand("terminal");
        }
      }
    }
    await bandGridNeutralizer.evaluate((style: HTMLElement) => style.remove());

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
    await approve(page, "composer-capped", await composer.screenshot());
  } finally {
    await browser.close();
    await server.close();
    await rm(workspace, { recursive: true, force: true });
  }

  if (failures.length) {
    console.error(`Visual affordance validation failed (${failures.length}):`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log("Visual affordance validation passed: reading-line promotion, activity band expansion, composer auto-resize.");
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
