import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ChoiceManager } from "../src/agent/choice-manager.js";
import { createTutorialTools } from "../src/agent/tutorial-tools.js";
import { WorkspaceBoundary } from "../src/agent/workspace-boundary.js";
import type { TutorialEvent } from "../src/protocol/events.js";
import { ValidationRunner } from "../src/validation/runner.js";

const ledger = [
  "# Lessons",
  "",
  "## Part 1 — First part",
  "",
  "| Lesson | Goal |",
  "| --- | --- |",
  "| [001](001-first.md) | First step |",
  "| [002](002-second.md) | Second step |",
  ""
].join("\n");

async function harness() {
  const workspace = await mkdtemp(join(tmpdir(), "complete-lesson-"));
  await mkdir(join(workspace, "docs/specs"), { recursive: true });
  await writeFile(join(workspace, "docs/specs/README.md"), ledger, "utf8");

  const events: TutorialEvent[] = [];
  const tools = createTutorialTools({
    lesson: { title: "Example", workspace, validationCommands: [] },
    workspace,
    choices: new ChoiceManager(),
    validation: new ValidationRunner([], workspace),
    boundary: await WorkspaceBoundary.create(workspace),
    emit: (event) => events.push(event),
    setRunState: () => {}
  });

  const tool = tools.find((item) => item.name === "complete_lesson");
  if (!tool) throw new Error("complete_lesson tool is missing.");
  return { workspace, events, tool };
}

describe("complete_lesson", () => {
  it("records the lesson in factory/ and publishes the advanced outline", async () => {
    const { workspace, events, tool } = await harness();

    await tool.execute("call-1", {}, new AbortController().signal, undefined);

    expect(JSON.parse(await readFile(join(workspace, "factory/tutorial-progress.json"), "utf8")))
      .toEqual({ completed: ["001"], skipped: [] });

    const progress = events.find((event) => event.type === "progress");
    expect(progress).toBeDefined();
    expect(progress?.type === "progress" && progress.progress.slice(1).map((item) => item.state))
      .toEqual(["done", "current"]);
  });

  it("leaves the ledger exactly as it shipped, so a clone starts at lesson one", async () => {
    const { workspace, tool } = await harness();

    await tool.execute("call-1", {}, new AbortController().signal, undefined);

    // The curriculum is version-controlled and the same for everyone; only
    // factory/ knows how far this learner has got.
    expect(await readFile(join(workspace, "docs/specs/README.md"), "utf8")).toBe(ledger);
  });

  it("records the write in the audit trail as a mutation", async () => {
    const { events, tool } = await harness();

    await tool.execute("call-1", {}, new AbortController().signal, undefined);

    const audit = events.find((event) => event.type === "audit");
    expect(audit).toMatchObject({ tool: "complete_lesson", mutation: true, outcome: "ok", paths: ["factory/tutorial-progress.json"] });
  });

  it("is harmless when called again after the last lesson", async () => {
    const { workspace, events, tool } = await harness();
    const signal = new AbortController().signal;

    await tool.execute("call-1", {}, signal, undefined);
    await tool.execute("call-2", {}, signal, undefined);
    const extra = await tool.execute("call-3", {}, signal, undefined);

    // Nothing left to advance: no duplicate id is recorded, and no outline
    // event is sent that would move the highlight past the end.
    expect(JSON.parse(await readFile(join(workspace, "factory/tutorial-progress.json"), "utf8")))
      .toEqual({ completed: ["001", "002"], skipped: [] });
    expect(extra.details).toMatchObject({ changed: false });
    expect(events.filter((event) => event.type === "progress")).toHaveLength(2);
  });
});

describe("the tutor's tool allowlist", () => {
  it("exposes complete_lesson, which is defined but unreachable if the list omits it", async () => {
    const source = await readFile(new URL("../src/agent/pi-adapter.ts", import.meta.url), "utf8");
    const names = source.slice(source.indexOf("const TOOL_NAMES"), source.indexOf("];", source.indexOf("const TOOL_NAMES")));

    expect(names).toContain("complete_lesson");
  });
});
