import React, { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { defaultKeymap } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { Markdown } from "./markdown.js";
import { lessonElementId } from "../../src/workbook/lesson-links.js";
import { ActivityBand } from "./activity-band.js";
import { TimelineThread } from "./timeline-thread.js";
import { isPublicWorkbookState, parsePublicCompleteBlockResult, parsePublicWorkbookState } from "../../src/workbook/public-contract.js";
import type { PublicCheckpoint, PublicCompleteBlockResult, PublicTimelineRecord, PublicWorkbookBlock, PublicWorkbookBlockProgress, PublicWorkbookChapter, PublicWorkbookLesson, PublicWorkbookProgress, PublicWorkbookState } from "../../src/workbook/public-contract.js";
import { parsePublicTerminalMessage, type PublicTerminalFrame } from "../../src/workbook/public-terminal-contract.js";
import { createTerminalCoachingDisplayState, reduceTerminalCoachingDisplay, type TerminalCoachingDisplayState } from "./terminal-coaching-display.js";

// A short local vocabulary for the contract types this module uses constantly. Only names that
// earn their keep are kept: the seven aliases that nothing referenced are gone.
export type Block = PublicWorkbookBlock;
export type EditorPracticeBlock = Extract<Block, { type: "editor-practice" }>;
export type Lesson = PublicWorkbookLesson;
export type Chapter = PublicWorkbookChapter;
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
function stateForBlock(progress: Progress, lessonId: string, block: Block): BlockProgress | undefined { return lessonId === progress.activeLessonId ? progressFor(progress, block.id) : undefined; }
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

/**
 * The terminal socket is addressed the way `request()` addresses HTTP: relative to the document's
 * base, with `api/workbook/` as the prefix this module owns. `WebSocket` accepts no relative URL,
 * so the base is resolved here and only the scheme is swapped. Deriving the address from the base
 * rather than from `location.host` plus an absolute path is what keeps a prefix the workbook is
 * mounted under in the address, because an absolute path would drop it.
 */
function terminalSocketUrl(): string {
  const url = new URL("api/workbook/terminal", document.baseURI);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}

export function FrozenTerminal({ text }: { text?: string }) {
  return <div className="frozen-terminal" aria-label="Frozen terminal session">
    <pre className="frozen-terminal-output">{text ?? "Terminal completed."}</pre>
  </div>;
}

/** xterm's mutable input option lets a ready canvas connect and render without accepting keystrokes. */
function setTerminalInteractivity(terminal: Terminal | null, element: HTMLDivElement | null, interactive: boolean) {
  if (terminal) terminal.options.disableStdin = !interactive;
  if (!element) return;
  element.toggleAttribute("inert", !interactive);
  element.style.pointerEvents = interactive ? "" : "none";
  if (interactive) element.removeAttribute("aria-disabled");
  else element.setAttribute("aria-disabled", "true");
  const helperTextarea = element.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea");
  if (helperTextarea) helperTextarea.disabled = !interactive;
}

function EmbeddedTerminal({ command, active, onError, onTerminalInsertionChange }: { command?: string; active: boolean; onError(message: string): void; onTerminalInsertionChange?(insertCommand: (() => void) | undefined): void }) {
  const terminalPanel = useRef<HTMLDivElement | null>(null);
  const terminalElement = useRef<HTMLDivElement | null>(null);
  const terminal = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const socket = useRef<WebSocket | null>(null);
  const interactive = useRef(active);
  const [connected, setConnected] = useState(false);
  const [connectionEpoch, setConnectionEpoch] = useState(0);

  // This changes input authority in place. It deliberately does not participate in the setup
  // effect below, so promoting a ready terminal keeps its xterm instance and WebSocket alive.
  useEffect(() => {
    interactive.current = active;
    setTerminalInteractivity(terminal.current, terminalElement.current, active);
  }, [active]);

  useEffect(() => {
    if (!terminalElement.current) return;
    const nextTerminal = new Terminal({ cursorBlink: true, convertEol: true, disableStdin: !interactive.current, fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 16, theme: { background: "#101820" } });
    const nextFit = new FitAddon();
    nextTerminal.loadAddon(nextFit);
    nextTerminal.open(terminalElement.current);
    nextFit.fit();
    terminal.current = nextTerminal;
    fit.current = nextFit;
    setTerminalInteractivity(nextTerminal, terminalElement.current, interactive.current);

    const ws = new WebSocket(terminalSocketUrl());
    socket.current = ws;
    const sendResize = () => {
      const dimensions = nextFit.proposeDimensions();
      if (!dimensions || dimensions.cols === nextTerminal.cols && dimensions.rows === nextTerminal.rows) return;
      nextFit.fit();
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "resize", cols: nextTerminal.cols, rows: nextTerminal.rows }));
    };
    const sendCurrentDimensions = () => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "resize", cols: nextTerminal.cols, rows: nextTerminal.rows }));
    };
    const dataDisposable = nextTerminal.onData((data) => {
      if (interactive.current && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "input", data }));
    });
    ws.addEventListener("open", () => { setConnected(true); setConnectionEpoch((epoch) => epoch + 1); sendCurrentDimensions(); });
    ws.addEventListener("message", (event) => {
      let frame: PublicTerminalFrame | undefined;
      // An unreadable frame is reported and dropped: throwing here would leave the socket open
      // while the learner watched a terminal that had stopped answering.
      try { frame = parsePublicTerminalMessage(event.data); }
      catch { onError(UNREADABLE_TERMINAL_FRAME); return; }
      if (!frame) return;
      if (frame.type === "output") nextTerminal.write(frame.data);
      // Socket frames are terminal transport only. Workbook state carries the learner lifecycle.
      if (frame.type === "busy" || frame.type === "terminal-error") onError(frame.message);
      if (frame.type === "exit") onError("The embedded shell exited. Refresh the page to start a new one.");
    });
    ws.addEventListener("close", () => setConnected(false));
    ws.addEventListener("error", () => { setConnected(false); onError("Embedded terminal connection failed. Refresh the page and try again."); });
    const ResizeObserverClass = window.ResizeObserver;
    const resizeObserver = ResizeObserverClass ? new ResizeObserverClass(sendResize) : undefined;
    resizeObserver?.observe(terminalElement.current);
    addEventListener("resize", sendResize);
    return () => {
      resizeObserver?.disconnect();
      removeEventListener("resize", sendResize);
      dataDisposable.dispose();
      ws.close();
      nextTerminal.dispose();
      terminal.current = null;
      fit.current = null;
      socket.current = null;
      setConnected(false);
    };
  }, [onError]);

  const insertCommand = useCallback(() => {
    if (!interactive.current || !command) return;
    const data = commandForInsertion(command);
    if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify({ type: "input", data }));
  }, [command]);

  useEffect(() => {
    if (!active || !command || !connected || socket.current?.readyState !== WebSocket.OPEN) {
      onTerminalInsertionChange?.(undefined);
      return;
    }
    onTerminalInsertionChange?.(insertCommand);
    return () => onTerminalInsertionChange?.(undefined);
  }, [active, command, connected, connectionEpoch, insertCommand, onTerminalInsertionChange]);

  return <div ref={terminalPanel} className="embedded-terminal-panel">
    <span className={`terminal-connection-status${connected ? " connected" : ""}`} aria-label={connected ? "Terminal connected" : "Terminal disconnected"} />
    <div ref={terminalElement} className="embedded-terminal" aria-label="Embedded terminal" aria-disabled={active ? undefined : "true"} />
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

export function ContinueControls({ block, state, refresh, label }: { block: Block; state: BlockProgress | undefined; refresh(state: State): void; label?: string }) {
  const { active, pending, continueOnce } = useContinueOnce(block, state, refresh);

  if (state?.completed) return <p className="next-ready">The next step has appeared below.</p>;
  if (!active) return null;
  const buttonLabel = label ?? (block.id === "workbook--introduction" ? "Ready to continue" : "Continue");
  return <div className="continuation-controls">
    <button className="button primary" disabled={pending} onClick={() => continueOnce("push")}>{pending ? "Continuing…" : buttonLabel}</button>
    <div className="continuation-page-break" aria-hidden="true" />
  </div>;
}

function initialTerminalDisplay(state: BlockProgress | undefined): TerminalCoachingDisplayState {
  return reduceTerminalCoachingDisplay(createTerminalCoachingDisplayState(), { type: "server-state", terminal: state?.terminal });
}

export function TerminalHistory({ state }: { state: BlockProgress | undefined }) {
  if (!state?.terminalSnapshot) return null;
  return <div className="terminal-history" aria-label="Completed terminal output">
    <FrozenTerminal text={state.terminalSnapshot.transcript} />
    {state.terminal?.phase === "complete" && <aside className="terminal-history-complete"><Markdown source="generated">{state.terminal.message}</Markdown></aside>}
  </div>;
}

function TerminalBlock({ block, state, onTerminalInsertionChange }: { block: Block; state: BlockProgress | undefined; onTerminalInsertionChange?(insertCommand: (() => void) | undefined): void }) {
  const command = shellCommandFrom(block.markdown);
  const [display, dispatch] = useReducer(reduceTerminalCoachingDisplay, state, initialTerminalDisplay);
  const [terminalError, setTerminalError] = useState<string>();

  useEffect(() => {
    dispatch({ type: "server-state", terminal: state?.terminal });
    // A later authoritative lifecycle state replaces a transport error in the same one card.
    if (state?.terminal) setTerminalError(undefined);
  }, [state?.terminal]);
  const complete = state?.terminal?.phase === "complete" || display.phase === "complete";
  const showLiveTerminal = !state?.completed && !complete;
  const preloading = Boolean(state?.ready && !state.active && !state.completed);
  const text = terminalError ?? (display.phase === "idle" ? undefined : display.text);
  // Exactly one in-place learner-facing node represents status, feedback, completion, or a
  // transport error. It is never moved into the activity/timeline portal.
  const displayPanel = text ? <aside className={`live-block-feedback terminal-feedback-overlay${display.phase === "running" ? " running" : ""}`} aria-live="polite" role="status">{display.phase === "running" && <span className="terminal-running-spinner" aria-hidden="true" />}<Markdown source="generated">{text}</Markdown></aside> : null;
  return <div className={`work-block terminal ${state?.active ? "is-active" : ""}`}>
    {showLiveTerminal && <div className={`terminal-live-surface${displayPanel ? " has-feedback" : ""}`}>
      <EmbeddedTerminal command={command} active={Boolean(state?.active)} onError={setTerminalError} onTerminalInsertionChange={onTerminalInsertionChange} />
      {displayPanel}
    </div>}
    {!showLiveTerminal && !complete && displayPanel}
    {preloading && <p className="terminal-coaching-activity subtle">Preparing terminal…</p>}
  </div>;
}

function editorStatusText(state: BlockProgress | undefined, completed: boolean): string {
  if (completed || state?.editorStatus === "unlocked" || state?.checkpoint?.status === "accepted") return "Unlocked — the accepted revision has been written to the target file.";
  if (state?.checkpoint?.status === "reviewing" || state?.editorStatus === "reviewing") return "Reviewing your latest revision…";
  if (state?.checkpoint?.status === "working") return "Keep writing — the tutor will review after you pause.";
  if (state?.editorStatus === "waiting") return "Keep writing — the reviewer will check again after you pause.";
  if (state?.checkpoint?.status === "feedback" || state?.editorStatus === "feedback") return "Feedback received — keep editing and pause to request another review.";
  return "Editing — changes are reviewed automatically after you pause.";
}

function EditorPracticeBlockView({ block, state, refresh }: { block: EditorPracticeBlock; state: BlockProgress | undefined; refresh(state: State): void }) {
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
  // The editor is seeded once, when it opens. draftText changes on every server review, so making
  // the creation effect below depend on it would destroy and rebuild the view mid-typing and take
  // the learner's cursor with it. Syncing through a ref lets that effect depend on stable values
  // and still read the current draft. The sync is an effect, not a render-phase write, and is
  // declared above the creation effect so it has run before the view is built.
  const initialTextRef = useRef(initialText);
  useEffect(() => { initialTextRef.current = initialText; }, [initialText]);

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
        doc: initialTextRef.current,
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
  return <div className={`work-block editor-practice ${state?.active ? "is-active" : ""}`}>
    <div className="editor-target"><span>Target file</span><code>{block.path}</code></div>
    {canEdit && <div className={`editor-live-surface${liveFeedback ? " has-feedback" : ""}`}>
      <div ref={editorElement} className="editor-surface" aria-label={`Editor for ${block.path}`} />
      {liveFeedback && <aside className="live-block-feedback editor-feedback-overlay" aria-live="polite"><Markdown source="generated">{liveFeedback}</Markdown></aside>}
    </div>}
    {completed ? <aside className="success-checkpoint editor-unlocked" aria-live="polite">
      <span className="success-check" aria-hidden="true">✓</span><div><p className="section-label">Unlocked</p><h3>Accepted revision unlocked the next step.</h3><p>{state?.checkpoint?.successMessage || "The latest accepted editor draft was written to the target file."}</p></div>
    </aside> : !canEdit && <p className="next-ready">This editor practice will unlock when you reach this block.</p>}
  </div>;
}

export function BlockView({ lessonId, block, progress, refresh, onTerminalInsertionChange }: { lessonId?: string; block: Block; progress: Progress; refresh(state: State): void; onTerminalInsertionChange?(insertCommand: (() => void) | undefined): void }) {
  const resolvedLessonId = lessonId ?? progress.activeLessonId;
  const state = stateForBlock(progress, resolvedLessonId, block);
  if (block.type === "terminal-practice") return <TerminalBlock block={block} state={state} onTerminalInsertionChange={onTerminalInsertionChange} />;
  if (block.type === "editor-practice") return <EditorPracticeBlockView block={block} state={state} refresh={refresh} />;
  return null;
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
  const accepted = progress.blocks.find((block) => block.active && !block.completed && (block.checkpoint?.status === "accepted" || block.terminal?.phase === "complete"));
  if (!accepted) return undefined;
  const evidence = accepted.checkpoint?.evidence;
  const message = accepted.terminal?.phase === "complete" ? accepted.terminal.message : accepted.checkpoint?.successMessage ?? accepted.checkpoint?.summary ?? "accepted";
  return `${progress.activeLessonId}/${accepted.id}/${evidence?.kind ?? "terminal"}/${message}`;
}

function readySuccessorId(progress: Progress): string | undefined {
  return progress.blocks.find((block) => block.ready && !block.active && !block.completed)?.id ?? progress.readyBlocks?.[0];
}

type PracticeSurfaceSource = { lessonId: string; block: Block };

function renderedBlockSource(state: State, blockId: string): PracticeSurfaceSource | undefined {
  for (const chapter of state.chapters) {
    const block = chapter.lesson?.blocks.find((candidate) => candidate.id === blockId);
    if (block) return { lessonId: chapter.id, block };
  }
  return undefined;
}

/** Select the sole practice surface without making non-ready authored content renderable. */
function practiceSurfaceSource(state: State): PracticeSurfaceSource | undefined {
  const active = progressFor(state.progress, state.progress.activeBlockId);
  const activeSource = renderedBlockSource(state, state.progress.activeBlockId);
  if (active?.active && !active.completed && activeSource && ["terminal-practice", "editor-practice"].includes(activeSource.block.type) && !(activeSource.block.type === "terminal-practice" && active.terminal?.phase === "complete")) return activeSource;
  // A terminal's accepted snapshot replaces its live xterm before the learner continues. Do not
  // preload a distinct ready terminal from the old shell; continuation resets that transport.
  if (activeSource?.block.type === "terminal-practice" && active?.terminal?.phase === "complete") return undefined;

  const readyId = readySuccessorId(state.progress);
  const ready = readyId ? progressFor(state.progress, readyId) : undefined;
  if (!readyId || !ready?.ready || ready.active || ready.completed || ready.type !== "terminal-practice") return undefined;
  return renderedBlockSource(state, readyId);
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
  const [terminalInsertion, setTerminalInsertion] = useState<{ blockId: string; insertCommand: () => void }>();
  const [contentReloadError, setContentReloadError] = useState<string>();
  const scrollCompletionPending = useRef(false);
  const sseStateRequestSequence = useRef(0);
  const initialAnchorReconciled = useRef(false);
  const registerTerminalInsertion = useCallback((blockId: string, insertCommand: (() => void) | undefined) => {
    setTerminalInsertion((current) => insertCommand ? { blockId, insertCommand } : current?.blockId === blockId ? undefined : current);
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
  const workbookTitle = state?.workbook.title;
  useEffect(() => { if (workbookTitle) document.title = workbookTitle; }, [workbookTitle]);
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
  // The four dependencies this effect used to carry — the active block, the completion flag, and
  // two `.join("|")` hashes of the ready-block arrays — were all approximating one question: has
  // the ready successor changed? It computes that id anyway, so hoisting it makes the dependency
  // exact instead of a hash of the inputs the id is derived from, and the effect re-runs when the
  // successor actually moves rather than whenever either array is rebuilt.
  const readySuccessorAnchorId = state ? readySuccessorId(state.progress) : undefined;
  const runwayActiveBlockId = state?.progress.activeBlockId;
  const runwayWorkbookComplete = state?.progress.workbookComplete;
  useEffect(() => {
    if (runwayWorkbookComplete || typeof IntersectionObserver === "undefined") return;
    const readyId = readySuccessorAnchorId;
    const activeId = runwayActiveBlockId;
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
  }, [readySuccessorAnchorId, runwayActiveBlockId, runwayWorkbookComplete]);
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
  if (!state) return <p className="loading">Loading workbook…</p>;
  const viewedLesson = viewed ?? state.progress.activeLessonId;
  const activeChapter = state.chapters.find((chapter): chapter is Chapter & { lesson: Lesson } => chapter.id === state.progress.activeLessonId && Boolean(chapter.lesson));
  const activeBlock = activeChapter?.lesson.blocks.find((block) => block.id === state.progress.activeBlockId);
  const activitySource = practiceSurfaceSource(state);
  const activeBlockProgress = state.progress.blocks.find((block) => block.id === state.progress.activeBlockId);
  const effectiveActiveLessonId = state.progress.workbookComplete ? "workbook--complete" : state.introductionComplete ? state.progress.activeLessonId : INTRODUCTION_LESSON_ID;
  const effectiveActiveBlockId = state.progress.workbookComplete ? "workbook--complete" : state.introductionComplete ? state.progress.activeBlockId : INTRODUCTION_BLOCK_ID;
  const effectiveActiveBlockProgress = state.progress.blocks.find((block) => block.id === effectiveActiveBlockId) ?? (!state.introductionComplete ? { id: INTRODUCTION_BLOCK_ID, type: "workbook-introduction", ready: true, active: true, completed: false, verified: false, emerged: true } as BlockProgress : activeBlockProgress);
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
  const activeContinuationEligible = !state.introductionComplete ? true : state.progress.canComplete ? state.progress.canComplete.blockId === effectiveActiveBlockId && state.progress.canComplete.eligible : Boolean(effectiveActiveBlockProgress?.active && effectiveActiveBlockProgress.ready && !effectiveActiveBlockProgress.completed && (activeBlock?.type === "narrative" || effectiveActiveBlockProgress.checkpoint?.status === "accepted" || effectiveActiveBlockProgress.terminal?.phase === "complete"));
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
      <TimelineThread records={state.timeline} activeLessonId={effectiveActiveLessonId} activeBlockId={effectiveActiveBlockId} onSend={sendTutorText} onRetry={(failureId) => retryTutorOperation(failureId).then((next) => setState(next))} onDoItForMe={terminalInsertion?.blockId === effectiveActiveBlockId ? terminalInsertion.insertCommand : undefined} inputDisabled={reflectionComposerDisabled} activeReflectionReviewing={activeReflectionReviewing} renderContinuation={renderTimelineContinuation} renderTerminalHistory={(record) => <TerminalHistory state={state.progress.blocks.find((block) => block.id === record.blockId)} />} readyBlockIds={stableRunwayIds} practiceSurfaceBlockId={activitySource?.block.id} practiceSurface={activitySource ? <ActivityBand key={activitySource.block.id} lessonId={activitySource.lessonId} activeBlock={activitySource.block} progress={state.progress} refresh={setState} onTerminalInsertionChange={registerTerminalInsertion} /> : undefined} completionPanel={<CompletionPanel state={state} onRetry={(failureId) => retryTutorOperation(failureId).then((next) => setState(next))} />} />
    </article></main>
  </div>;
}
