import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { TutorialEventBus } from "../src/protocol/event-bus.js";
import { activityCaption, isTranscriptEvent, type TutorialEvent } from "../src/protocol/events.js";
import { activityDetail, summarise } from "../src/agent/pi-adapter.js";
import { TutorialSessionLog } from "../src/session-log.js";

const workspaces: string[] = [];

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map(async (workspace) => {
    const { rm } = await import("node:fs/promises");
    await rm(workspace, { recursive: true, force: true });
  }));
});

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tutorial-activity-"));
  workspaces.push(root);
  await mkdir(join(root, "factory"));
  return root;
}

const activity: TutorialEvent = { type: "activity", text: "running read on README.md" };

describe("activity events", () => {
  it("reach subscribers, because the spinner needs them live", () => {
    const bus = new TutorialEventBus();
    const seen: TutorialEvent[] = [];
    bus.subscribe((event) => seen.push(event));

    bus.publish(activity);

    expect(seen).toEqual([activity]);
  });

  it("stay out of the replayed history, so a refresh cannot resurrect them", () => {
    const bus = new TutorialEventBus();

    bus.publish({ type: "user-message", markdown: "done" });
    bus.publish(activity);

    expect(bus.history()).toEqual([{ type: "user-message", markdown: "done" }]);
  });

  it("stay out of the session log, so a resumed session does not replay stale status", async () => {
    const root = await workspace();
    const log = new TutorialSessionLog(root);

    log.append({ type: "user-message", markdown: "done" });
    log.append(activity);
    await log.flush();

    const lines = (await readFile(log.path, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).type).toBe("user-message");
  });

  it("classifies transcript events and transient ones apart", () => {
    expect(isTranscriptEvent({ type: "user-message", markdown: "hello" })).toBe(true);
    expect(isTranscriptEvent(activity)).toBe(false);
    expect(isTranscriptEvent({ type: "session-state", session: { state: "active", hasSavedSession: false } })).toBe(false);
  });
});

describe("activityDetail", () => {
  const root = "/workspaces/software-factory-tutorial";

  it("shortens an absolute workspace path to what the learner recognises", () => {
    expect(activityDetail({ path: `${root}/docs/specs/001-invoke-a-doer.md` }, root)).toBe(" docs/specs/001-invoke-a-doer.md");
  });

  // Pi sends both forms. Resolving a relative one would silently depend on the
  // process's working directory, which is not necessarily the workspace.
  it("leaves an already-relative path alone", () => {
    expect(activityDetail({ path: "docs/specs" }, root)).toBe(" docs/specs");
  });

  it("keeps a path it cannot shorten rather than showing an empty name", () => {
    expect(activityDetail({ path: root }, root)).toBe(` ${root}`);
  });

  it("names a validation command", () => {
    expect(activityDetail({ commandId: "calculator-tests" }, root)).toBe(" calculator-tests");
  });

  it("says nothing about tools that carry neither, and leaks no arguments", () => {
    expect(activityDetail({ question: "Which step next?", options: [] }, root)).toBe("");
    expect(activityDetail(undefined, root)).toBe("");
    expect(activityDetail("read", root)).toBe("");
  });
});

describe("summarise", () => {
  it("lists a batch the learner can read at a glance", () => {
    expect(summarise(["read README.md", "ls docs/specs"])).toBe("read README.md, ls docs/specs");
  });

  it("truncates a long batch rather than overflowing the caption", () => {
    expect(summarise(["read a", "read b", "find c", "ls d", "grep e"])).toBe("read a, read b, find c and 2 more");
  });

  it("counts the remainder correctly at the boundary", () => {
    expect(summarise(["a", "b", "c"])).toBe("a, b, c");
    expect(summarise(["a", "b", "c", "d"])).toBe("a, b, c and 1 more");
  });
});

describe("the spinner's markup and styles", () => {
  const web = (file: string) => readFile(fileURLToPath(new URL(`../web/src/${file}`, import.meta.url)), "utf8");

  // The caption made this a live bug: `.thinking span` had matched only the
  // spinner while it was the sole child, so adding the caption and the
  // screen-reader label turned each of them into a spinning 14px circle. It
  // also outranks `.visually-hidden`, which is a single class.
  it("styles the spinner by class, so sibling spans are not caught by it", async () => {
    const styles = await web("styles.css");
    expect(styles).toMatch(/\.thinking \.spinner\s*\{/);
    expect(styles).not.toMatch(/\.thinking\s*>?\s*span\s*\{/);
  });

  it("gives the spinner element the class the stylesheet targets", async () => {
    expect(await web("main.tsx")).toMatch(/<span className="spinner"/);
  });
});

describe("activityCaption", () => {
  it("turns the engine's log phrasing into a caption", () => {
    expect(activityCaption("running read README.md")).toBe("Running read README.md…");
    expect(activityCaption("waiting for Pi")).toBe("Waiting for Pi…");
  });

  it("does not add a second ellipsis to a caption that already trails off", () => {
    expect(activityCaption("waiting for Pi… read README.md, ls docs/specs")).toBe("Waiting for Pi… read README.md, ls docs/specs");
  });

  it("falls back rather than rendering an empty spinner", () => {
    expect(activityCaption("")).toBe("Thinking…");
    expect(activityCaption("   ")).toBe("Thinking…");
  });
});
