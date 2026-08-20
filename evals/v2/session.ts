import { readdir, readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import type { WorkbookEvent } from "../../tutorial-engine/src/workbook/events.js";
import type { PublicWorkbookState, V2ArtifactSnapshot, V2RecordedPublicState, V2ReflectionEntry, V2SessionTrace, V2TerminalTranscriptEntry } from "./types.js";

const PRIVATE_TEXT_PATTERNS = [/This is private tutor guidance/i, /Do not reveal an exact command/i, /Follow up until the learner/i];
const DEFAULT_ARTIFACT_ROOTS = [".tmp"];
const MAX_ARTIFACT_BYTES = 64 * 1024;

export function createEmptyV2SessionTrace(scenarioId: string): V2SessionTrace {
  return { scenarioId, publicStates: [], terminalTranscript: [], reflections: [], events: [], artifacts: [] };
}

export function recordPublicState(trace: V2SessionTrace, label: string, state: unknown): V2RecordedPublicState {
  assertNoPrivateTutorState(state);
  const recorded = { label, state: structuredClone(state) as PublicWorkbookState };
  trace.publicStates.push(recorded);
  return recorded;
}

export function recordTerminalTranscript(trace: V2SessionTrace, entry: V2TerminalTranscriptEntry): V2TerminalTranscriptEntry {
  assertNoPrivateTutorState(entry, "terminalTranscript");
  trace.terminalTranscript.push({ ...entry });
  return entry;
}

export function recordReflectionTurn(trace: V2SessionTrace, entry: V2ReflectionEntry): V2ReflectionEntry {
  assertNoPrivateTutorState(entry, "reflection");
  trace.reflections.push({ ...entry });
  return entry;
}

export async function readWorkbookEvents(workspaceRoot: string): Promise<WorkbookEvent[]> {
  const eventPath = resolve(workspaceRoot, ".tutorial/.tmp/workbook/events.jsonl");
  let text: string;
  try { text = await readFile(eventPath, "utf8"); }
  catch (error: any) { if (error?.code === "ENOENT") return []; throw error; }
  return text.split(/\r?\n/).filter(Boolean).map((line, index) => {
    let event: WorkbookEvent;
    try { event = JSON.parse(line) as WorkbookEvent; }
    catch (error) { throw new Error(`${eventPath}:${index + 1}: invalid JSONL event`); }
    assertNoPrivateTutorState(event, `events[${index}]`);
    return event;
  });
}

export async function snapshotArtifacts(workspaceRoot: string, artifactRoots: string[] = DEFAULT_ARTIFACT_ROOTS): Promise<V2ArtifactSnapshot[]> {
  const snapshots: V2ArtifactSnapshot[] = [];
  for (const root of artifactRoots) {
    await collectArtifacts(workspaceRoot, resolve(workspaceRoot, root), snapshots);
  }
  return snapshots.sort((left, right) => left.path.localeCompare(right.path));
}

async function collectArtifacts(workspaceRoot: string, path: string, snapshots: V2ArtifactSnapshot[]): Promise<void> {
  let entries;
  try { entries = await readdir(path, { withFileTypes: true }); }
  catch (error: any) { if (error?.code === "ENOENT") return; throw error; }
  for (const entry of entries) {
    const child = resolve(path, entry.name);
    if (entry.isDirectory()) {
      await collectArtifacts(workspaceRoot, child, snapshots);
      continue;
    }
    if (!entry.isFile()) continue;
    const content = await readFile(child, "utf8");
    if (Buffer.byteLength(content, "utf8") > MAX_ARTIFACT_BYTES) throw new Error(`${child} is too large to include in a v2 evaluator trace.`);
    const relativePath = relative(workspaceRoot, child).split(sep).join("/");
    const snapshot = { path: relativePath, content };
    assertNoPrivateTutorState(snapshot);
    snapshots.push(snapshot);
  }
}

export function assertNoPrivateTutorState(value: unknown, path = "state"): void {
  if (typeof value === "string") {
    const privatePattern = PRIVATE_TEXT_PATTERNS.find((pattern) => pattern.test(value));
    if (privatePattern) throw new Error(`Refusing to record private tutor guidance at ${path}.`);
    return;
  }
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoPrivateTutorState(item, `${path}[${index}]`));
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === "tutor") throw new Error(`Refusing to record private tutor field at ${path}.${key}.`);
    assertNoPrivateTutorState(child, `${path}.${key}`);
  }
}
