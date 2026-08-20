import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { Markdown } from "../../web/src/markdown";

export type WorkbookBlockType = "narrative" | "terminal-practice" | "reflection" | "lesson-transition";
export type Block = { id: string; type: WorkbookBlockType; title: string; markdown: string; label?: string; tutor?: string };
export type Lesson = { id: string; title: string; dek: string; durationMinutes: number; outcomes: string[]; blocks: Block[] };
export type Chapter = { id: string; title: string; part: string; partMarkdown: string; partNumber: number; lessonNumber: number; lesson?: Lesson };
export type BlockProgress = { id: string; type?: string; ready: boolean; active: boolean; completed: boolean; verified: boolean; feedback?: string; terminalHtml?: string; emerged: boolean };
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

function progressFor(progress: Progress, id: string) { return progress.blocks.find((block) => block.id === id); }
function commandForInsertion(command = "") { return command.replace(/\\\r?\n\s*/g, " "); }

const SHELL_FENCE = /```(?:sh|bash|shell|zsh|console)\s*\n([\s\S]*?)```/i;
function shellCommandFrom(markdown: string): string | undefined {
  return SHELL_FENCE.exec(markdown)?.[1]?.trim();
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
    ws.addEventListener("open", () => { setConnected(true); onStatus("Terminal connected. This is a real local shell, not a sandbox."); sendResize(); });
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
    <div className="embedded-terminal-head"><div><b>Embedded terminal</b><p>Observed by the tutor. It runs as you in this repository; it is not a sandbox.</p></div><span className={connected ? "status connected" : "status"}>{connected ? "connected" : "offline"}</span></div>
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

function NarrativeBlock({ block, state, refresh }: { block: Block; state: BlockProgress | undefined; refresh(state: State): void }) {
  return <section id={block.id} className={`work-block narrative ${state?.active ? "is-active" : ""}`}>
    <p className="section-label">The idea</p>
    <h2>{block.title}</h2>
    <Markdown>{block.markdown}</Markdown>
    <ContinueControls block={block} state={state} refresh={refresh} />
  </section>;
}

function TerminalBlock({ block, progress, refresh }: { block: Block; progress: Progress; refresh(state: State): void }) {
  const state = progressFor(progress, block.id);
  const [evidence, setEvidence] = useState("");
  const [other, setOther] = useState("");
  const [observerAdvice, setObserverAdvice] = useState<string>();
  const [observerError, setObserverError] = useState<string>();
  const [observerStatus, setObserverStatus] = useState<string>();
  const command = shellCommandFrom(block.markdown);
  useEffect(() => { setObserverAdvice(undefined); setObserverError(undefined); setObserverStatus(undefined); }, [block.id, state?.completed]);
  return <section id={block.id} className={`work-block terminal ${state?.active ? "is-active" : ""}`}>
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
        {progress.unexpected[block.id]?.map((item, index) => <p className="evidence" key={index}>Recorded different output: {item}</p>)}
      </div>
    </div>
  </section>;
}

function ReflectionBlock({ block, state, progress, refresh }: { block: Block; state: BlockProgress | undefined; progress: Progress; refresh(state: State): void }) {
  const turns = progress.reflectionConversations[block.id] ?? [];
  const hasTutorReply = turns.some((turn) => turn.role === "tutor");
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const submit = (action: "reflection-submit" | "reflection-follow-up") => {
    setPending(true);
    post(block.id, { action, response: draft }).then((next) => { setDraft(""); refresh(next); }).finally(() => setPending(false));
  };
  return <section id={block.id} className={`work-block reflection ${state?.active ? "is-active" : ""}`}><p className="section-label">Reflection · discuss it</p><h2>{block.title}</h2><div className="question"><Markdown>{block.markdown}</Markdown></div>
    {turns.length > 0 && <div className="reflection-thread" aria-live="polite">{turns.map((turn, index) => <div key={index} className={`reflection-turn ${turn.role}`}><b>{turn.role === "learner" ? "You" : "Tutor"}</b><p>{turn.text}</p></div>)}</div>}
    {state?.completed ? <p className="next-ready">Reflection complete. The next step has appeared below.</p> : <>
      <label className="reflection-input">{hasTutorReply ? "Ask a clarifying question or add to your answer" : "Share your answer"}<textarea aria-label="Your reflection" value={draft} onChange={(event) => setDraft(event.target.value)} disabled={pending} /></label>
      <div className="action-row"><button className="button primary" disabled={pending || !draft.trim()} onClick={() => submit(hasTutorReply ? "reflection-follow-up" : "reflection-submit")}>{pending ? "Thinking…" : hasTutorReply ? "Send question" : "Discuss reflection"}</button>{hasTutorReply && <button className="button secondary" disabled={pending} onClick={() => { setPending(true); post(block.id, { action: "reflection-complete" }).then(refresh).finally(() => setPending(false)); }}>Continue</button>}</div>
    </>}
  </section>;
}

function TransitionBlock({ block, state, refresh }: { block: Block; state: BlockProgress | undefined; refresh(state: State): void }) {
  return <section id={block.id} className={`work-block lesson-end ${state?.active ? "is-active" : ""}`}>
    <p className="section-label">Lesson transition</p>
    <h2>{block.title}</h2>
    <Markdown>{block.markdown}</Markdown>
    <ContinueControls block={block} state={state} refresh={refresh} />
  </section>;
}

export function BlockView({ block, progress, refresh }: { block: Block; progress: Progress; refresh(state: State): void }) {
  const state = progressFor(progress, block.id);
  if (block.type === "narrative") return <NarrativeBlock block={block} state={state} refresh={refresh} />;
  if (block.type === "terminal-practice") return <TerminalBlock block={block} progress={progress} refresh={refresh} />;
  if (block.type === "reflection") return <ReflectionBlock block={block} state={state} progress={progress} refresh={refresh} />;
  return <TransitionBlock block={block} state={state} refresh={refresh} />;
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
      return <details key={chapter.id} className="lesson-nav" open={viewedLessonId === chapter.id}><summary><a href={`#lesson-${chapter.id}`} className={`lesson-row ${complete ? "done" : current ? "current" : "ahead"}`} onClick={() => setViewedLesson(chapter.id)}>{chapter.title}</a></summary>{viewedLessonId === chapter.id && <nav className="lesson-outline" aria-label={`${chapter.title} outline`}>{chapter.lesson.blocks.map((block) => <a href={`#${block.id}`} key={block.id} aria-current={block.id === progress.activeBlockId ? "true" : undefined}>{block.title}</a>)}</nav>}</details>;
    })}</div>)}</nav>
  </aside>;
}

export function LessonView({ chapter, progress, refresh }: { chapter: Chapter & { lesson: Lesson }; progress: Progress; refresh(state: State): void }) {
  return <article data-lesson-id={chapter.id} key={chapter.id} className="chapter">
    <header id={`lesson-${chapter.id}`}><p className="eyebrow">Part {chapter.partNumber}, Lesson {chapter.lessonNumber}</p><h1>{chapter.lesson.title}</h1><p className="dek">{chapter.lesson.dek}</p><div className="lesson-meta"><span className="chip duration">{chapter.lesson.durationMinutes} min</span></div></header>
    <section className="opening"><p className="section-label">What you will learn</p><h2>What you will learn</h2><ul className="outcomes">{chapter.lesson.outcomes.map((outcome) => <li key={outcome}>{outcome}</li>)}</ul></section>
    {chapter.lesson.blocks.map((block) => <BlockView key={block.id} block={block} progress={progress} refresh={refresh} />)}
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
    document.getElementById(`lesson-${state.progress.activeLessonId}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
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
