import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { defaultKeymap } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { Markdown } from "../../web/src/markdown";

export type WorkbookBlockType = "narrative" | "terminal-practice" | "editor-practice" | "reflection" | "lesson-transition";
type BlockBase = { id: string; title: string; markdown: string; label?: string };
export type NarrativeBlock = BlockBase & { type: "narrative" };
export type TerminalPracticeBlock = BlockBase & { type: "terminal-practice" };
export type EditorPracticeBlock = BlockBase & { type: "editor-practice"; path: string; tutor?: never };
export type ReflectionBlock = BlockBase & { type: "reflection" };
export type LessonTransitionBlock = BlockBase & { type: "lesson-transition" };
export type Block = NarrativeBlock | TerminalPracticeBlock | EditorPracticeBlock | ReflectionBlock | LessonTransitionBlock;
export type Lesson = { id: string; title: string; dek: string; durationMinutes: number; outcomes: string[]; blocks: Block[] };
export type Chapter = { id: string; title: string; part: string; partMarkdown: string; partNumber: number; lessonNumber: number; lesson?: Lesson };
export type EditorStatus = "editing" | "reviewing" | "feedback" | "unlocked";
export type BlockProgress = { id: string; type?: string; ready: boolean; active: boolean; completed: boolean; verified: boolean; feedback?: string; terminalHtml?: string; emerged: boolean; revision?: number; draftText?: string; editorStatus?: EditorStatus };
export type ReflectionTurn = { role: "learner" | "tutor"; text: string };
export type Progress = { activeLessonId: string; activeBlockId: string; completedLessons: string[]; blocks: BlockProgress[]; unexpected: Record<string, string[]>; reflections: Record<string, string>; reflectionConversations: Record<string, ReflectionTurn[]> };
type Identity = { title: string };
export type State = { workbook: Identity; introduction: string; introductionComplete: boolean; chapters: Chapter[]; progress: Progress; adapter: { note?: string; modelBackedHelp?: boolean } };

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

async function readWorkbookState(): Promise<State> {
  const response = await fetch("/api/workbook/state");
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

function progressFor(progress: Progress, id: string) { return progress.blocks.find((block) => block.id === id); }
function domSafe(value: string) { return value.replace(/[^A-Za-z0-9_-]+/g, "-"); }
function lessonElementId(lessonId: string) { return `lesson-${domSafe(lessonId)}`; }
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

function EmbeddedTerminal({ block, command, active, completed, verified, refresh, onAdvice, onError, onStatus }: { block: Block; command?: string; active: boolean; completed: boolean; verified: boolean; refresh(state: State): void; onAdvice(message: string): void; onError(message: string): void; onStatus(message: string): void }) {
  const terminalElement = useRef<HTMLDivElement | null>(null);
  const terminal = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const socket = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);

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
    ws.addEventListener("open", () => { setConnected(true); onStatus("Terminal connected in an isolated workbook container."); sendResize(); });
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
    ws.addEventListener("error", () => onError("Embedded terminal connection failed. Refresh the page and try again."));
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

  const insertCommand = () => {
    if (!command) return;
    const data = commandForInsertion(command);
    if (!verified && socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify({ type: "input", data }));
  };

  return <div className="embedded-terminal-panel">
    <div className="embedded-terminal-head"><div><b>Embedded terminal</b><p>Observed by the tutor in an isolated container with write access only to learner work folders.</p></div><span className={connected ? "status connected" : "status"}>{connected ? "connected" : "offline"}</span></div>
    <div ref={terminalElement} className="embedded-terminal" aria-label="Embedded terminal" />
    {verified ? <div className="action-row"><span className="terminal-note">Your terminal transcript is preserved here as evidence of what you did.</span></div> : command && <div className="action-row"><button className="button primary" disabled={!connected} onClick={insertCommand}>Insert command — do not press Enter</button><span className="terminal-note">The button types a single-line equivalent only. You decide when to press Enter.</span></div>}
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

function ContinueControls({ block, state, refresh }: { block: Block; state: BlockProgress | undefined; refresh(state: State): void }) {
  const [sentinel, setSentinel] = useState<HTMLDivElement | null>(null);
  const { active, pending, continueOnce } = useContinueOnce(block, state, refresh);

  useEffect(() => {
    if (!active || !sentinel || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => { if (entry?.isIntersecting) continueOnce(); }, { threshold: 1 });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [active, sentinel, continueOnce]);

  if (state?.completed) return <p className="next-ready">The next step has appeared below.</p>;
  if (!active) return null;
  return <div className="continuation-controls">
    <button className="button primary" disabled={pending} onClick={continueOnce}>{pending ? "Continuing…" : "Continue"}</button>
    <div ref={setSentinel} className="block-end-sentinel" data-completion-action="continue" aria-hidden="true" />
  </div>;
}

function NarrativeBlock({ lessonId, block, state, refresh }: { lessonId: string; block: Block; state: BlockProgress | undefined; refresh(state: State): void }) {
  return <section id={blockElementId(lessonId, block.id)} className={`work-block narrative ${state?.active ? "is-active" : ""}`}>
    <p className="section-label">The idea</p>
    <h2>{block.title}</h2>
    <Markdown>{block.markdown}</Markdown>
    <ContinueControls block={block} state={state} refresh={refresh} />
  </section>;
}

function TerminalBlock({ lessonId, block, state, unexpected, refresh }: { lessonId: string; block: Block; state: BlockProgress | undefined; unexpected: string[]; refresh(state: State): void }) {
  const [evidence, setEvidence] = useState("");
  const [other, setOther] = useState("");
  const [observerAdvice, setObserverAdvice] = useState<string>();
  const [observerError, setObserverError] = useState<string>();
  const [observerStatus, setObserverStatus] = useState<string>();
  const command = shellCommandFrom(block.markdown);
  useEffect(() => { setObserverAdvice(undefined); setObserverError(undefined); setObserverStatus(undefined); }, [block.id, state?.completed]);
  return <section id={blockElementId(lessonId, block.id)} className={`work-block terminal ${state?.active ? "is-active" : ""}`}>
    <p className="section-label">Practice · embedded terminal</p>
    <h2>{block.title}</h2>
    <Markdown>{block.markdown}</Markdown>
    <div className="mode practice">
      <div className="mode-head"><span className="mode-icon" aria-hidden="true">›_</span><div><span className="tag">Terminal practice</span><h3>Run this in the embedded terminal</h3><p>The tutor watches this terminal for the expected result and keeps the transcript as evidence.</p></div></div>
      <div className="mode-body">
        {state?.verified ? <div className="frozen-terminal" aria-label="Frozen terminal session" dangerouslySetInnerHTML={{ __html: state.terminalHtml || "<pre class=\"frozen-terminal-output\">Terminal session frozen.</pre>" }} /> : !state?.completed && <EmbeddedTerminal block={block} command={command} active={Boolean(state?.active)} completed={Boolean(state?.completed)} verified={false} refresh={refresh} onAdvice={setObserverAdvice} onError={setObserverError} onStatus={setObserverStatus} />}
        {state?.verified && !state?.completed ? <aside className="success-checkpoint" aria-live="polite">
          <span className="success-check" aria-hidden="true">✓</span><div><p className="section-label">Verified</p><h3>Nice work — you got it.</h3><p>{state.feedback || "You produced the expected result."}</p><button className="button primary" onClick={() => post(block.id, { action: "complete" }).then(refresh)}>Continue</button></div>
        </aside> : <>
          {observerStatus && !observerAdvice && !observerError && <aside className="observer-status" aria-live="polite">{observerStatus}</aside>}
          {observerAdvice && <aside className="advice" aria-live="polite"><b>Try this:</b> {observerAdvice}</aside>}
          {observerError && <aside className="advice warning" aria-live="polite">{observerError}</aside>}
        </>}
        {!state?.completed && !state?.verified && <div className="local-help"><label>I saw something different<textarea value={evidence} onChange={(event) => setEvidence(event.target.value)} /></label><button className="button secondary" onClick={() => post(block.id, { action: "unexpected", evidence }).then(refresh)}>Record it and keep trying</button><label>Something else<textarea value={other} onChange={(event) => setOther(event.target.value)} /></label><button className="button secondary" onClick={() => { setOther(""); return post(block.id, { action: "help", request: other }).then(refresh); }}>Ask locally</button></div>}
        {unexpected.map((item, index) => <p className="evidence" key={index}>Recorded different output: {item}</p>)}
      </div>
    </div>
  </section>;
}

const EDITOR_REVIEW_POLL_INTERVAL_MS = 250;
const EDITOR_REVIEW_MAX_POLLS = 480;

function editorStatusText(state: BlockProgress | undefined, completed: boolean): string {
  if (completed || state?.editorStatus === "unlocked") return "Unlocked — the accepted revision has been written to the target file.";
  if (state?.editorStatus === "reviewing") return "Reviewing your latest revision…";
  if (state?.editorStatus === "feedback") return "Feedback received — keep editing and pause to request another review.";
  return "Editing — changes are reviewed automatically after you pause.";
}

function EditorPracticeBlockView({ lessonId, block, state, refresh }: { lessonId: string; block: EditorPracticeBlock; state: BlockProgress | undefined; refresh(state: State): void }) {
  const editorElement = useRef<HTMLDivElement | null>(null);
  const editor = useRef<EditorView | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const activeRef = useRef(false);
  const baseRevision = useRef(state?.revision ?? 0);
  const [localError, setLocalError] = useState<string>();
  const completed = Boolean(state?.completed || state?.editorStatus === "unlocked");
  const canEdit = Boolean(state?.active && state.ready && !completed);
  const initialText = state?.draftText ?? "";

  useEffect(() => { baseRevision.current = state?.revision ?? baseRevision.current; }, [block.id, state?.revision]);
  useEffect(() => { activeRef.current = canEdit; }, [canEdit]);

  useEffect(() => {
    if (!canEdit || state?.editorStatus !== "reviewing" || !Number.isInteger(state.revision)) return;
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
          const nextStatus = nextProgress?.editorStatus;
          const completedReview = Boolean(nextProgress?.completed || nextStatus === "feedback" || nextStatus === "unlocked" || !nextProgress?.active);
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
  }, [block.id, canEdit, refresh, state?.editorStatus, state?.revision]);

  useEffect(() => {
    if (!canEdit || !editorElement.current) return;
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
  }, [block.id, canEdit, initialText, refresh]);

  const status = editorStatusText(state, completed);
  return <section id={blockElementId(lessonId, block.id)} className={`work-block editor-practice ${state?.active ? "is-active" : ""}`}>
    <p className="section-label">Practice · embedded editor</p>
    <h2>{block.title}</h2>
    <Markdown>{block.markdown}</Markdown>
    <div className="editor-target"><span>Target file</span><code>{block.path}</code></div>
    {canEdit && <div className="editor-status" role="status" aria-live="polite">{localError ?? status}</div>}
    {canEdit && state?.feedback && <aside className="advice editor-feedback" aria-live="polite"><b>Inline feedback:</b> {state.feedback}</aside>}
    {canEdit && <div ref={editorElement} className="editor-surface" aria-label={`Editor for ${block.path}`} />}
    {completed ? <aside className="success-checkpoint editor-unlocked" aria-live="polite">
      <span className="success-check" aria-hidden="true">✓</span><div><p className="section-label">Unlocked</p><h3>Accepted revision unlocked the next step.</h3><p>{state?.feedback || "The latest accepted editor draft was written to the target file."}</p></div>
    </aside> : !canEdit && <p className="next-ready">This editor practice will unlock when you reach this block.</p>}
  </section>;
}

function ReflectionBlock({ lessonId, block, state, turns, refresh }: { lessonId: string; block: Block; state: BlockProgress | undefined; turns: ReflectionTurn[]; refresh(state: State): void }) {
  const hasTutorReply = turns.some((turn) => turn.role === "tutor");
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const submit = (action: "reflection-submit" | "reflection-follow-up") => {
    setPending(true);
    post(block.id, { action, response: draft }).then((next) => { setDraft(""); refresh(next); }).finally(() => setPending(false));
  };
  return <section id={blockElementId(lessonId, block.id)} className={`work-block reflection ${state?.active ? "is-active" : ""}`}><p className="section-label">Reflection · discuss it</p><h2>{block.title}</h2><div className="question"><Markdown>{block.markdown}</Markdown></div>
    {turns.length > 0 && <div className="reflection-thread" aria-live="polite">{turns.map((turn, index) => <div key={index} className={`reflection-turn ${turn.role}`}><b>{turn.role === "learner" ? "You" : "Tutor"}</b><p>{turn.text}</p></div>)}</div>}
    {state?.completed ? <p className="next-ready">Reflection complete. The next step has appeared below.</p> : <>
      <label className="reflection-input">{hasTutorReply ? "Ask a clarifying question or add to your answer" : "Share your answer"}<textarea aria-label="Your reflection" value={draft} onChange={(event) => setDraft(event.target.value)} disabled={pending} /></label>
      <div className="action-row"><button className="button primary" disabled={pending || !draft.trim()} onClick={() => submit(hasTutorReply ? "reflection-follow-up" : "reflection-submit")}>{pending ? "Thinking…" : hasTutorReply ? "Send question" : "Discuss reflection"}</button>{hasTutorReply && <button className="button secondary" disabled={pending} onClick={() => { setPending(true); post(block.id, { action: "reflection-complete" }).then(refresh).finally(() => setPending(false)); }}>Continue</button>}</div>
    </>}
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

export function BlockView({ lessonId, block, progress, refresh }: { lessonId?: string; block: Block; progress: Progress; refresh(state: State): void }) {
  const resolvedLessonId = lessonId ?? progress.activeLessonId;
  const state = stateForBlock(progress, resolvedLessonId, block);
  if (block.type === "narrative") return <NarrativeBlock lessonId={resolvedLessonId} block={block} state={state} refresh={refresh} />;
  if (block.type === "terminal-practice") return <TerminalBlock lessonId={resolvedLessonId} block={block} state={state} unexpected={activeLessonValue(progress, resolvedLessonId, progress.unexpected[block.id], [])} refresh={refresh} />;
  if (block.type === "editor-practice") return <EditorPracticeBlockView lessonId={resolvedLessonId} block={block} state={state} refresh={refresh} />;
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

export function LessonRail({ title, chapters, progress, viewedLessonId, setViewedLesson }: { title: string; chapters: Chapter[]; progress: Progress; viewedLessonId: string; setViewedLesson(id: string): void }) {
  const parts = [...new Set(chapters.map((chapter) => chapter.part))];
  return <aside className="rail" aria-label="Lesson navigation">
    <div className="brand"><span className="brand-mark" aria-hidden="true">↗</span> {title}</div>
    <nav className="curriculum" aria-label="Workbook navigation">{parts.map((part) => <div key={part}><p className="part-name">{part}</p>{chapters.filter((chapter) => chapter.part === part).map((chapter) => {
      const complete = progress.completedLessons.includes(chapter.id);
      const current = chapter.id === progress.activeLessonId;
      if (!chapter.lesson) return <span key={chapter.id} className="lesson-row ahead unavailable" aria-disabled="true"><span>{chapter.title}</span></span>;
      return <details key={chapter.id} className="lesson-nav" open={viewedLessonId === chapter.id}><summary><a href={`#${lessonElementId(chapter.id)}`} className={`lesson-row ${complete ? "done" : current ? "current" : "ahead"}`} onClick={() => setViewedLesson(chapter.id)}>{chapter.title}</a></summary>{viewedLessonId === chapter.id && <nav className="lesson-outline" aria-label={`${chapter.title} outline`}>{chapter.lesson.blocks.map((block) => <a href={`#${blockElementId(chapter.id, block.id)}`} key={block.id} aria-current={block.id === progress.activeBlockId ? "true" : undefined}>{block.title}</a>)}</nav>}</details>;
    })}</div>)}</nav>
  </aside>;
}

export function LessonView({ chapter, progress, refresh }: { chapter: Chapter & { lesson: Lesson }; progress: Progress; refresh(state: State): void }) {
  return <article data-lesson-id={chapter.id} key={chapter.id} className="chapter">
    <header id={lessonElementId(chapter.id)}><h1>{chapter.lesson.title}</h1><p className="dek">{chapter.lesson.dek}</p><div className="lesson-meta"><span className="chip duration">{chapter.lesson.durationMinutes} min</span></div></header>
    <section className="opening"><p className="section-label">What you will learn</p><h2>What you will learn</h2><ul className="outcomes">{chapter.lesson.outcomes.map((outcome) => <li key={outcome}>{outcome}</li>)}</ul></section>
    {chapter.lesson.blocks.map((block) => <BlockView key={block.id} lessonId={chapter.id} block={block} progress={progress} refresh={refresh} />)}
  </article>;
}

function PartChapter({ chapter }: { chapter: Chapter }) {
  return <section id={`part-${chapter.id}`} className="part-chapter" aria-label={chapter.part}><div><p className="part-title">{chapter.part}</p><div className="part-copy"><Markdown>{chapter.partMarkdown}</Markdown></div></div></section>;
}

export function App() {
  const [state, setState] = useState<State>();
  const [viewed, setViewed] = useState<string>();
  useEffect(() => { fetch("api/workbook/state").then((response) => response.json()).then((next: State) => setState(next)); }, []);
  useEffect(() => { if (state) document.title = state.workbook.title; }, [state?.workbook.title]);
  useEffect(() => {
    if (!state?.introductionComplete) return;
    scrollActiveLessonIntoView(document, state.progress.activeLessonId);
  }, [state?.introductionComplete, state?.progress.activeLessonId]);
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
  return <div className="shell">
    <LessonRail title={state.workbook.title} chapters={state.chapters} progress={state.progress} viewedLessonId={viewedLesson} setViewedLesson={setViewed} />
    <main><article className="page">
      <WorkbookIntroduction state={state} refresh={setState} />
      {emerged.map((chapter) => <React.Fragment key={chapter.id}><PartChapter chapter={chapter} /><LessonView chapter={chapter} progress={state.progress} refresh={setState} /></React.Fragment>)}
    </article></main>
  </div>;
}
