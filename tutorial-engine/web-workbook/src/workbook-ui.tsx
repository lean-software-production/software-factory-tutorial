import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { defaultKeymap } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { createPortal } from "react-dom";
import { Markdown } from "./markdown.js";
import { lessonElementId } from "../../src/workbook/lesson-links.js";
import { ActivityBand } from "./activity-band.js";
import { TimelineThread } from "./timeline-thread.js";
import { isPublicWorkbookState, parsePublicCompleteBlockResult, parsePublicWorkbookState } from "../../src/workbook/public-contract.js";
import type { PublicAttemptKind, PublicCheckpoint, PublicCompleteBlockResult, PublicEditorStatus, PublicReflectionTurn, PublicTimelineRecord, PublicWorkbookBlock, PublicWorkbookBlockProgress, PublicWorkbookBlockType, PublicWorkbookChapter, PublicWorkbookLesson, PublicWorkbookProgress, PublicWorkbookState } from "../../src/workbook/public-contract.js";
import { parsePublicTerminalMessage, type PublicTerminalMessage } from "../../src/workbook/public-terminal-contract.js";

export type WorkbookBlockType = PublicWorkbookBlockType;
export type Block = PublicWorkbookBlock;
export type NarrativeBlock = Extract<Block, { type: "narrative" }>;
export type TerminalPracticeBlock = Extract<Block, { type: "terminal-practice" }>;
export type EditorPracticeBlock = Extract<Block, { type: "editor-practice" }>;
export type ReflectionBlock = Extract<Block, { type: "reflection" }>;
export type Lesson = PublicWorkbookLesson;
export type Chapter = PublicWorkbookChapter;
export type AttemptKind = PublicAttemptKind;
export type EditorStatus = PublicEditorStatus;
export type ReflectionTurn = PublicReflectionTurn;
export type { PublicCheckpoint, PublicTimelineRecord };
export type BlockProgress = PublicWorkbookBlockProgress;
export type Progress = PublicWorkbookProgress;
export type CompleteBlockResult = PublicCompleteBlockResult;
export type State = PublicWorkbookState;

function parseStateOrCompletion(value: unknown): State | CompleteBlockResult { return isPublicWorkbookState(value) ? value : parsePublicCompleteBlockResult(value); }

/**
 * Every workbook request goes through here, so the address and the validation are decided once
 * rather than per call site. The path stays relative to the page: the bundle is built with
 * `base: "./"` and the server matches its routes by suffix, so a workbook served under a path
 * prefix still reaches its own API. A body means a JSON POST; no body means a GET. Nothing reaches
 * React until `parse` has agreed the response is the shape it claims to be.
 */
async function request<T>(path: string, body: object | undefined, parse: (value: unknown) => T): Promise<T> {
  const init: RequestInit = body === undefined ? { method: "GET" } : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
  const response = await fetch(`api/workbook/${path}`, init);
  if (!response.ok) throw new Error(await response.text());
  return parse(await response.json());
}

const completeBlockRequest = (blockId: string) => request("complete-block", { blockId }, parsePublicCompleteBlockResult);
const post = (blockId: string, body: object) => request("events", { blockId, ...body }, parseStateOrCompletion);
const postEditorDraft = (blockId: string, revision: number, text: string) => request("editor", { blockId, revision, text }, parsePublicWorkbookState);
const postTutorMessage = (blockId: string, text: string, blockInView?: string) => request("messages", { blockId, text, blockInView }, parsePublicWorkbookState);
const retryTutorOperation = (failureId: string) => request("retry", { failureId }, parsePublicWorkbookState);
const readWorkbookState = () => request("state", undefined, parsePublicWorkbookState);

const INTRODUCTION_BLOCK_ID = "workbook--introduction";
const INTRODUCTION_LESSON_ID = "workbook--introduction";

function stateFromCompletion(result: State | CompleteBlockResult): State { return "outcome" in result ? result.state : result; }
function navigationTargetFrom(result: State | CompleteBlockResult): string | undefined { return "outcome" in result && result.outcome === "completed" ? result.navigationTarget : undefined; }
function successorFromState(state: State, completedBlockId: string): string | undefined {
  const ordered = state.orderedBlocks ?? [];
  const index = ordered.findIndex((block) => block.id === completedBlockId);
  return index >= 0 ? ordered[index + 1]?.anchorId ?? "workbook--complete" : undefined;
}
function progressFor(progress: Progress, id: string) { return progress.blocks.find((block) => block.id === id); }
function domSafe(value: string) { return value.replace(/[^A-Za-z0-9_-]+/g, "-"); }
/**
 * All this needs is a lookup that yields something scrollable. A real Document satisfies it, and so
 * can a test double, without having to be a whole HTMLElement.
 */
type ScrollTargetLookup = { getElementById(elementId: string): { scrollIntoView(options?: ScrollIntoViewOptions): void } | null };

export function scrollActiveLessonIntoView(doc: ScrollTargetLookup, activeLessonId: string) { doc.getElementById(lessonElementId(activeLessonId))?.scrollIntoView({ behavior: "smooth", block: "start" }); }
let suppressPassiveHistoryUntil = 0;
function replaceUrlAnchor(anchorId: string) {
  suppressPassiveHistoryUntil = Date.now() + 450;
  if (typeof history !== "undefined") history.replaceState(null, "", `#${anchorId}`);
}

function scheduleAnchorAnimationFrame(callback: FrameRequestCallback): () => void {
  const raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame : (frameCallback: FrameRequestCallback) => setTimeout(() => frameCallback(Date.now()), 0) as unknown as number;
  const cancel = typeof cancelAnimationFrame === "function" ? cancelAnimationFrame : (handle: number) => clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
  const handle = raf(callback);
  return () => cancel(handle);
}

export function navigateToAnchor(anchorId: string, mode: "push" | "replace" | "none" = "push") {
  if (typeof document === "undefined") return false;
  const element = document.getElementById(anchorId);
  if (!element) return false;
  suppressPassiveHistoryUntil = Date.now() + 450;
  const fragment = `#${anchorId}`;
  if (typeof history !== "undefined" && mode === "push") history.pushState(null, "", fragment);
  if (typeof history !== "undefined" && mode === "replace") history.replaceState(null, "", fragment);
  element.scrollIntoView({ behavior: reducedMotionPreferred() ? "auto" : "smooth", block: "start" });
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

const SHELL_FENCE = /^```([^`\n]*)\n([\s\S]*?)^```/gm;
const SHELL_LANGUAGES = new Set(["sh", "bash", "shell", "zsh", "console"]);
function shellCommandFrom(markdown: string): string | undefined {
  for (const match of markdown.matchAll(SHELL_FENCE)) {
    const tokens = (match[1] ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (SHELL_LANGUAGES.has(tokens[0] ?? "") && tokens.includes("command")) return match[2]?.trim();
  }
  return undefined;
}

const UNREADABLE_TERMINAL_FRAME = "The embedded terminal received an unreadable message from the workbook server. Refresh the page if the terminal stops responding.";

function EmbeddedTerminal({ block, command, active, completed, verified, refresh, onAdvice, onError, onStatus, onTerminalInsertionChange }: { block: Block; command?: string; active: boolean; completed: boolean; verified: boolean; refresh(state: State): void; onAdvice(message: string): void; onError(message: string): void; onStatus(message: string | undefined): void; onTerminalInsertionChange?(insertCommand: (() => void) | undefined): void }) {
  const terminalElement = useRef<HTMLDivElement | null>(null);
  const terminal = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const socket = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const [connectionEpoch, setConnectionEpoch] = useState(0);

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
      let frame: PublicTerminalMessage | undefined;
      // An unreadable frame is reported and dropped: throwing here would leave the socket open
      // while the learner watched a terminal that had stopped answering.
      try { frame = parsePublicTerminalMessage(event.data); }
      catch { onError(UNREADABLE_TERMINAL_FRAME); return; }
      if (!frame) return;
      if (frame.type === "output") nextTerminal.write(frame.data);
      if (frame.type === "advice" && frame.blockId === block.id) onAdvice(frame.message);
      if (frame.type === "attempt-status" && frame.blockId === block.id) onStatus(frame.status === "running" ? "Running — waiting for terminal output…" : "Checking…");
      if (frame.type === "attempt-error" && frame.blockId === block.id) onError(frame.message);
      if (frame.type === "verified-complete" && frame.blockId === block.id) {
        // The only socket frame carrying server state, so it reaches React through the same
        // validation the HTTP responses use rather than as an unchecked object.
        let state: State;
        try { state = parsePublicWorkbookState(frame.state); }
        catch { onError(UNREADABLE_TERMINAL_FRAME); return; }
        onStatus(undefined);
        refresh(state);
      }
      if (frame.type === "busy" || frame.type === "terminal-error") onError(frame.message);
      if (frame.type === "exit") onStatus("The embedded shell exited. Refresh the page to start a new one.");
    });
    ws.addEventListener("close", () => setConnected(false));
    ws.addEventListener("error", () => { setConnected(false); onError("Embedded terminal connection failed. Refresh the page and try again."); });
    addEventListener("resize", sendResize);
    return () => {
      removeEventListener("resize", sendResize);
      dataDisposable.dispose();
      ws.close();
      nextTerminal.dispose();
      terminal.current = null;
      fit.current = null;
      socket.current = null;
      setConnected(false);
    };
  }, [active, completed, verified, block.id, refresh, onAdvice, onError, onStatus]);

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

export function completionAgeLabel(completedAt: string | undefined, now = Date.now()): string {
  if (!completedAt) return "Completed";
  const elapsedSeconds = Math.max(0, Math.floor((now - Date.parse(completedAt)) / 1_000));
  if (!Number.isFinite(elapsedSeconds) || elapsedSeconds < 60) return "Completed just now";
  if (elapsedSeconds < 3_600) return `Completed ${Math.floor(elapsedSeconds / 60)}m ago`;
  if (elapsedSeconds < 86_400) return `Completed ${Math.floor(elapsedSeconds / 3_600)}h ago`;
  if (elapsedSeconds < 604_800) return `Completed ${Math.floor(elapsedSeconds / 86_400)}d ago`;
  return "Completed";
}

function CompletionMarker({ completedAt }: { completedAt?: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return <span className="continuation-completed">✓ <time dateTime={completedAt}>{completionAgeLabel(completedAt, now)}</time></span>;
}

export function ContinuationPageBreak({ completedAt }: { completedAt?: string }) {
  return <div className="continuation-controls"><CompletionMarker completedAt={completedAt} /><div className="continuation-page-break" aria-hidden="true" /></div>;
}

export function ContinueControls({ block, state, refresh, label, preserveCompletedBreak = false }: { block: Block; state: BlockProgress | undefined; refresh(state: State): void; label?: string; preserveCompletedBreak?: boolean }) {
  const { active, pending, continueOnce } = useContinueOnce(block, state, refresh);

  if (state?.completed) return preserveCompletedBreak ? <ContinuationPageBreak completedAt={state.completedAt} /> : <p className="next-ready">The next step has appeared below.</p>;
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
    <h2>{block.title}</h2>
    <Markdown source="authored">{block.markdown}</Markdown>
    <ContinueControls block={block} state={state} refresh={refresh} label={continueLabel} />
  </section>;
}

function TerminalBlock({ lessonId, block, state, refresh, showAuthoredContent = true, onTerminalInsertionChange, feedbackHost, continueLabel }: { lessonId: string; block: Block; state: BlockProgress | undefined; refresh(state: State): void; showAuthoredContent?: boolean; onTerminalInsertionChange?(insertCommand: (() => void) | undefined): void; feedbackHost?: HTMLElement | null; continueLabel?: string }) {
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
  const feedback = !accepted && liveFeedback && <aside className={`live-block-feedback${feedbackHost === undefined ? " terminal-feedback-overlay" : " practice-feedback"}`} aria-live="polite"><Markdown source="generated">{liveFeedback}</Markdown></aside>;
  const feedbackInTerminal = feedbackHost === undefined ? feedback : null;
  const feedbackOutsideBand = feedbackHost === undefined ? null : feedbackHost ? createPortal(feedback, feedbackHost) : null;
  useEffect(() => { setObserverFeedback(undefined); setObserverStatus(undefined); }, [block.id, state?.completed, state?.checkpoint?.status]);
  return <section id={blockElementId(lessonId, block.id)} className={`work-block terminal ${state?.active ? "is-active" : ""}`}>
    {showAuthoredContent && <><p className="section-label">Practice · embedded terminal</p><h2>{block.title}</h2><Markdown source="authored">{block.markdown}</Markdown></>}
    {accepted && state ? <AcceptedCheckpoint block={block} state={state} refresh={refresh} continueLabel={continueLabel} /> : state?.verified ? <div className="frozen-terminal" aria-label="Frozen terminal session" dangerouslySetInnerHTML={{ __html: state.terminalHtml || "<pre class=\"frozen-terminal-output\">Terminal session frozen.</pre>" }} /> : showLiveTerminal && <div className={`terminal-live-surface${liveFeedback && feedbackHost === undefined ? " has-feedback" : ""}`}>
      <EmbeddedTerminal block={block} command={command} active={Boolean(state?.active)} completed={Boolean(state?.completed)} verified={false} refresh={refresh} onAdvice={setObserverFeedback} onError={setObserverFeedback} onStatus={setObserverStatus} onTerminalInsertionChange={onTerminalInsertionChange} />
      {feedbackInTerminal}
    </div>}
    {!showLiveTerminal && feedbackInTerminal}
    {feedbackOutsideBand}
  </section>;
}

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

  // One channel, as the terminal has: whatever the learner most needs to read sits welded to the
  // bottom of the work surface. Feedback outranks the running status, which outranks nothing.
  const liveFeedback = localError ?? state?.checkpoint?.feedback ?? editorStatusText(state, completed);
  return <section id={blockElementId(lessonId, block.id)} className={`work-block editor-practice ${state?.active ? "is-active" : ""}`}>
    {showAuthoredContent && <><p className="section-label">Practice · embedded editor</p><h2>{block.title}</h2><Markdown source="authored">{block.markdown}</Markdown></>}
    <div className="editor-target"><span>Target file</span><code>{block.path}</code></div>
    {canEdit && <div className={`editor-live-surface${liveFeedback ? " has-feedback" : ""}`}>
      <div ref={editorElement} className="editor-surface" aria-label={`Editor for ${block.path}`} />
      {liveFeedback && <aside className="live-block-feedback editor-feedback-overlay" aria-live="polite"><Markdown source="generated">{liveFeedback}</Markdown></aside>}
    </div>}
    {accepted && state ? <AcceptedCheckpoint block={block} state={state} refresh={refresh} continueLabel={continueLabel} /> : completed ? <aside className="success-checkpoint editor-unlocked" aria-live="polite">
      <span className="success-check" aria-hidden="true">✓</span><div><p className="section-label">Unlocked</p><h3>Accepted revision unlocked the next step.</h3><p>{state?.checkpoint?.successMessage || "The latest accepted editor draft was written to the target file."}</p></div>
    </aside> : !canEdit && <p className="next-ready">This editor practice will unlock when you reach this block.</p>}
  </section>;
}

function ReflectionBlock({ lessonId, block, state, turns, refresh, continueLabel }: { lessonId: string; block: Block; state: BlockProgress | undefined; turns: ReflectionTurn[]; refresh(state: State): void; continueLabel?: string }) {
  const accepted = state?.checkpoint?.status === "accepted";
  const visibleTurns = accepted ? state?.checkpoint?.evidence?.conversation ?? turns : turns;
  return <section id={blockElementId(lessonId, block.id)} className={`work-block reflection ${state?.active ? "is-active" : ""}`}><p className="section-label">Reflection · discuss it</p><h2>{block.title}</h2><div className="question"><Markdown source="authored">{block.markdown}</Markdown></div>
    {visibleTurns.length > 0 && !accepted && <div className="reflection-thread" aria-live="polite">{visibleTurns.map((turn, index) => <div key={index} className={`reflection-turn ${turn.role}`}><b>{turn.role === "learner" ? "You" : "Tutor"}</b><p>{turn.text}</p></div>)}</div>}
    {accepted && state ? <AcceptedCheckpoint block={block} state={state} refresh={refresh} continueLabel={continueLabel} /> : state?.completed ? <p className="next-ready">Reflection complete. The next step has appeared below.</p> : <AttemptCheckpointStatus state={state} />}
  </section>;
}

export function BlockView({ lessonId, block, progress, refresh, showAuthoredContent = true, onTerminalInsertionChange, feedbackHost, continueLabel }: { lessonId?: string; block: Block; progress: Progress; refresh(state: State): void; showAuthoredContent?: boolean; onTerminalInsertionChange?(insertCommand: (() => void) | undefined): void; feedbackHost?: HTMLElement | null; continueLabel?: string }) {
  const resolvedLessonId = lessonId ?? progress.activeLessonId;
  const state = stateForBlock(progress, resolvedLessonId, block);
  if (block.type === "narrative") return <NarrativeBlock lessonId={resolvedLessonId} block={block} state={state} refresh={refresh} continueLabel={continueLabel} />;
  if (block.type === "terminal-practice") return <TerminalBlock lessonId={resolvedLessonId} block={block} state={state} refresh={refresh} showAuthoredContent={showAuthoredContent} onTerminalInsertionChange={onTerminalInsertionChange} feedbackHost={feedbackHost} continueLabel={continueLabel} />;
  if (block.type === "editor-practice") return <EditorPracticeBlockView lessonId={resolvedLessonId} block={block} state={state} refresh={refresh} showAuthoredContent={showAuthoredContent} continueLabel={continueLabel} />;
  return <ReflectionBlock lessonId={resolvedLessonId} block={block} state={state} turns={activeLessonValue(progress, resolvedLessonId, progress.reflectionConversations[block.id], [])} refresh={refresh} continueLabel={continueLabel} />;
}

function WorkbookIntroduction({ state, refresh }: { state: State; refresh(state: State): void }) {
  return <section className="workbook-intro" aria-label="Workbook introduction">
    <header><h1>{state.workbook.title}</h1></header>
    <Markdown source="authored">{state.introduction}</Markdown>
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
    {chapter.lesson.introduction.trim() && <section className="lesson-introduction"><Markdown source="authored">{chapter.lesson.introduction}</Markdown></section>}
    {renderBlocks && chapter.lesson.blocks.map((block) => <BlockView key={block.id} lessonId={chapter.id} block={block} progress={progress} refresh={refresh} />)}
    {children}
  </article>;
}

function PartChapter({ chapter }: { chapter: Chapter }) {
  if (!chapter.part || !chapter.partMarkdown) return null;
  return <section id={`part-${chapter.id}`} className="part-chapter" aria-label={chapter.part}><div><p className="part-title">{chapter.part}</p><div className="part-copy"><Markdown source="authored">{chapter.partMarkdown}</Markdown></div></div></section>;
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

/**
 * Which block carries the tall scroll runway that lets the newest revealed block reach the top of
 * the viewport. It belongs to the ready successor while the server reports one, and stays with that
 * block after the learner continues into it: promotion drops the block out of readyBlockIds, and
 * without the runway the page would lose the height it was already scrolled through.
 *
 * The server already says everything needed to place it, so this reads state rather than
 * remembering renders. A block is where the runway goes when it is the ready successor, or when it
 * is the uncompleted active block whose predecessor's work was accepted — which is exactly how it
 * became a ready successor in the first place. Deriving it keeps App's render pure, and means a
 * reload lands on the same layout as the promotion that preceded it.
 */
export function scrollRunwayBlockIds(state: State): string[] {
  const ready = [...new Set(state.readyBlockIds ?? state.progress.readyBlocks ?? [])];
  if (ready.length > 0) return ready;
  if (state.progress.workbookComplete) return [];
  const blocks = state.progress.blocks;
  const activeIndex = blocks.findIndex((block) => block.id === state.progress.activeBlockId);
  if (activeIndex < 1) return [];
  const active = blocks[activeIndex]!;
  const predecessor = blocks[activeIndex - 1]!;
  if (active.completed) return [];
  const predecessorAccepted = predecessor.workAccepted === true || (state.progress.workAcceptedBlocks?.includes(predecessor.id) ?? false);
  return predecessorAccepted ? [active.id] : [];
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
  const failures = state.timeline?.filter((record): record is Extract<PublicTimelineRecord, { type: "tutor_failed" }> =>
    record.type === "tutor_failed" && record.blockId === "workbook--complete") ?? [];
  return <section id={state.completion.anchorId} className="workbook-completion-panel work-block" tabIndex={-1} aria-live="polite">
    <p className="section-label">Workbook complete</p>
    <h1>You finished the workbook.</h1>
    {state.completion.summary ? <Markdown source="generated">{state.completion.summary}</Markdown> : <p>The tutor is preparing your completion summary.</p>}
    {failures.map((failure) => <aside key={failure.id} className="timeline-message tutor failure" aria-live="polite"><b>Summary unavailable</b><p>{failure.publicMessage}</p><button className="button secondary" onClick={() => void onRetry(failure.failureId)}>Retry</button></aside>)}
  </section>;
}

export function App() {
  const [state, setState] = useState<State>();
  const [viewed, setViewed] = useState<string>();
  const [terminalInsertion, setTerminalInsertion] = useState<(() => void) | undefined>();
  const [contentReloadError, setContentReloadError] = useState<string>();
  const scrollCompletionPending = useRef(false);
  const sseStateRequestSequence = useRef(0);
  const initialAnchorReconciled = useRef(false);
  const registerTerminalInsertion = useCallback((insertCommand: (() => void) | undefined) => {
    setTerminalInsertion(() => insertCommand);
  }, []);
  useEffect(() => { readWorkbookState().then(setState).catch((error) => console.error(error)); }, []);
  const hasInitialState = Boolean(state);
  useEffect(() => {
    if (!hasInitialState || typeof EventSource === "undefined") return;
    const events = new EventSource("api/workbook/timeline");
    const refreshFromSse = (options: { contentReload?: boolean } = {}) => {
      const requestSequence = ++sseStateRequestSequence.current;
      readWorkbookState().then((next) => {
        if (requestSequence !== sseStateRequestSequence.current) return;
        if (options.contentReload) setContentReloadError(undefined);
        setState(next);
      }).catch((error) => {
        if (requestSequence !== sseStateRequestSequence.current) return;
        console.error(error);
        if (options.contentReload) setContentReloadError("Workbook content reloaded, but the browser could not fetch the new state yet.");
      });
    };
    events.addEventListener("record", () => refreshFromSse());
    events.addEventListener("state", () => refreshFromSse());
    events.addEventListener("content-reloaded", () => refreshFromSse({ contentReload: true }));
    events.addEventListener("content-reload-error", (event) => {
      try {
        const payload = JSON.parse((event as MessageEvent).data) as { message?: string };
        setContentReloadError(payload.message || "Workbook content could not be reloaded yet.");
      } catch {
        setContentReloadError("Workbook content could not be reloaded yet.");
      }
    });
    return () => events.close();
  }, [hasInitialState]);
  useEffect(() => { if (state) document.title = state.workbook.title; }, [state?.workbook.title]);
  useEffect(() => {
    if (!state) return;
    const fragment = typeof location === "undefined" ? "" : decodeURIComponent(location.hash.replace(/^#/, ""));
    const revealed = new Set(state.revealedBlockIds ?? state.progress.blocks.filter((block) => block.emerged).map((block) => block.id));
    const fragmentIsValid = Boolean(fragment && (revealed.has(fragment) || fragment === "workbook--complete" && state.progress.workbookComplete));
    const activeAnchor = state.progress.activeAnchorId ?? state.progress.activeBlockId;
    const target = !fragment || !fragmentIsValid ? activeAnchor : !initialAnchorReconciled.current ? fragment : undefined;
    const mode = !fragment || !fragmentIsValid ? "replace" : "none";
    if (!target) return;
    return scheduleAnchorAnimationFrame(() => {
      initialAnchorReconciled.current = true;
      navigateToAnchor(target, mode);
    });
  }, [state]);
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
  const activeContinuationEligible = !state.introductionComplete ? true : state.progress.canComplete ? state.progress.canComplete.blockId === effectiveActiveBlockId && state.progress.canComplete.eligible : Boolean(effectiveActiveBlockProgress?.active && effectiveActiveBlockProgress.ready && !effectiveActiveBlockProgress.completed && (activeBlock?.type === "narrative" || effectiveActiveBlockProgress.checkpoint?.status === "accepted"));
  const activeReflectionReviewing = Boolean(state.introductionComplete && activeBlock?.type === "reflection" && activeBlockProgress?.checkpoint?.status === "reviewing");
  const reflectionComposerDisabled = Boolean(state.introductionComplete && activeBlock?.type === "reflection" && ["reviewing", "accepted"].includes(activeBlockProgress?.checkpoint?.status ?? ""));
  const stableRunwayIds = scrollRunwayBlockIds(state);
  const activeContinueBlock: Block = activeBlock ?? { id: effectiveActiveBlockId, type: "narrative", title: state.currentBlock?.title ?? state.workbook.title, markdown: "" };
  const renderTimelineContinuation = (record: PublicTimelineRecord) => {
    if (record.type !== "message") return null;
    const blockProgress = state.progress.blocks.find((block) => block.id === record.blockId);
    const recordIsActive = record.blockId === effectiveActiveBlockId && (record.lessonId === effectiveActiveLessonId || effectiveActiveBlockId.includes("--"));
    if (recordIsActive && activeContinuationEligible && effectiveActiveBlockProgress) {
      return <ContinueControls block={activeContinueBlock} state={effectiveActiveBlockProgress} refresh={setState} label={continueLabelFor(state, effectiveActiveBlockId)} />;
    }
    if (!recordIsActive && blockProgress?.completed) return <ContinuationPageBreak completedAt={blockProgress.completedAt} />;
    return null;
  };
  return <div className="shell">
    {contentReloadError && <aside className="author-reload-notice" aria-live="polite"><b>Author reload failed.</b> {contentReloadError}</aside>}
    <AcceptanceConfetti acceptedKey={activeAcceptedKey(state.progress)} />
    <LessonRail title={state.workbook.title} chapters={state.chapters} progress={state.progress} viewedLessonId={viewedLesson} setViewedLesson={setViewed} orderedBlocks={state.orderedBlocks} />
    <main><article className="page">
      {hasTimeline ? <>
        <TimelineThread records={state.timeline ?? []} activeLessonId={effectiveActiveLessonId} activeBlockId={effectiveActiveBlockId} onSend={sendTutorText} onRetry={(failureId) => retryTutorOperation(failureId).then((next) => setState(next))} onDoItForMe={terminalInsertion} inputDisabled={reflectionComposerDisabled} activeReflectionReviewing={activeReflectionReviewing} renderContinuation={renderTimelineContinuation} readyBlockIds={stableRunwayIds} activeSurface={activeChapter && activeBlock ? <ActivityBand lessonId={activeChapter.id} activeBlock={activeBlock} progress={state.progress} refresh={setState} onTerminalInsertionChange={registerTerminalInsertion} /> : undefined} completionPanel={<CompletionPanel state={state} onRetry={(failureId) => retryTutorOperation(failureId).then((next) => setState(next))} />} />
      </> : <>
        <WorkbookIntroduction state={state} refresh={setState} />
        {emerged.map((chapter, index) => <React.Fragment key={chapter.id}>{(index === 0 || chapter.part !== emerged[index - 1]!.part) && <PartChapter chapter={chapter} />}<LessonView chapter={chapter} progress={state.progress} refresh={setState} /></React.Fragment>)}
      </>}
    </article></main>
  </div>;
}
