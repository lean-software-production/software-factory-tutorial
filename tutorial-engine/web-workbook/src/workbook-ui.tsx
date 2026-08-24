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
export type BlockProgress = { id: string; type?: string; ready: boolean; active: boolean; completed: boolean; verified: boolean; checkpoint?: PublicCheckpoint; feedback?: string; terminalHtml?: string; emerged: boolean; revision?: number; draftText?: string; editorStatus?: EditorStatus };
export type Progress = { activeLessonId: string; activeBlockId: string; completedLessons: string[]; blocks: BlockProgress[]; reflections: Record<string, string>; reflectionConversations: Record<string, ReflectionTurn[]> };
type Identity = { title: string };
export type State = { workbook: Identity; introduction: string; introductionComplete: boolean; chapters: Chapter[]; progress: Progress; adapter: { note?: string; modelBackedHelp?: boolean }; timeline?: readonly PublicTimelineRecord[] };

async function completeIntroduction(): Promise<State> {
  const response = await fetch("api/workbook/introduction", { method: "POST" });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

async function post(blockId: string, body: object): Promise<State> {
  const response = await fetch("api/workbook/events", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ blockId, ...body }) });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

async function postEditorDraft(blockId: string, revision: number, text: string): Promise<State> {
  const response = await fetch("/api/workbook/editor", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ blockId, revision, text }) });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

const INTRODUCTION_BLOCK_ID = "__introduction__";
const INTRODUCTION_LESSON_ID = "workbook:introduction";

async function postTutorMessage(blockId: string, text: string): Promise<State> {
  const response = await fetch("/api/workbook/messages", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ blockId, text }) });
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

function progressFor(progress: Progress, id: string) { return progress.blocks.find((block) => block.id === id); }
function domSafe(value: string) { return value.replace(/[^A-Za-z0-9_-]+/g, "-"); }
export function scrollActiveLessonIntoView(doc: Pick<Document, "getElementById">, activeLessonId: string) { doc.getElementById(lessonElementId(activeLessonId))?.scrollIntoView({ behavior: "smooth", block: "start" }); }
function blockElementId(lessonId: string, blockId: string) { return `${lessonElementId(lessonId)}-block-${domSafe(blockId)}`; }
function completedBlockState(block: Block): BlockProgress { return { id: block.id, type: block.type, ready: true, active: false, completed: true, verified: block.type === "terminal-practice", terminalHtml: block.type === "terminal-practice" ? "<pre class=\"frozen-terminal-output\">Terminal session frozen.</pre>" : undefined, editorStatus: block.type === "editor-practice" ? "unlocked" : undefined, emerged: true }; }
function stateForBlock(progress: Progress, lessonId: string, block: Block): BlockProgress | undefined {
  if (lessonId === progress.activeLessonId) return progressFor(progress, block.id);
  if (progress.completedLessons.includes(lessonId)) return completedBlockState(block);
  return undefined;
}
function activeLessonValue<T>(progress: Progress, lessonId: string, value: T | undefined, fallback: T): T { return lessonId === progress.activeLessonId ? value ?? fallback : fallback; }
function commandForInsertion(command = "") { return command.replace(/\\\r?\n\s*/g, " "); }

const SHELL_FENCE = /^```([^`\n]*)\n([\s\S]*?)^```/gm;
const SHELL_LANGUAGES = new Set(["sh", "bash", "shell", "zsh", "console"]);
function shellCommandFrom(markdown: string): string | undefined {
  for (const match of markdown.matchAll(SHELL_FENCE)) {
    const tokens = (match[1] ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (SHELL_LANGUAGES.has(tokens[0] ?? "") && tokens.includes("command")) return match[2]?.trim();
  }
  return undefined;
}

function EmbeddedTerminal({ block, command, active, completed, verified, refresh, onAdvice, onError, onStatus, onTerminalInsertionChange }: { block: Block; command?: string; active: boolean; completed: boolean; verified: boolean; refresh(state: State): void; onAdvice(message: string): void; onError(message: string): void; onStatus(message: string): void; onTerminalInsertionChange?(insertCommand: (() => void) | undefined): void }) {
  const terminalElement = useRef<HTMLDivElement | null>(null);
  const terminal = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const socket = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(true);
  const [connectionEpoch, setConnectionEpoch] = useState(0);

  useEffect(() => {
    if (!active || completed || !terminalElement.current) return;
    const nextTerminal = new Terminal({ cursorBlink: true, convertEol: true, fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace', fontSize: 13, theme: { background: "#101820" } });
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
    ws.addEventListener("open", () => { setConnected(true); setConnectionEpoch((epoch) => epoch + 1); onStatus("Terminal connected in an isolated workbook container."); sendResize(); });
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.type === "output") nextTerminal.write(message.data);
      if (message.type === "advice" && message.blockId === block.id) onAdvice(message.message);
      if (message.type === "observer-error" && message.blockId === block.id) onError(message.message);
      if (message.type === "observer-status" && message.blockId === block.id) onStatus(message.status === "running" ? "Running — waiting for terminal output…" : message.status === "checking" ? "Checking the terminal output…" : "Keep going; the expected result is not visible yet.");
      if (message.type === "verified-complete" && message.blockId === block.id) refresh(message.state);
      if (message.type === "busy") onError(message.message);
      if (message.type === "terminal-error") onError(message.message);
      if (message.type === "exit") onStatus("The embedded shell exited. Refresh the page to start a new one.");
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
    if (!active || !command || verified || socket.current?.readyState !== WebSocket.OPEN) {
      onTerminalInsertionChange?.(undefined);
      return;
    }
    onTerminalInsertionChange?.(insertCommand);
    return () => onTerminalInsertionChange?.(undefined);
  }, [active, command, connectionEpoch, insertCommand, onTerminalInsertionChange, verified]);

  return <div className="embedded-terminal-panel">
    <span className={`terminal-connection-status${connected ? " connected" : ""}`} aria-label={connected ? "Terminal connected" : "Terminal disconnected"} />
    <div ref={terminalElement} className="embedded-terminal" aria-label="Embedded terminal" />
  </div>;
}

function useContinueOnce(block: Block, state: BlockProgress | undefined, refresh: (state: State) => void) {
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const active = Boolean(state?.active && state.ready && !state.completed);
  useEffect(() => { pendingRef.current = false; setPending(false); }, [block.id, state?.completed]);
  const continueOnce = useCallback(() => {
    if (!active || pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    post(block.id, { action: "continue" }).then(refresh).catch((error) => {
      pendingRef.current = false;
      setPending(false);
      console.error(error);
    });
  }, [active, block.id, refresh]);
  return { active, pending, continueOnce };
}

export function ContinueControls({ block, state, refresh }: { block: Block; state: BlockProgress | undefined; refresh(state: State): void }) {
  const { active, pending, continueOnce } = useContinueOnce(block, state, refresh);

  if (state?.completed) return <p className="next-ready">The next step has appeared below.</p>;
  if (!active) return null;
  return <div className="continuation-controls">
    <button className="button primary" disabled={pending} onClick={continueOnce}>{pending ? "Continuing…" : "Continue"}</button>
    <div className="block-end-sentinel" data-completion-action="continue" aria-hidden="true" />
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

export function AcceptedCheckpoint({ block, state, refresh }: { block: Block; state: BlockProgress; refresh(state: State): void }) {
  const checkpoint = state.checkpoint;
  const [pending, setPending] = useState(false);
  if (checkpoint?.status !== "accepted") return null;
  const continueAccepted = () => {
    if (pending) return;
    setPending(true);
    post(block.id, { action: "continue" }).then(refresh).catch((error) => {
      console.error(error);
      setPending(false);
    });
  };
  return <aside className="success-checkpoint accepted-checkpoint" aria-live="polite">
    <span className="success-check" aria-hidden="true">✓</span><div><p className="section-label">Accepted</p><h3>Nice work — accepted.</h3><p>{checkpointMessage(checkpoint)}</p><CheckpointEvidence checkpoint={checkpoint} /><button className="button primary" disabled={pending} onClick={continueAccepted}>{pending ? "Continuing…" : "Continue"}</button></div>
  </aside>;
}

function AttemptCheckpointStatus({ state }: { state: BlockProgress | undefined }) {
  const checkpoint = state?.checkpoint;
  if (!checkpoint || checkpoint.status === "accepted") return null;
  if (checkpoint.status === "feedback") return <aside className="advice" aria-live="polite"><b>Tutor feedback:</b> {checkpoint.feedback ?? "Keep going and try again."}</aside>;
  return <aside className="observer-status" aria-live="polite">{checkpoint.status === "reviewing" ? "Reviewing your latest attempt…" : "Keep working — the tutor will review your evidence when you pause."}</aside>;
}

function NarrativeBlock({ lessonId, block, state, refresh }: { lessonId: string; block: Block; state: BlockProgress | undefined; refresh(state: State): void }) {
  return <section id={blockElementId(lessonId, block.id)} className={`work-block narrative ${state?.active ? "is-active" : ""}`}>
    <p className="section-label">The idea</p>
    <h2>{block.title}</h2>
    <Markdown>{block.markdown}</Markdown>
    <ContinueControls block={block} state={state} refresh={refresh} />
  </section>;
}

function TerminalBlock({ lessonId, block, state, refresh, showAuthoredContent = true, onTerminalInsertionChange }: { lessonId: string; block: Block; state: BlockProgress | undefined; refresh(state: State): void; showAuthoredContent?: boolean; onTerminalInsertionChange?(insertCommand: (() => void) | undefined): void }) {
  const [observerFeedback, setObserverFeedback] = useState<string>();
  const [observerStatus, setObserverStatus] = useState<string>();
  const command = shellCommandFrom(block.markdown);
  const accepted = state?.checkpoint?.status === "accepted";
  const checkpoint = state?.checkpoint;
  const persistedFeedback = !accepted && checkpoint
    ? checkpoint.status === "feedback"
      ? `Tutor feedback: ${checkpoint.feedback ?? "Keep going and try again."}`
      : checkpoint.status === "reviewing"
        ? "Reviewing your latest attempt…"
        : "Keep working — the tutor will review your evidence when you pause."
    : undefined;
  const liveFeedback = observerFeedback ?? observerStatus ?? persistedFeedback;
  useEffect(() => { setObserverFeedback(undefined); setObserverStatus(undefined); }, [block.id, state?.completed, state?.checkpoint?.status]);
  return <section id={blockElementId(lessonId, block.id)} className={`work-block terminal ${state?.active ? "is-active" : ""}`}>
    {showAuthoredContent && <><p className="section-label">Practice · embedded terminal</p><h2>{block.title}</h2><Markdown>{block.markdown}</Markdown></>}
    {accepted && state ? <AcceptedCheckpoint block={block} state={state} refresh={refresh} /> : state?.verified ? <div className="frozen-terminal" aria-label="Frozen terminal session" dangerouslySetInnerHTML={{ __html: state.terminalHtml || "<pre class=\"frozen-terminal-output\">Terminal session frozen.</pre>" }} /> : !state?.completed && <EmbeddedTerminal block={block} command={command} active={Boolean(state?.active)} completed={Boolean(state?.completed)} verified={false} refresh={refresh} onAdvice={setObserverFeedback} onError={setObserverFeedback} onStatus={setObserverStatus} onTerminalInsertionChange={onTerminalInsertionChange} />}
    {!accepted && liveFeedback && <aside className="live-block-feedback" aria-live="polite">{liveFeedback}</aside>}
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

function EditorPracticeBlockView({ lessonId, block, state, refresh, showAuthoredContent = true }: { lessonId: string; block: EditorPracticeBlock; state: BlockProgress | undefined; refresh(state: State): void; showAuthoredContent?: boolean }) {
  const editorElement = useRef<HTMLDivElement | null>(null);
  const editor = useRef<EditorView | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const activeRef = useRef(false);
  const baseRevision = useRef(state?.revision ?? 0);
  const [localError, setLocalError] = useState<string>();
  const accepted = state?.checkpoint?.status === "accepted";
  const completed = Boolean(state?.completed || state?.editorStatus === "unlocked");
  const canEdit = Boolean(state?.active && state.ready && !completed && !accepted);
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
    {canEdit && (state?.checkpoint?.feedback || state?.feedback) && <aside className="advice editor-feedback" aria-live="polite"><b>Inline feedback:</b> {state.checkpoint?.feedback ?? state.feedback}</aside>}
    {canEdit && <div ref={editorElement} className="editor-surface" aria-label={`Editor for ${block.path}`} />}
    {accepted && state ? <AcceptedCheckpoint block={block} state={state} refresh={refresh} /> : completed ? <aside className="success-checkpoint editor-unlocked" aria-live="polite">
      <span className="success-check" aria-hidden="true">✓</span><div><p className="section-label">Unlocked</p><h3>Accepted revision unlocked the next step.</h3><p>{state?.feedback || "The latest accepted editor draft was written to the target file."}</p></div>
    </aside> : !canEdit && <p className="next-ready">This editor practice will unlock when you reach this block.</p>}
  </section>;
}

function ReflectionBlock({ lessonId, block, state, turns, refresh }: { lessonId: string; block: Block; state: BlockProgress | undefined; turns: ReflectionTurn[]; refresh(state: State): void }) {
  const accepted = state?.checkpoint?.status === "accepted";
  const visibleTurns = accepted ? state?.checkpoint?.evidence?.conversation ?? turns : turns;
  return <section id={blockElementId(lessonId, block.id)} className={`work-block reflection ${state?.active ? "is-active" : ""}`}><p className="section-label">Reflection · discuss it</p><h2>{block.title}</h2><div className="question"><Markdown>{block.markdown}</Markdown></div>
    {visibleTurns.length > 0 && !accepted && <div className="reflection-thread" aria-live="polite">{visibleTurns.map((turn, index) => <div key={index} className={`reflection-turn ${turn.role}`}><b>{turn.role === "learner" ? "You" : "Tutor"}</b><p>{turn.text}</p></div>)}</div>}
    {accepted && state ? <AcceptedCheckpoint block={block} state={state} refresh={refresh} /> : state?.completed ? <p className="next-ready">Reflection complete. The next step has appeared below.</p> : <AttemptCheckpointStatus state={state} />}
  </section>;
}

function TransitionBlock({ lessonId, block, state, refresh }: { lessonId: string; block: Block; state: BlockProgress | undefined; refresh(state: State): void }) {
  return <section id={blockElementId(lessonId, block.id)} className={`work-block lesson-end ${state?.active ? "is-active" : ""}`}>
    <p className="section-label">Lesson transition</p>
    <h2>{block.title}</h2>
    <Markdown>{block.markdown}</Markdown>
    <ContinueControls block={block} state={state} refresh={refresh} />
  </section>;
}

export function BlockView({ lessonId, block, progress, refresh, showAuthoredContent = true, onTerminalInsertionChange }: { lessonId?: string; block: Block; progress: Progress; refresh(state: State): void; showAuthoredContent?: boolean; onTerminalInsertionChange?(insertCommand: (() => void) | undefined): void }) {
  const resolvedLessonId = lessonId ?? progress.activeLessonId;
  const state = stateForBlock(progress, resolvedLessonId, block);
  if (block.type === "narrative") return <NarrativeBlock lessonId={resolvedLessonId} block={block} state={state} refresh={refresh} />;
  if (block.type === "terminal-practice") return <TerminalBlock lessonId={resolvedLessonId} block={block} state={state} refresh={refresh} showAuthoredContent={showAuthoredContent} onTerminalInsertionChange={onTerminalInsertionChange} />;
  if (block.type === "editor-practice") return <EditorPracticeBlockView lessonId={resolvedLessonId} block={block} state={state} refresh={refresh} showAuthoredContent={showAuthoredContent} />;
  if (block.type === "reflection") return <ReflectionBlock lessonId={resolvedLessonId} block={block} state={state} turns={activeLessonValue(progress, resolvedLessonId, progress.reflectionConversations[block.id], [])} refresh={refresh} />;
  return <TransitionBlock lessonId={resolvedLessonId} block={block} state={state} refresh={refresh} />;
}

function WorkbookIntroduction({ state, refresh }: { state: State; refresh(state: State): void }) {
  const [sentinel, setSentinel] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    if (state.introductionComplete || !sentinel || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) completeIntroduction().then(refresh);
    }, { threshold: 1 });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [state.introductionComplete, sentinel, refresh]);
  return <section className="workbook-intro" aria-label="Workbook introduction">
    <header><h1>{state.workbook.title}</h1></header>
    <Markdown>{state.introduction}</Markdown>
    {state.introductionComplete ? <p className="next-ready">The first lesson is ready below.</p> : <button className="button primary introduction-continue" onClick={() => completeIntroduction().then(refresh)}>Ready to continue</button>}
    <div ref={setSentinel} className="introduction-end" aria-hidden="true" />
  </section>;
}

function IntroductionContinue({ refresh }: { refresh(state: State): void }) {
  const [pending, setPending] = useState(false);
  const continueIntroduction = () => {
    if (pending) return;
    setPending(true);
    completeIntroduction().then(refresh).catch((error) => {
      console.error(error);
      setPending(false);
    });
  };
  return <div className="continuation-controls introduction-continuation">
    <button className="button primary introduction-continue" disabled={pending} onClick={continueIntroduction}>{pending ? "Continuing…" : "Ready to continue"}</button>
  </div>;
}

export function LessonRail({ title, chapters, progress, viewedLessonId, setViewedLesson }: { title: string; chapters: Chapter[]; progress: Progress; viewedLessonId: string; setViewedLesson(id: string): void }) {
  const renderChapter = (chapter: Chapter) => {
    const complete = progress.completedLessons.includes(chapter.id);
    const current = chapter.id === progress.activeLessonId;
    if (!chapter.lesson) return <span key={chapter.id} className="lesson-row ahead unavailable" aria-disabled="true"><span>Lesson {chapter.lessonNumber}: {chapter.title}</span></span>;
    return <details key={chapter.id} className="lesson-nav" open={viewedLessonId === chapter.id}><summary><a href={`#${lessonElementId(chapter.id)}`} className={`lesson-row ${complete ? "done" : current ? "current" : "ahead"}`} onClick={() => setViewedLesson(chapter.id)}>Lesson {chapter.lessonNumber}: {chapter.title}</a></summary>{viewedLessonId === chapter.id && <nav className="lesson-outline" aria-label={`${chapter.title} outline`}>{chapter.lesson.blocks.map((block) => <a href={`#${blockElementId(chapter.id, block.id)}`} key={block.id} aria-current={block.id === progress.activeBlockId ? "true" : undefined}>{block.title}</a>)}</nav>}</details>;
  };
  const parts = [...new Set(chapters.map((chapter) => chapter.part).filter((part): part is string => Boolean(part)))];
  return <aside className="rail" aria-label="Lesson navigation">
    <div className="brand"><span className="brand-mark" aria-hidden="true">↗</span> {title}</div>
    <nav className="curriculum" aria-label="Workbook navigation">{parts.length === 0
      ? chapters.map(renderChapter)
      : parts.map((part) => <div key={part}><p className="part-name">{part}</p>{chapters.filter((chapter) => chapter.part === part).map(renderChapter)}</div>)}</nav>
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

export function App() {
  const [state, setState] = useState<State>();
  const [viewed, setViewed] = useState<string>();
  const [terminalInsertion, setTerminalInsertion] = useState<(() => void) | undefined>();
  const registerTerminalInsertion = useCallback((insertCommand: (() => void) | undefined) => {
    setTerminalInsertion(() => insertCommand);
  }, []);
  useEffect(() => { fetch("api/workbook/state").then((response) => response.json()).then((next: State) => setState(next)); }, []);
  useEffect(() => { if (state) document.title = state.workbook.title; }, [state?.workbook.title]);
  useEffect(() => {
    if (!state?.introductionComplete) return;
    scrollActiveLessonIntoView(document, state.progress.activeLessonId);
  }, [state?.introductionComplete, state?.progress.activeLessonId]);
  useEffect(() => { setTerminalInsertion(undefined); }, [state?.progress.activeLessonId, state?.progress.activeBlockId]);
  useEffect(() => {
    if (!state) return;
    const headings = [...document.querySelectorAll<HTMLElement>(".chapter")];
    const selectViewed = () => {
      const passed = headings.filter((heading) => heading.getBoundingClientRect().top <= 120);
      setViewed((passed.at(-1) ?? headings[0])?.dataset.lessonId ?? state.progress.activeLessonId);
    };
    selectViewed(); addEventListener("scroll", selectViewed, { passive: true });
    return () => removeEventListener("scroll", selectViewed);
  }, [state]);
  const emerged = useMemo(() => state?.chapters.filter((chapter): chapter is Chapter & { lesson: Lesson } => Boolean(chapter.lesson)) ?? [], [state]);
  if (!state) return <p className="loading">Loading workbook…</p>;
  const viewedLesson = viewed ?? state.progress.activeLessonId;
  const activeChapter = emerged.find((chapter) => chapter.id === state.progress.activeLessonId);
  const activeBlock = activeChapter?.lesson.blocks.find((block) => block.id === state.progress.activeBlockId);
  const activeBlockProgress = state.progress.blocks.find((block) => block.id === state.progress.activeBlockId);
  const hasTimeline = state.timeline !== undefined;
  const sendTutorText = (text: string) => {
    if (state.introductionComplete && activeBlock?.type === "reflection") {
      const turns = state.progress.reflectionConversations[activeBlock.id] ?? [];
      return post(activeBlock.id, { action: turns.length > 0 ? "reflection-follow-up" : "reflection-submit", response: text }).then((next) => setState(next));
    }
    return postTutorMessage(state.introductionComplete ? state.progress.activeBlockId : INTRODUCTION_BLOCK_ID, text).then((next) => setState(next));
  };
  const activeTargetRecords = state.timeline?.filter((record) => record.type === "message" && record.lessonId === state.progress.activeLessonId && record.blockId === state.progress.activeBlockId) ?? [];
  const latestActiveTargetRecordId = activeTargetRecords.at(-1)?.id;
  const activeBlockAccepted = activeBlockProgress?.checkpoint?.status === "accepted";
  const reflectionComposerDisabled = Boolean(state.introductionComplete && activeBlock?.type === "reflection" && ["reviewing", "accepted"].includes(activeBlockProgress?.checkpoint?.status ?? ""));
  const renderTimelineContinuation = (record: PublicTimelineRecord) => {
    if (record.type !== "message") return null;
    if (record.source === "authored" && !state.introductionComplete && record.lessonId === INTRODUCTION_LESSON_ID && record.blockId === INTRODUCTION_BLOCK_ID) return <IntroductionContinue refresh={setState} />;
    if (!activeBlock || !activeBlockProgress || record.lessonId !== state.progress.activeLessonId || record.blockId !== activeBlock.id) return null;
    if (record.source === "authored" && ["narrative", "lesson-transition"].includes(activeBlock.type)) return <ContinueControls block={activeBlock} state={activeBlockProgress} refresh={setState} />;
    if (activeBlockAccepted && record.id === latestActiveTargetRecordId) return <ContinueControls block={activeBlock} state={activeBlockProgress} refresh={setState} />;
    return null;
  };
  return <div className="shell">
    <AcceptanceConfetti acceptedKey={activeAcceptedKey(state.progress)} />
    <LessonRail title={state.workbook.title} chapters={state.chapters} progress={state.progress} viewedLessonId={viewedLesson} setViewedLesson={setViewed} />
    <main><article className="page">
      {hasTimeline ? <>
        {activeChapter && activeBlock && <ActivityBand lessonId={activeChapter.id} activeBlock={activeBlock} progress={state.progress} refresh={setState} onTerminalInsertionChange={registerTerminalInsertion} />}
        <TimelineThread records={state.timeline} activeLessonId={state.introductionComplete ? state.progress.activeLessonId : INTRODUCTION_LESSON_ID} activeBlockId={state.introductionComplete ? state.progress.activeBlockId : INTRODUCTION_BLOCK_ID} onSend={sendTutorText} onRetry={(failureId) => retryTutorOperation(failureId).then((next) => setState(next))} onDoItForMe={terminalInsertion} inputDisabled={reflectionComposerDisabled} renderContinuation={renderTimelineContinuation} />
      </> : <>
        <WorkbookIntroduction state={state} refresh={setState} />
        {emerged.map((chapter, index) => <React.Fragment key={chapter.id}>{(index === 0 || chapter.part !== emerged[index - 1]!.part) && <PartChapter chapter={chapter} />}<LessonView chapter={chapter} progress={state.progress} refresh={setState} /></React.Fragment>)}
      </>}
    </article></main>
  </div>;
}
