import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { defaultKeymap } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { Markdown } from "../../web/src/markdown";
import { lessonElementId } from "../../src/workbook/lesson-links.js";
import { ActivityBand } from "./activity-band";
import { TimelineThread, type PublicTimelineRecord } from "./timeline-thread";

export type WorkbookBlockType = "narrative" | "terminal-practice" | "editor-practice" | "reflection" | "lesson-transition";
type BlockBase = { id: string; title: string; markdown: string; label?: string };
export type NarrativeBlock = BlockBase & { type: "narrative" };
export type TerminalPracticeBlock = BlockBase & { type: "terminal-practice" };
export type EditorPracticeBlock = BlockBase & { type: "editor-practice"; path: string; tutor?: never };
export type ReflectionBlock = BlockBase & { type: "reflection" };
export type LessonTransitionBlock = BlockBase & { type: "lesson-transition" };
export type Block = NarrativeBlock | TerminalPracticeBlock | EditorPracticeBlock | ReflectionBlock | LessonTransitionBlock;
export type Lesson = { id: string; title: string; dek: string; durationMinutes: number; outcomes: string[]; blocks: Block[] };
export type Chapter = { id: string; title: string; partId?: string; part?: string; partMarkdown?: string; partNumber?: number; lessonNumber: number; lesson?: Lesson };
export type AttemptKind = "editor" | "terminal" | "reflection";
export type EditorStatus = "editing" | "waiting" | "reviewing" | "feedback" | "unlocked";
export type ReflectionTurn = { role: "learner" | "tutor"; text: string };
export type PublicCheckpoint = {
  status: "working" | "reviewing" | "feedback" | "accepted";
  feedback?: string;
  successMessage?: string;
  summary?: string;
  evidence?: { kind: AttemptKind; text?: string; terminalHtml?: string; conversation?: ReflectionTurn[] };
};
export type BlockProgress = { id: string; type?: string; ready: boolean; active: boolean; completed: boolean; verified: boolean; workAccepted?: boolean; checkpoint?: PublicCheckpoint; terminalHtml?: string; emerged: boolean; revision?: number; draftText?: string; editorStatus?: EditorStatus };
export type Progress = { activeLessonId: string; activeBlockId: string; activeAnchorId?: string; completedLessons: string[]; completedBlocks?: string[]; workAcceptedBlocks?: string[]; readyBlocks?: string[]; blocks: BlockProgress[]; reflections: Record<string, string>; reflectionConversations: Record<string, ReflectionTurn[]>; canComplete?: { blockId: string; eligible: boolean; reason?: string }; workbookComplete?: boolean };
type Identity = { title: string };
export type CompleteBlockResult = { outcome: "completed"; state: State; navigationTarget: string } | { outcome: "already-completed"; state: State } | { outcome: "rejected"; state: State; reason: string };
export type State = { workbook: Identity; introduction: string; introductionComplete: boolean; chapters: Chapter[]; progress: Progress; adapter: { note?: string; modelBackedHelp?: boolean }; orderedBlocks?: Array<{ id: string; anchorId: string; title: string; origin: string; kind: string; lessonId: string; declaredId?: string }>; revealedBlockIds?: string[]; renderedBlockIds?: string[]; readyBlockIds?: string[]; currentBlock?: { id: string; anchorId: string; title: string; origin: string; kind: string; lessonId: string; workAccepted?: boolean }; completion?: { complete: true; anchorId: string; summary?: string }; timeline?: readonly PublicTimelineRecord[] };

async function completeBlockRequest(blockId: string): Promise<CompleteBlockResult> {
  const response = await fetch("api/workbook/complete-block", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ blockId }) });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

async function completeIntroduction(): Promise<State | CompleteBlockResult> {
  const response = await fetch("api/workbook/introduction", { method: "POST" });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

async function post(blockId: string, body: object): Promise<State | CompleteBlockResult> {
  const response = await fetch("api/workbook/events", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ blockId, ...body }) });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

async function postEditorDraft(blockId: string, revision: number, text: string): Promise<State> {
  const response = await fetch("/api/workbook/editor", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ blockId, revision, text }) });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

const INTRODUCTION_BLOCK_ID = "workbook--introduction";
const INTRODUCTION_LESSON_ID = "workbook--introduction";

async function postTutorMessage(blockId: string, text: string, blockInView?: string): Promise<State> {
  const response = await fetch("/api/workbook/messages", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ blockId, text, blockInView }) });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

async function retryTutorOperation(failureId: string): Promise<State> {
  const response = await fetch("/api/workbook/retry", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ failureId }) });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

async function readWorkbookState(): Promise<State> {
  const response = await fetch("/api/workbook/state");
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

function stateFromCompletion(result: State | CompleteBlockResult): State { return "outcome" in result ? result.state : result; }
function navigationTargetFrom(result: State | CompleteBlockResult): string | undefined { return "outcome" in result && result.outcome === "completed" ? result.navigationTarget : undefined; }
function successorFromState(state: State, completedBlockId: string): string | undefined {
  const ordered = state.orderedBlocks ?? [];
  const index = ordered.findIndex((block) => block.id === completedBlockId);
  return index >= 0 ? ordered[index + 1]?.anchorId ?? "workbook--complete" : undefined;
}
function progressFor(progress: Progress, id: string) { return progress.blocks.find((block) => block.id === id); }
function domSafe(value: string) { return value.replace(/[^A-Za-z0-9_-]+/g, "-"); }
export function scrollActiveLessonIntoView(doc: Pick<Document, "getElementById">, activeLessonId: string) { doc.getElementById(lessonElementId(activeLessonId))?.scrollIntoView({ behavior: "smooth", block: "start" }); }
let suppressPassiveHistoryUntil = 0;
let passiveAnchorScrollSuppression: { anchorId: string; until: number } | undefined;
function replaceUrlAnchor(anchorId: string) {
  suppressPassiveHistoryUntil = Date.now() + 450;
  passiveAnchorScrollSuppression = { anchorId, until: suppressPassiveHistoryUntil };
  if (typeof history !== "undefined") history.replaceState(null, "", `#${anchorId}`);
}
function passiveAnchorScrollIsSuppressed(anchorId: string) {
  return Boolean(passiveAnchorScrollSuppression?.anchorId === anchorId && Date.now() <= passiveAnchorScrollSuppression.until);
}

export function navigateToAnchor(anchorId: string, mode: "push" | "replace" | "none" = "push") {
  if (typeof document === "undefined") return false;
  const element = document.getElementById(anchorId);
  if (!element) return false;
  suppressPassiveHistoryUntil = Date.now() + 450;
  element.scrollIntoView({ behavior: reducedMotionPreferred() ? "auto" : "smooth", block: "start" });
  const fragment = `#${anchorId}`;
  if (typeof history !== "undefined" && mode === "push") history.pushState(null, "", fragment);
  if (typeof history !== "undefined" && mode === "replace") history.replaceState(null, "", fragment);
  if (mode === "push") {
    const heading = element.matches("h1,h2,h3,[tabindex]") ? element as HTMLElement : element.querySelector<HTMLElement>("h1,h2,h3,[tabindex]");
    heading?.focus?.({ preventScroll: true });
  }
  return true;
}
function canonicalLessonAnchor(lessonId: string) { return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(lessonId) ? `lesson--${lessonId}` : lessonElementId(lessonId); }
function blockElementId(lessonId: string, blockId: string) { return blockId.includes("--") ? blockId : `${lessonElementId(lessonId)}-block-${domSafe(blockId)}`; }
function completedBlockState(block: Block): BlockProgress { return { id: block.id, type: block.type, ready: true, active: false, completed: true, verified: block.type === "terminal-practice", terminalHtml: block.type === "terminal-practice" ? "<pre class=\"frozen-terminal-output\">Terminal session frozen.</pre>" : undefined, editorStatus: block.type === "editor-practice" ? "unlocked" : undefined, emerged: true }; }
function stateForBlock(progress: Progress, lessonId: string, block: Block): BlockProgress | undefined {
  if (lessonId === progress.activeLessonId) return progressFor(progress, block.id);
  if (progress.completedLessons.includes(lessonId)) return completedBlockState(block);
  return undefined;
}
function activeLessonValue<T>(progress: Progress, lessonId: string, value: T | undefined, fallback: T): T { return lessonId === progress.activeLessonId ? value ?? fallback : fallback; }
function commandForInsertion(command = "") { return command.replace(/\\\r?\n\s*/g, " "); }

const READING_LINE_TOP_PX = 120;

function canonicalBlockInView(state: State): string | undefined {
  const revealed = state.revealedBlockIds ?? state.progress.blocks.filter((block) => block.emerged).map((block) => block.id);
  const candidates = revealed.flatMap((id) => {
    const element = typeof document !== "undefined" ? document.getElementById(id) : null;
    return element ? [{ id, top: element.getBoundingClientRect().top }] : [];
  }).filter((candidate) => candidate.top <= READING_LINE_TOP_PX);
  return candidates.at(-1)?.id ?? state.progress.activeBlockId;
}

const TERMINAL_REVIEW_FAST_POLL_INTERVAL_MS = 250;
const TERMINAL_REVIEW_FAST_POLLS = 120;
const TERMINAL_REVIEW_BACKOFF_INTERVAL_MS = 2_000;

const SHELL_FENCE = /^```([^`\n]*)\n([\s\S]*?)^```/gm;
const SHELL_LANGUAGES = new Set(["sh", "bash", "shell", "zsh", "console"]);
function shellCommandFrom(markdown: string): string | undefined {
  for (const match of markdown.matchAll(SHELL_FENCE)) {
    const tokens = (match[1] ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (SHELL_LANGUAGES.has(tokens[0] ?? "") && tokens.includes("command")) return match[2]?.trim();
  }
  return undefined;
}

function EmbeddedTerminal({ block, command, active, completed, verified, checkpointStatus, reviewKey, refresh, onAdvice, onError, onStatus, onTerminalInsertionChange }: { block: Block; command?: string; active: boolean; completed: boolean; verified: boolean; checkpointStatus?: PublicCheckpoint["status"]; reviewKey?: number; refresh(state: State): void; onAdvice(message: string): void; onError(message: string): void; onStatus(message: string | undefined): void; onTerminalInsertionChange?(insertCommand: (() => void) | undefined): void }) {
  const terminalElement = useRef<HTMLDivElement | null>(null);
  const terminal = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const socket = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const [connectionEpoch, setConnectionEpoch] = useState(0);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const polling = useRef(false);
  const pollCount = useRef(0);
  const pollGeneration = useRef(0);
  const pollingReviewKey = useRef<number | undefined>(undefined);

  const stopReviewPolling = useCallback((clearStatus = true) => {
    polling.current = false;
    pollCount.current = 0;
    pollingReviewKey.current = undefined;
    pollGeneration.current += 1;
    if (pollTimer.current) clearTimeout(pollTimer.current);
    pollTimer.current = undefined;
    if (clearStatus) onStatus(undefined);
  }, [onStatus]);

  const scheduleReviewPoll = useCallback((generation: number) => {
    if (!polling.current || generation !== pollGeneration.current) return;
    const delay = pollCount.current < TERMINAL_REVIEW_FAST_POLLS ? TERMINAL_REVIEW_FAST_POLL_INTERVAL_MS : TERMINAL_REVIEW_BACKOFF_INTERVAL_MS;
    pollTimer.current = setTimeout(() => {
      pollTimer.current = undefined;
      if (!polling.current || generation !== pollGeneration.current) return;
      pollCount.current += 1;
      readWorkbookState().then((next) => {
        if (!polling.current || generation !== pollGeneration.current) return;
        const nextProgress = progressFor(next.progress, block.id);
        const status = nextProgress?.checkpoint?.status;
        const nextReviewKey = typeof nextProgress?.revision === "number" ? nextProgress.revision : undefined;
        refresh(next);
        if (pollingReviewKey.current !== undefined && nextReviewKey !== undefined && nextReviewKey !== pollingReviewKey.current) {
          stopReviewPolling(false);
          return;
        }
        if (!nextProgress?.active || nextProgress.completed || next.progress.activeBlockId !== block.id || status === "feedback" || status === "accepted" || status === "working") {
          stopReviewPolling();
          return;
        }
        scheduleReviewPoll(generation);
      }).catch((error) => {
        if (!polling.current || generation !== pollGeneration.current) return;
        console.error(error);
        scheduleReviewPoll(generation);
      });
    }, delay);
  }, [block.id, refresh, stopReviewPolling]);

  const startReviewPolling = useCallback(() => {
    if (polling.current) return;
    polling.current = true;
    pollCount.current = 0;
    pollingReviewKey.current = reviewKey;
    const generation = pollGeneration.current + 1;
    pollGeneration.current = generation;
    scheduleReviewPoll(generation);
  }, [reviewKey, scheduleReviewPoll]);

  useEffect(() => {
    const shouldPoll = active && !completed && !verified && checkpointStatus === "reviewing";
    if (shouldPoll) startReviewPolling();
    else stopReviewPolling(false);
    return () => stopReviewPolling(false);
  }, [active, completed, verified, checkpointStatus, reviewKey, startReviewPolling, stopReviewPolling]);

  useEffect(() => {
    if (!active || completed || !terminalElement.current) return;
    const nextTerminal = new Terminal({ cursorBlink: true, convertEol: true, fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace', fontSize: 16, theme: { background: "#101820" } });
    const nextFit = new FitAddon();
    nextTerminal.loadAddon(nextFit);
    nextTerminal.open(terminalElement.current);
    nextFit.fit();
    terminal.current = nextTerminal;
    fit.current = nextFit;

    const protocol = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${protocol}://${location.host}/api/workbook/terminal`);
    socket.current = ws;
    const sendResize = () => {
      nextFit.fit();
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "resize", cols: nextTerminal.cols, rows: nextTerminal.rows }));
    };
    const dataDisposable = nextTerminal.onData((data) => { if (!verified && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "input", data })); });
    ws.addEventListener("open", () => { setConnected(true); setConnectionEpoch((epoch) => epoch + 1); sendResize(); });
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.type === "output") nextTerminal.write(message.data);
      if (message.type === "advice" && message.blockId === block.id) onAdvice(message.message);
      if ((message.type === "observer-status" || message.type === "attempt-status") && message.blockId === block.id) {
        onStatus(message.status === "running" ? "Running — waiting for terminal output…" : message.status === "checking" || message.status === "submitted" ? "Checking…" : "Keep going; the expected result is not visible yet.");
        if (message.status === "submitted") startReviewPolling();
      }
      if ((message.type === "observer-error" || message.type === "attempt-error") && message.blockId === block.id) onError(message.message);
      if (message.type === "verified-complete" && message.blockId === block.id) { stopReviewPolling(); refresh(message.state); }
      if (message.type === "busy") onError(message.message);
      if (message.type === "terminal-error") onError(message.message);
      if (message.type === "exit") onStatus("The embedded shell exited. Refresh the page to start a new one.");
    });
    ws.addEventListener("close", () => setConnected(false));
    ws.addEventListener("error", () => { setConnected(false); onError("Embedded terminal connection failed. Refresh the page and try again."); });
    addEventListener("resize", sendResize);
    return () => {
      stopReviewPolling(false);
      removeEventListener("resize", sendResize);
      dataDisposable.dispose();
      ws.close();
      nextTerminal.dispose();
      terminal.current = null;
      fit.current = null;
      socket.current = null;
      setConnected(false);
    };
  }, [active, completed, verified, block.id, refresh, onAdvice, onError, onStatus, startReviewPolling, stopReviewPolling]);

  const insertCommand = useCallback(() => {
    if (!command) return;
    const data = commandForInsertion(command);
    if (!verified && socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify({ type: "input", data }));
  }, [command, verified]);

  useEffect(() => {
    if (!active || !command || verified || !connected || socket.current?.readyState !== WebSocket.OPEN) {
      onTerminalInsertionChange?.(undefined);
      return;
    }
    onTerminalInsertionChange?.(insertCommand);
    return () => onTerminalInsertionChange?.(undefined);
  }, [active, command, connected, connectionEpoch, insertCommand, onTerminalInsertionChange, verified]);

  return <div className="embedded-terminal-panel">
    <span className={`terminal-connection-status${connected ? " connected" : ""}`} aria-label={connected ? "Terminal connected" : "Terminal disconnected"} />
    <div ref={terminalElement} className="embedded-terminal" aria-label="Embedded terminal" />
  </div>;
}

function useContinueOnce(block: Block, state: BlockProgress | undefined, refresh: (state: State) => void) {
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const active = Boolean(state?.active && !state.completed);
  useEffect(() => { pendingRef.current = false; setPending(false); }, [block.id, state?.completed]);
  const continueOnce = useCallback((historyMode: "push" | "none" = "push") => {
    if (!active || pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    completeBlockRequest(block.id).then((result) => {
      refresh(stateFromCompletion(result));
      const target = navigationTargetFrom(result);
      if (target) requestAnimationFrame(() => navigateToAnchor(target, historyMode));
    }).catch((error) => {
      pendingRef.current = false;
      setPending(false);
      console.error(error);
      readWorkbookState().then((next) => {
        if (next.progress.completedBlocks?.includes(block.id)) {
          refresh(next);
          const target = successorFromState(next, block.id);
          if (target) requestAnimationFrame(() => navigateToAnchor(target, historyMode));
        }
      }).catch(() => undefined);
    });
  }, [active, block.id, refresh]);
  return { active, pending, continueOnce };
}

export function ContinuationPageBreak() {
  return <div className="continuation-controls flow-break-only"><div className="continuation-page-break" aria-hidden="true" /></div>;
}

export function ContinueControls({ block, state, refresh, label, preserveCompletedBreak = false }: { block: Block; state: BlockProgress | undefined; refresh(state: State): void; label?: string; preserveCompletedBreak?: boolean }) {
  const { active, pending, continueOnce } = useContinueOnce(block, state, refresh);

  if (state?.completed) return preserveCompletedBreak ? <ContinuationPageBreak /> : <p className="next-ready">The next step has appeared below.</p>;
  if (!active) return null;
  const buttonLabel = label ?? (block.id === "workbook--introduction" ? "Ready to continue" : "Continue");
  return <div className="continuation-controls">
    <button className="button primary" disabled={pending} onClick={() => continueOnce("push")}>{pending ? "Continuing…" : buttonLabel}</button>
    <div className="continuation-page-break" aria-hidden="true" />
  </div>;
}

function checkpointMessage(checkpoint: PublicCheckpoint): string {
  return checkpoint.successMessage ?? checkpoint.summary ?? checkpoint.feedback ?? "Nice work — the tutor accepted this attempt.";
}

function CheckpointEvidence({ checkpoint }: { checkpoint: PublicCheckpoint }) {
  const evidence = checkpoint.evidence;
  if (!evidence) return null;
  if (evidence.kind === "editor") return <pre className="accepted-evidence accepted-editor-evidence" aria-label="Accepted editor evidence"><code>{evidence.text ?? ""}</code></pre>;
  if (evidence.kind === "terminal") return <div className="frozen-terminal accepted-evidence" aria-label="Frozen terminal session" dangerouslySetInnerHTML={{ __html: evidence.terminalHtml || "<pre class=\"frozen-terminal-output\">Terminal session frozen.</pre>" }} />;
  return <div className="reflection-thread accepted-evidence" aria-label="Accepted reflection evidence">{(evidence.conversation ?? []).map((turn, index) => <div key={index} className={`reflection-turn ${turn.role}`}><b>{turn.role === "learner" ? "You" : "Tutor"}</b><p>{turn.text}</p></div>)}</div>;
}

export function AcceptedCheckpoint({ block, state, refresh, continueLabel }: { block: Block; state: BlockProgress; refresh(state: State): void; continueLabel?: string }) {
  const checkpoint = state.checkpoint;
  const [pending, setPending] = useState(false);
  if (checkpoint?.status !== "accepted") return null;
  const continueAccepted = () => {
    if (pending) return;
    setPending(true);
    completeBlockRequest(block.id).then((result) => { refresh(stateFromCompletion(result)); const target = navigationTargetFrom(result); if (target) requestAnimationFrame(() => navigateToAnchor(target, "push")); }).catch((error) => {
      console.error(error);
      setPending(false);
    });
  };
  return <aside className="success-checkpoint accepted-checkpoint" aria-live="polite">
    <span className="success-check" aria-hidden="true">✓</span><div><p className="section-label">Accepted</p><h3>Nice work — accepted.</h3><p>{checkpointMessage(checkpoint)}</p><CheckpointEvidence checkpoint={checkpoint} /><button className="button primary" disabled={pending} onClick={continueAccepted}>{pending ? "Continuing…" : continueLabel ?? "Continue"}</button></div>
  </aside>;
}

function AttemptCheckpointStatus({ state }: { state: BlockProgress | undefined }) {
  const checkpoint = state?.checkpoint;
  if (!checkpoint || checkpoint.status === "accepted") return null;
  if (checkpoint.status === "feedback") return <aside className="advice" aria-live="polite"><b>Tutor feedback:</b> {checkpoint.feedback ?? "Keep going and try again."}</aside>;
  return <aside className="observer-status" aria-live="polite">{checkpoint.status === "reviewing" ? "Reviewing your latest attempt…" : "Keep working — the tutor will review your evidence when you pause."}</aside>;
}

function NarrativeBlock({ lessonId, block, state, refresh, continueLabel }: { lessonId: string; block: Block; state: BlockProgress | undefined; refresh(state: State): void; continueLabel?: string }) {
  return <section id={blockElementId(lessonId, block.id)} className={`work-block narrative ${state?.active ? "is-active" : ""}`}>
    <p className="section-label">The idea</p>
    <h2>{block.title}</h2>
    <Markdown>{block.markdown}</Markdown>
    <ContinueControls block={block} state={state} refresh={refresh} label={continueLabel} />
  </section>;
}

function TerminalBlock({ lessonId, block, state, refresh, showAuthoredContent = true, onTerminalInsertionChange, continueLabel }: { lessonId: string; block: Block; state: BlockProgress | undefined; refresh(state: State): void; showAuthoredContent?: boolean; onTerminalInsertionChange?(insertCommand: (() => void) | undefined): void; continueLabel?: string }) {
  const [observerFeedback, setObserverFeedback] = useState<string>();
  const [observerStatus, setObserverStatus] = useState<string>();
  const command = shellCommandFrom(block.markdown);
  const accepted = state?.checkpoint?.status === "accepted";
  const checkpoint = state?.checkpoint;
  const persistedFeedback = !accepted && checkpoint
    ? checkpoint.status === "feedback"
      ? checkpoint.feedback ?? "Keep going and try again."
      : checkpoint.status === "reviewing"
        ? "Checking…"
        : undefined
    : undefined;
  const liveFeedback = observerFeedback ?? observerStatus ?? persistedFeedback;
  const showLiveTerminal = !state?.verified && !state?.completed;
  useEffect(() => { setObserverFeedback(undefined); setObserverStatus(undefined); }, [block.id, state?.completed, state?.checkpoint?.status]);
  return <section id={blockElementId(lessonId, block.id)} className={`work-block terminal ${state?.active ? "is-active" : ""}`}>
    {showAuthoredContent && <><p className="section-label">Practice · embedded terminal</p><h2>{block.title}</h2><Markdown>{block.markdown}</Markdown></>}
    {accepted && state ? <AcceptedCheckpoint block={block} state={state} refresh={refresh} continueLabel={continueLabel} /> : state?.verified ? <div className="frozen-terminal" aria-label="Frozen terminal session" dangerouslySetInnerHTML={{ __html: state.terminalHtml || "<pre class=\"frozen-terminal-output\">Terminal session frozen.</pre>" }} /> : showLiveTerminal && <div className={`terminal-live-surface${liveFeedback ? " has-feedback" : ""}`}>
      <EmbeddedTerminal block={block} command={command} active={Boolean(state?.active)} completed={Boolean(state?.completed)} verified={false} checkpointStatus={state?.checkpoint?.status} reviewKey={state?.revision} refresh={refresh} onAdvice={setObserverFeedback} onError={setObserverFeedback} onStatus={setObserverStatus} onTerminalInsertionChange={onTerminalInsertionChange} />
      {liveFeedback && <aside className="live-block-feedback terminal-feedback-overlay" aria-live="polite"><Markdown>{liveFeedback}</Markdown></aside>}
    </div>}
    {!accepted && liveFeedback && !showLiveTerminal && <aside className="live-block-feedback" aria-live="polite"><Markdown>{liveFeedback}</Markdown></aside>}
  </section>;
}

const EDITOR_REVIEW_POLL_INTERVAL_MS = 250;
const EDITOR_REVIEW_MAX_POLLS = 480;

function editorStatusText(state: BlockProgress | undefined, completed: boolean): string {
  if (completed || state?.editorStatus === "unlocked" || state?.checkpoint?.status === "accepted") return "Unlocked — the accepted revision has been written to the target file.";
  if (state?.checkpoint?.status === "reviewing" || state?.editorStatus === "reviewing") return "Reviewing your latest revision…";
  if (state?.checkpoint?.status === "working") return "Keep writing — the tutor will review after you pause.";
  if (state?.editorStatus === "waiting") return "Keep writing — the reviewer will check again after you pause.";
  if (state?.checkpoint?.status === "feedback" || state?.editorStatus === "feedback") return "Feedback received — keep editing and pause to request another review.";
  return "Editing — changes are reviewed automatically after you pause.";
}

function EditorPracticeBlockView({ lessonId, block, state, refresh, showAuthoredContent = true, continueLabel }: { lessonId: string; block: EditorPracticeBlock; state: BlockProgress | undefined; refresh(state: State): void; showAuthoredContent?: boolean; continueLabel?: string }) {
  const editorElement = useRef<HTMLDivElement | null>(null);
  const editor = useRef<EditorView | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const activeRef = useRef(false);
  const baseRevision = useRef(state?.revision ?? 0);
  const [localError, setLocalError] = useState<string>();
  const accepted = state?.checkpoint?.status === "accepted";
  const completed = Boolean(state?.completed || state?.editorStatus === "unlocked");
  const canEdit = Boolean(state?.active && !completed && !accepted);
  const initialText = state?.draftText ?? "";

  useEffect(() => { baseRevision.current = state?.revision ?? baseRevision.current; }, [block.id, state?.revision]);
  useEffect(() => { activeRef.current = canEdit; }, [canEdit]);

  useEffect(() => {
    const reviewing = state?.checkpoint?.status === "reviewing" || state?.editorStatus === "reviewing";
    if (!canEdit || !reviewing || !Number.isInteger(state?.revision)) return;
    let cancelled = false;
    let polls = 0;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    const revision = state.revision;
    const poll = () => {
      pollTimer = setTimeout(() => {
        if (cancelled) return;
        polls += 1;
        readWorkbookState().then((next) => {
          if (cancelled) return;
          const nextProgress = progressFor(next.progress, block.id);
          const nextStatus = nextProgress?.checkpoint?.status ?? nextProgress?.editorStatus;
          const completedReview = Boolean(nextProgress?.completed || nextStatus === "feedback" || nextStatus === "accepted" || nextStatus === "unlocked" || !nextProgress?.active);
          refresh(next);
          if (completedReview || nextProgress?.revision !== revision || polls >= EDITOR_REVIEW_MAX_POLLS) return;
          poll();
        }).catch((error) => {
          console.error(error);
          if (!cancelled && polls < EDITOR_REVIEW_MAX_POLLS) poll();
        });
      }, EDITOR_REVIEW_POLL_INTERVAL_MS);
    };
    poll();
    return () => {
      cancelled = true;
      if (pollTimer) clearTimeout(pollTimer);
    };
  }, [block.id, canEdit, refresh, state?.checkpoint?.status, state?.editorStatus, state?.revision]);

  useEffect(() => {
    if (!canEdit || !editorElement.current) return;
    activeRef.current = true;
    const parent = editorElement.current;
    const scheduleReview = (text: string) => {
      if (!activeRef.current) return;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        if (!activeRef.current) return;
        const revision = baseRevision.current + 1;
        baseRevision.current = revision;
        setLocalError(undefined);
        postEditorDraft(block.id, revision, text).then(refresh).catch((error) => {
          console.error(error);
          setLocalError(error instanceof Error ? error.message : "Editor review failed. Keep editing and try again.");
        });
      }, 750);
    };
    const view = new EditorView({
      state: EditorState.create({
        doc: initialText,
        extensions: [
          keymap.of(defaultKeymap),
          EditorView.updateListener.of((update) => { if (update.docChanged) scheduleReview(update.state.doc.toString()); })
        ]
      }),
      parent
    });
    editor.current = view;
    return () => {
      activeRef.current = false;
      if (timer.current) clearTimeout(timer.current);
      timer.current = undefined;
      view.destroy();
      if (editor.current === view) editor.current = null;
    };
  }, [block.id, canEdit, refresh]);

  const status = editorStatusText(state, completed);
  return <section id={blockElementId(lessonId, block.id)} className={`work-block editor-practice ${state?.active ? "is-active" : ""}`}>
    {showAuthoredContent && <><p className="section-label">Practice · embedded editor</p><h2>{block.title}</h2><Markdown>{block.markdown}</Markdown></>}
    <div className="editor-target"><span>Target file</span><code>{block.path}</code></div>
    {canEdit && <div className="editor-status" role="status" aria-live="polite">{localError ?? status}</div>}
    {canEdit && state?.checkpoint?.feedback && <aside className="advice editor-feedback" aria-live="polite"><b>Inline feedback:</b> {state.checkpoint.feedback}</aside>}
    {canEdit && <div ref={editorElement} className="editor-surface" aria-label={`Editor for ${block.path}`} />}
    {accepted && state ? <AcceptedCheckpoint block={block} state={state} refresh={refresh} continueLabel={continueLabel} /> : completed ? <aside className="success-checkpoint editor-unlocked" aria-live="polite">
      <span className="success-check" aria-hidden="true">✓</span><div><p className="section-label">Unlocked</p><h3>Accepted revision unlocked the next step.</h3><p>{state?.checkpoint?.successMessage || "The latest accepted editor draft was written to the target file."}</p></div>
    </aside> : !canEdit && <p className="next-ready">This editor practice will unlock when you reach this block.</p>}
  </section>;
}

function ReflectionBlock({ lessonId, block, state, turns, refresh, continueLabel }: { lessonId: string; block: Block; state: BlockProgress | undefined; turns: ReflectionTurn[]; refresh(state: State): void; continueLabel?: string }) {
  const accepted = state?.checkpoint?.status === "accepted";
  const visibleTurns = accepted ? state?.checkpoint?.evidence?.conversation ?? turns : turns;
  return <section id={blockElementId(lessonId, block.id)} className={`work-block reflection ${state?.active ? "is-active" : ""}`}><p className="section-label">Reflection · discuss it</p><h2>{block.title}</h2><div className="question"><Markdown>{block.markdown}</Markdown></div>
    {visibleTurns.length > 0 && !accepted && <div className="reflection-thread" aria-live="polite">{visibleTurns.map((turn, index) => <div key={index} className={`reflection-turn ${turn.role}`}><b>{turn.role === "learner" ? "You" : "Tutor"}</b><p>{turn.text}</p></div>)}</div>}
    {accepted && state ? <AcceptedCheckpoint block={block} state={state} refresh={refresh} continueLabel={continueLabel} /> : state?.completed ? <p className="next-ready">Reflection complete. The next step has appeared below.</p> : <AttemptCheckpointStatus state={state} />}
  </section>;
}

function TransitionBlock({ lessonId, block, state, refresh, continueLabel }: { lessonId: string; block: Block; state: BlockProgress | undefined; refresh(state: State): void; continueLabel?: string }) {
  return <section id={blockElementId(lessonId, block.id)} className={`work-block lesson-end ${state?.active ? "is-active" : ""}`}>
    <p className="section-label">Lesson transition</p>
    <h2>{block.title}</h2>
    <Markdown>{block.markdown}</Markdown>
    <ContinueControls block={block} state={state} refresh={refresh} label={continueLabel} />
  </section>;
}

export function BlockView({ lessonId, block, progress, refresh, showAuthoredContent = true, onTerminalInsertionChange, continueLabel }: { lessonId?: string; block: Block; progress: Progress; refresh(state: State): void; showAuthoredContent?: boolean; onTerminalInsertionChange?(insertCommand: (() => void) | undefined): void; continueLabel?: string }) {
  const resolvedLessonId = lessonId ?? progress.activeLessonId;
  const state = stateForBlock(progress, resolvedLessonId, block);
  if (block.type === "narrative") return <NarrativeBlock lessonId={resolvedLessonId} block={block} state={state} refresh={refresh} continueLabel={continueLabel} />;
  if (block.type === "terminal-practice") return <TerminalBlock lessonId={resolvedLessonId} block={block} state={state} refresh={refresh} showAuthoredContent={showAuthoredContent} onTerminalInsertionChange={onTerminalInsertionChange} continueLabel={continueLabel} />;
  if (block.type === "editor-practice") return <EditorPracticeBlockView lessonId={resolvedLessonId} block={block} state={state} refresh={refresh} showAuthoredContent={showAuthoredContent} continueLabel={continueLabel} />;
  if (block.type === "reflection") return <ReflectionBlock lessonId={resolvedLessonId} block={block} state={state} turns={activeLessonValue(progress, resolvedLessonId, progress.reflectionConversations[block.id], [])} refresh={refresh} continueLabel={continueLabel} />;
  return <TransitionBlock lessonId={resolvedLessonId} block={block} state={state} refresh={refresh} continueLabel={continueLabel} />;
}

function WorkbookIntroduction({ state, refresh }: { state: State; refresh(state: State): void }) {
  return <section className="workbook-intro" aria-label="Workbook introduction">
    <header><h1>{state.workbook.title}</h1></header>
    <Markdown>{state.introduction}</Markdown>
    {state.introductionComplete ? <p className="next-ready">The first lesson is ready below.</p> : <button className="button primary introduction-continue" onClick={() => completeBlockRequest("workbook--introduction").then((result) => refresh(stateFromCompletion(result)))}>{continueLabelFor(state, "workbook--introduction") ?? "Ready to continue"}</button>}
  </section>;
}

function IntroductionContinue({ refresh, label = "Ready to continue" }: { refresh(state: State): void; label?: string }) {
  const [pending, setPending] = useState(false);
  const continueIntroduction = () => {
    if (pending) return;
    setPending(true);
    completeBlockRequest("workbook--introduction").then((result) => { refresh(stateFromCompletion(result)); const target = navigationTargetFrom(result); if (target) requestAnimationFrame(() => navigateToAnchor(target, "push")); }).catch((error) => {
      console.error(error);
      setPending(false);
    });
  };
  return <div className="continuation-controls introduction-continuation">
    <button className="button primary introduction-continue" disabled={pending} onClick={continueIntroduction}>{pending ? "Continuing…" : label}</button>
  </div>;
}

type PublicOrderedBlock = NonNullable<State["orderedBlocks"]>[number];

function outlineBlocksForLesson(chapter: Chapter, orderedBlocks?: readonly PublicOrderedBlock[]) {
  const ordered = orderedBlocks?.filter((block) => block.origin === "declared" && block.lessonId === chapter.id) ?? [];
  if (ordered.length > 0) return ordered.map((block) => ({ id: block.id, anchorId: block.anchorId, title: block.title }));
  return chapter.lesson?.blocks.map((block) => ({ id: block.id, anchorId: blockElementId(chapter.id, block.id), title: block.title })) ?? [];
}

export function LessonRail({ title, chapters, progress, viewedLessonId, setViewedLesson, orderedBlocks }: { title: string; chapters: Chapter[]; progress: Progress; viewedLessonId: string; setViewedLesson(id: string): void; orderedBlocks?: readonly PublicOrderedBlock[] }) {
  const renderChapter = (chapter: Chapter) => {
    const complete = progress.completedLessons.includes(chapter.id);
    const current = chapter.id === progress.activeLessonId;
    if (!chapter.lesson) return <span key={chapter.id} className="lesson-row ahead unavailable" aria-disabled="true"><span>Lesson {chapter.lessonNumber}: {chapter.title}</span></span>;
    const lessonAnchor = canonicalLessonAnchor(chapter.id);
    return <details key={chapter.id} className="lesson-nav" open={viewedLessonId === chapter.id}><summary><a href={`#${lessonAnchor}`} className={`lesson-row ${complete ? "done" : current ? "current" : "ahead"}`} onClick={(event) => { event.preventDefault(); setViewedLesson(chapter.id); navigateToAnchor(lessonAnchor, "push"); }}>Lesson {chapter.lessonNumber}: {chapter.title}</a></summary>{viewedLessonId === chapter.id && <nav className="lesson-outline" aria-label={`${chapter.title} outline`}>{outlineBlocksForLesson(chapter, orderedBlocks).map((block) => {
      const blockProgress = progressFor(progress, block.id);
      const navigable = Boolean(blockProgress?.completed || blockProgress?.active);
      return navigable ? <a href={`#${block.anchorId}`} key={block.id} aria-current={blockProgress?.active ? "true" : undefined} onClick={(event) => { event.preventDefault(); navigateToAnchor(block.anchorId, "push"); }}>{block.title}</a> : <span className="outline-row disabled" key={block.id} aria-disabled="true">{block.title}</span>;
    })}</nav>}</details>;
  };
  const parts = [...new Set(chapters.map((chapter) => chapter.part).filter((part): part is string => Boolean(part)))];
  const renderedPartName = (part: string) => {
    const first = chapters.find((chapter) => chapter.part === part);
    const anchor = first?.partId ? `part--${first.partId}` : undefined;
    const partProgress = progress.blocks.find((block) => block.id === anchor);
    const revealed = Boolean(anchor && (progress.completedBlocks?.includes(anchor) || progress.activeBlockId === anchor || partProgress && partProgress.emerged && !partProgress.ready));
    if (!anchor || !revealed) return <p className="part-name">{part}</p>;
    return <a className="part-name part-link" href={`#${anchor}`} onClick={(event) => { event.preventDefault(); navigateToAnchor(anchor, "push"); }}>{part}</a>;
  };
  return <aside className="rail" aria-label="Lesson navigation">
    <div className="brand"><span className="brand-mark" aria-hidden="true">↗</span> {title}</div>
    <nav className="curriculum" aria-label="Workbook navigation">{parts.length === 0
      ? chapters.map(renderChapter)
      : parts.map((part) => <div key={part}>{renderedPartName(part)}{chapters.filter((chapter) => chapter.part === part).map(renderChapter)}</div>)}</nav>
  </aside>;
}

export function LessonView({ chapter, progress, refresh, renderBlocks = true, children }: { chapter: Chapter & { lesson: Lesson }; progress: Progress; refresh(state: State): void; renderBlocks?: boolean; children?: React.ReactNode }) {
  return <article data-lesson-id={chapter.id} key={chapter.id} className="chapter">
    <header id={lessonElementId(chapter.id)}><p className="eyebrow">Lesson {chapter.lessonNumber}</p><h1>{chapter.lesson.title}</h1><p className="dek">{chapter.lesson.dek}</p><div className="lesson-meta"><span className="chip duration">{chapter.lesson.durationMinutes} min</span></div></header>
    <section className="opening"><p className="section-label">What you will learn</p><h2>What you will learn</h2><ul className="outcomes">{chapter.lesson.outcomes.map((outcome) => <li key={outcome}>{outcome}</li>)}</ul></section>
    {renderBlocks && chapter.lesson.blocks.map((block) => <BlockView key={block.id} lessonId={chapter.id} block={block} progress={progress} refresh={refresh} />)}
    {children}
  </article>;
}

function PartChapter({ chapter }: { chapter: Chapter }) {
  if (!chapter.part || !chapter.partMarkdown) return null;
  return <section id={`part-${chapter.id}`} className="part-chapter" aria-label={chapter.part}><div><p className="part-title">{chapter.part}</p><div className="part-copy"><Markdown>{chapter.partMarkdown}</Markdown></div></div></section>;
}

function reducedMotionPreferred(): boolean {
  const query = "(prefers-reduced-motion: reduce)";
  if (typeof matchMedia === "function") return matchMedia(query).matches;
  if (typeof window !== "undefined" && typeof window.matchMedia === "function") return window.matchMedia(query).matches;
  return false;
}

export function AcceptanceConfetti({ acceptedKey }: { acceptedKey: string | undefined }) {
  const initialized = useRef(false);
  const seen = useRef(new Set<string>());
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [visibleKey, setVisibleKey] = useState<string>();

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  useEffect(() => {
    if (!initialized.current) {
      initialized.current = true;
      if (acceptedKey) seen.current.add(acceptedKey);
      return;
    }
    if (!acceptedKey || seen.current.has(acceptedKey)) return;
    seen.current.add(acceptedKey);
    if (reducedMotionPreferred()) return;
    if (timer.current) clearTimeout(timer.current);
    setVisibleKey(acceptedKey);
    timer.current = setTimeout(() => setVisibleKey(undefined), 1_000);
  }, [acceptedKey]);

  if (!visibleKey) return null;
  return <div className="acceptance-confetti" aria-hidden="true" style={{ pointerEvents: "none" }}>{Array.from({ length: 24 }, (_, index) => <span key={`${visibleKey}-${index}`} className="confetti-particle" style={{ "--x": `${(index % 8) * 13 - 46}vw`, "--delay": `${(index % 6) * 35}ms`, "--hue": `${(index * 47) % 360}` } as React.CSSProperties} />)}</div>;
}

function activeAcceptedKey(progress: Progress): string | undefined {
  const accepted = progress.blocks.find((block) => block.active && !block.completed && block.checkpoint?.status === "accepted");
  if (!accepted?.checkpoint) return undefined;
  const evidence = accepted.checkpoint.evidence;
  return `${progress.activeLessonId}/${accepted.id}/${evidence?.kind ?? "attempt"}/${accepted.checkpoint.successMessage ?? accepted.checkpoint.summary ?? "accepted"}`;
}

function readySuccessorId(progress: Progress): string | undefined {
  return progress.blocks.find((block) => block.ready && !block.active && !block.completed)?.id ?? progress.readyBlocks?.[0];
}

function successorAfter(state: State, blockId: string): { successor?: PublicOrderedBlock; currentIndex: number; count: number } {
  const ordered = state.orderedBlocks ?? [];
  const index = ordered.findIndex((block) => block.id === blockId);
  return { successor: index >= 0 ? ordered[index + 1] : undefined, currentIndex: index, count: ordered.length };
}

function continueLabelFor(state: State, blockId: string): string | undefined {
  const { successor, currentIndex, count } = successorAfter(state, blockId);
  if (!successor) return count > 0 && currentIndex === count - 1 ? "Continue to completion" : undefined;
  if (successor.kind === "lesson-preamble") {
    const lesson = state.chapters.find((chapter) => chapter.id === successor.lessonId);
    return `Continue to lesson ${lesson?.lessonNumber ?? successor.title}`;
  }
  return `Continue to ${successor.title}`;
}

function CompletionPanel({ state, onRetry }: { state: State; onRetry(failureId: string): Promise<void> }) {
  if (!state.completion?.complete) return null;
  const failures = state.timeline?.filter((record) => record.type === "tutor_failed" && record.blockId === "workbook--complete") ?? [];
  return <section id={state.completion.anchorId} className="workbook-completion-panel work-block" tabIndex={-1} aria-live="polite">
    <p className="section-label">Workbook complete</p>
    <h1>You finished the workbook.</h1>
    {state.completion.summary ? <Markdown>{state.completion.summary}</Markdown> : <p>The tutor is preparing your completion summary.</p>}
    {failures.map((failure) => <aside key={failure.id} className="timeline-message tutor failure" aria-live="polite"><b>Summary unavailable</b><p>{failure.publicMessage}</p><button className="button secondary" onClick={() => void onRetry(failure.failureId)}>Retry</button></aside>)}
  </section>;
}

export function App() {
  const [state, setState] = useState<State>();
  const [viewed, setViewed] = useState<string>();
  const [terminalInsertion, setTerminalInsertion] = useState<(() => void) | undefined>();
  const [blockedLink, setBlockedLink] = useState(false);
  const scrollCompletionPending = useRef(false);
  const previousReadyRunwayIds = useRef<Set<string>>(new Set());
  const preservedRunwayIds = useRef<Set<string>>(new Set());
  const registerTerminalInsertion = useCallback((insertCommand: (() => void) | undefined) => {
    setTerminalInsertion(() => insertCommand);
  }, []);
  useEffect(() => { fetch("api/workbook/state").then((response) => response.json()).then((next: State) => setState(next)); }, []);
  useEffect(() => { if (state) document.title = state.workbook.title; }, [state?.workbook.title]);
  useEffect(() => {
    if (!state) return;
    const fragment = typeof location === "undefined" ? "" : decodeURIComponent(location.hash.replace(/^#/, ""));
    const revealed = new Set(state.revealedBlockIds ?? state.progress.blocks.filter((block) => block.emerged).map((block) => block.id));
    const raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame : (callback: FrameRequestCallback) => setTimeout(callback, 0) as unknown as number;
    if (!fragment) { raf(() => navigateToAnchor(state.progress.activeAnchorId ?? state.progress.activeBlockId, "replace")); return; }
    if (revealed.has(fragment) || fragment === "workbook--complete" && state.progress.workbookComplete) {
      if (passiveAnchorScrollIsSuppressed(fragment)) { passiveAnchorScrollSuppression = undefined; return; }
      raf(() => navigateToAnchor(fragment, "none"));
      return;
    }
    setBlockedLink(true);
  }, [state?.workbook.title, state?.progress.activeAnchorId, state?.progress.workbookComplete]);
  useEffect(() => { setTerminalInsertion(undefined); }, [state?.progress.activeLessonId, state?.progress.activeBlockId]);
  useEffect(() => {
    if (!state || state.progress.workbookComplete || typeof IntersectionObserver === "undefined") return;
    const readyId = readySuccessorId(state.progress);
    const activeId = state.progress.activeBlockId;
    if (!readyId || !activeId) return;
    const element = document.getElementById(readyId);
    if (!element) return;
    scrollCompletionPending.current = false;
    const completeIfCrossedReadingLine = (top = element.getBoundingClientRect().top) => {
      if (top > READING_LINE_TOP_PX || scrollCompletionPending.current) return;
      scrollCompletionPending.current = true;
      completeBlockRequest(activeId).then((result) => {
        setState(stateFromCompletion(result));
        const target = navigationTargetFrom(result);
        if (target) replaceUrlAnchor(target);
      }).catch((error) => {
        scrollCompletionPending.current = false;
        console.error(error);
        readWorkbookState().then((next) => { if (next.progress.completedBlocks?.includes(activeId)) setState(next); }).catch(() => undefined);
      });
    };
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry?.isIntersecting) return;
      completeIfCrossedReadingLine(entry.boundingClientRect?.top ?? element.getBoundingClientRect().top);
    }, { threshold: 0 });
    const checkReadySuccessorPosition = () => completeIfCrossedReadingLine();
    observer.observe(element);
    addEventListener("scroll", checkReadySuccessorPosition, { passive: true });
    addEventListener("resize", checkReadySuccessorPosition);
    return () => {
      observer.disconnect();
      removeEventListener("scroll", checkReadySuccessorPosition);
      removeEventListener("resize", checkReadySuccessorPosition);
    };
  }, [state?.progress.activeBlockId, state?.progress.workbookComplete, state?.readyBlockIds?.join("|"), state?.progress.readyBlocks?.join("|")]);
  useEffect(() => {
    if (!state) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const selectViewed = () => {
      const id = canonicalBlockInView(state);
      const lesson = state.orderedBlocks?.find((block) => block.id === id)?.lessonId;
      if (lesson && !lesson.startsWith("workbook--") && !lesson.startsWith("part--")) setViewed(lesson.replace(/^lesson--/, ""));
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { if (id && typeof history !== "undefined" && Date.now() > suppressPassiveHistoryUntil) history.replaceState(null, "", `#${id}`); }, 120);
    };
    selectViewed(); addEventListener("scroll", selectViewed, { passive: true });
    const pop = () => { const id = typeof location === "undefined" ? "" : decodeURIComponent(location.hash.replace(/^#/, "")); if (id) navigateToAnchor(id, "none"); };
    addEventListener("popstate", pop);
    return () => { removeEventListener("scroll", selectViewed); removeEventListener("popstate", pop); if (timer) clearTimeout(timer); };
  }, [state]);
  const emerged = useMemo(() => state?.chapters.filter((chapter): chapter is Chapter & { lesson: Lesson } => Boolean(chapter.lesson)) ?? [], [state]);
  if (!state) return <p className="loading">Loading workbook…</p>;
  const viewedLesson = viewed ?? state.progress.activeLessonId;
  const activeChapter = emerged.find((chapter) => chapter.id === state.progress.activeLessonId);
  const activeBlock = activeChapter?.lesson.blocks.find((block) => block.id === state.progress.activeBlockId);
  const activeBlockProgress = state.progress.blocks.find((block) => block.id === state.progress.activeBlockId);
  const effectiveActiveLessonId = state.progress.workbookComplete ? "workbook--complete" : state.introductionComplete ? state.progress.activeLessonId : INTRODUCTION_LESSON_ID;
  const effectiveActiveBlockId = state.progress.workbookComplete ? "workbook--complete" : state.introductionComplete ? state.progress.activeBlockId : INTRODUCTION_BLOCK_ID;
  const effectiveActiveBlockProgress = state.progress.blocks.find((block) => block.id === effectiveActiveBlockId) ?? (!state.introductionComplete ? { id: INTRODUCTION_BLOCK_ID, type: "workbook-introduction", ready: true, active: true, completed: false, verified: false, emerged: true } as BlockProgress : activeBlockProgress);
  const hasTimeline = state.timeline !== undefined;
  const blockInView = () => canonicalBlockInView(state);
  const sendTutorText = (text: string) => {
    if (state.introductionComplete && activeBlock?.type === "reflection") {
      const turns = state.progress.reflectionConversations[activeBlock.id] ?? [];
      return post(activeBlock.id, { action: turns.length > 0 ? "reflection-follow-up" : "reflection-submit", response: text }).then((next) => setState(stateFromCompletion(next)));
    }
    const before = state.progress.activeBlockId;
    return postTutorMessage(state.progress.workbookComplete ? "workbook--complete" : state.introductionComplete ? state.progress.activeBlockId : INTRODUCTION_BLOCK_ID, text, state.introductionComplete ? blockInView() : undefined).then((next) => {
      setState(next);
      if (next.progress.activeBlockId !== before || next.progress.workbookComplete && !state.progress.workbookComplete) requestAnimationFrame(() => navigateToAnchor(next.progress.activeAnchorId ?? next.progress.activeBlockId, "push"));
    });
  };
  const activeContinuationEligible = !state.introductionComplete ? true : state.progress.canComplete ? state.progress.canComplete.blockId === effectiveActiveBlockId && state.progress.canComplete.eligible : Boolean(effectiveActiveBlockProgress?.active && effectiveActiveBlockProgress.ready && !effectiveActiveBlockProgress.completed && (activeBlock?.type === "narrative" || activeBlock?.type === "lesson-transition" || effectiveActiveBlockProgress.checkpoint?.status === "accepted"));
  const reflectionComposerDisabled = Boolean(state.introductionComplete && activeBlock?.type === "reflection" && ["reviewing", "accepted"].includes(activeBlockProgress?.checkpoint?.status ?? ""));
  const currentReadyRunwayIds = new Set(state.readyBlockIds ?? state.progress.readyBlocks ?? []);
  for (const id of previousReadyRunwayIds.current) if (!currentReadyRunwayIds.has(id) && state.progress.activeBlockId === id && !state.progress.workbookComplete) preservedRunwayIds.current.add(id);
  if (currentReadyRunwayIds.size > 0) preservedRunwayIds.current.delete(state.progress.activeBlockId);
  for (const id of [...preservedRunwayIds.current]) if (state.progress.completedBlocks?.includes(id) || state.progress.workbookComplete) preservedRunwayIds.current.delete(id);
  previousReadyRunwayIds.current = currentReadyRunwayIds;
  const stableRunwayIds = [...new Set([...currentReadyRunwayIds, ...preservedRunwayIds.current])];
  const activeContinueBlock: Block = activeBlock ?? { id: effectiveActiveBlockId, type: "narrative", title: state.currentBlock?.title ?? state.workbook.title, markdown: "" };
  const renderTimelineContinuation = (record: PublicTimelineRecord) => {
    if (record.type !== "message") return null;
    const blockProgress = state.progress.blocks.find((block) => block.id === record.blockId);
    const recordIsActive = record.blockId === effectiveActiveBlockId && (record.lessonId === effectiveActiveLessonId || effectiveActiveBlockId.includes("--"));
    if (recordIsActive && activeContinuationEligible && effectiveActiveBlockProgress) {
      return <ContinueControls block={activeContinueBlock} state={effectiveActiveBlockProgress} refresh={setState} label={continueLabelFor(state, effectiveActiveBlockId)} />;
    }
    if (!recordIsActive && blockProgress?.completed) return <ContinuationPageBreak />;
    return null;
  };
  return <div className="shell">
    {blockedLink && <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Lesson not ready"><div className="modal"><p>The lesson you're linking to is not ready yet — you still have some work to do!</p><button className="button primary" onClick={() => { setBlockedLink(false); navigateToAnchor(state.progress.activeAnchorId ?? state.progress.activeBlockId, "replace"); }}>OK</button></div></div>}
    <AcceptanceConfetti acceptedKey={activeAcceptedKey(state.progress)} />
    <LessonRail title={state.workbook.title} chapters={state.chapters} progress={state.progress} viewedLessonId={viewedLesson} setViewedLesson={setViewed} orderedBlocks={state.orderedBlocks} />
    <main><article className="page">
      {hasTimeline ? <>
        <TimelineThread records={state.timeline} activeLessonId={effectiveActiveLessonId} activeBlockId={effectiveActiveBlockId} onSend={sendTutorText} onRetry={(failureId) => retryTutorOperation(failureId).then((next) => setState(next))} onDoItForMe={terminalInsertion} inputDisabled={reflectionComposerDisabled} renderContinuation={renderTimelineContinuation} readyBlockIds={stableRunwayIds} activeSurface={activeChapter && activeBlock ? <ActivityBand lessonId={activeChapter.id} activeBlock={activeBlock} progress={state.progress} refresh={setState} onTerminalInsertionChange={registerTerminalInsertion} /> : undefined} completionPanel={<CompletionPanel state={state} onRetry={(failureId) => retryTutorOperation(failureId).then((next) => setState(next))} />} />
      </> : <>
        <WorkbookIntroduction state={state} refresh={setState} />
        {emerged.map((chapter, index) => <React.Fragment key={chapter.id}>{(index === 0 || chapter.part !== emerged[index - 1]!.part) && <PartChapter chapter={chapter} />}<LessonView chapter={chapter} progress={state.progress} refresh={setState} /></React.Fragment>)}
      </>}
    </article></main>
  </div>;
}
