import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

type Block = { id: string; type: string; title: string; markdown?: string; command?: string; context?: string; expectedObservation?: string; help?: Record<string, string>; prompt?: string; label?: string };
type Hero = { title: string; dek: string; meta: string[] };
type Opening = { sectionLabel: string; heading: string; markdown: string; outcomes: string[] };
type Lesson = { id: string; status: string; hero: Hero; opening: Opening; blocks: Block[] };
type Chapter = { id: string; title: string; part: string; partMarkdown: string; partNumber: number; lessonNumber: number; state: "migrated" | "unavailable"; lesson?: Lesson };
type BlockProgress = { id: string; ready: boolean; active: boolean; completed: boolean; emerged: boolean };
type Progress = { activeLessonId: string; activeBlockId: string; completedLessons: string[]; blocks: BlockProgress[]; unexpected: Record<string, string[]>; reflections: Record<string, string> };
type Identity = { title: string; };
type State = { workbook: Identity; introduction: string; introductionComplete: boolean; chapters: Chapter[]; progress: Progress; adapter: { note: string } };

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

function renderMarkdown(text = "") {
  return text.split(/\n\n+/).map((paragraph, index) => <p key={index}>{paragraph.split(/(\*\*[^*]+\*\*)/).map((part, partIndex) => part.startsWith("**") ? <strong key={partIndex}>{part.slice(2, -2)}</strong> : part)}</p>);
}

function progressFor(progress: Progress, id: string) { return progress.blocks.find((block) => block.id === id); }

function TerminalBlock({ block, progress, refresh }: { block: Block; progress: Progress; refresh(state: State): void }) {
  const state = progressFor(progress, block.id);
  const [evidence, setEvidence] = useState("");
  const [help, setHelp] = useState<string>();
  const [other, setOther] = useState("");
  return <section id={block.id} className={`work-block terminal ${state?.active ? "is-active" : ""}`}>
    <p className="section-label">Practice · your terminal</p>
    <h2>{block.title}</h2>
    <div className="mode practice">
      <div className="mode-head"><span className="mode-icon" aria-hidden="true">›_</span><div><span className="tag">Terminal practice</span><h3>Run this from your terminal</h3><p>{block.context}</p></div></div>
      <div className="mode-body">
        <pre className="command"><code>{block.command}</code></pre>
        <div className="expected"><b>Look for</b><p>{block.expectedObservation}</p></div>
        {state?.completed ? <p className="next-ready">Observation acknowledged. The next step has appeared below.</p> : <div className="action-row">
          <button className="button primary" onClick={() => post(block.id, { action: "acknowledge" }).then(refresh)}>I saw this</button>
          <button className="button secondary" onClick={() => setHelp(block.help?.explain)}>Explain this command</button>
          <button className="button secondary" onClick={() => setHelp(block.help?.command)}>Show the command again</button>
          <button className="button secondary" onClick={() => setHelp(block.help?.expected)}>Describe expected output</button>
        </div>}
        {!state?.completed && <div className="local-help"><label>I saw something different<textarea value={evidence} onChange={(event) => setEvidence(event.target.value)} /></label><button className="button secondary" onClick={() => post(block.id, { action: "unexpected", evidence }).then(refresh)}>Record it and keep trying</button><label>Something else<textarea value={other} onChange={(event) => setOther(event.target.value)} /></label><button className="button secondary" onClick={() => { setHelp("This request is recorded for this block only. Model-backed help is not wired in this draft."); return post(block.id, { action: "help", request: other }).then(refresh); }}>Ask locally</button></div>}
        {help && <aside className="help" aria-live="polite">{help}</aside>}
        {progress.unexpected[block.id]?.map((item, index) => <p className="evidence" key={index}>Recorded different output: {item}</p>)}
      </div>
    </div>
  </section>;
}

function BlockView({ block, progress, refresh }: { block: Block; progress: Progress; refresh(state: State): void }) {
  const state = progressFor(progress, block.id);
  if (block.type === "narrative") return <section id={block.id} className="work-block narrative"><p className="section-label">The idea</p><h2>{block.title}</h2>{renderMarkdown(block.markdown)}</section>;
  if (block.type === "terminal-practice") return <TerminalBlock block={block} progress={progress} refresh={refresh} />;
  if (block.type === "reflection") return <section id={block.id} className="work-block reflection"><p className="section-label">Reflection</p><h2>{block.title}</h2><p className="question">{block.prompt}</p><textarea aria-label="Your reflection" defaultValue={progress.reflections[block.id] ?? ""} id={`${block.id}-answer`} />{state?.completed ? <p className="next-ready">Reflection recorded. Participation is what counts here.</p> : <button className="button primary" onClick={() => post(block.id, { action: "reflect", response: (document.getElementById(`${block.id}-answer`) as HTMLTextAreaElement).value }).then(refresh)}>Record reflection</button>}</section>;
  return <section id={block.id} className="work-block lesson-end"><p className="section-label">Lesson transition</p><h2>{block.title}</h2>{renderMarkdown(block.markdown)}{state?.completed ? <p className="next-ready">Lesson complete.</p> : <button className="button primary" onClick={() => post(block.id, { action: "transition" }).then(refresh)}>{block.label}</button>}</section>;
}

function WorkbookIntroduction({ state, refresh }: { state: State; refresh(state: State): void }) {
  const [sentinel, setSentinel] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    if (state.introductionComplete || !sentinel) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) completeIntroduction().then(refresh);
    }, { threshold: 1 });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [state.introductionComplete, sentinel, refresh]);
  return <section className="workbook-intro" aria-label="Workbook introduction">
    <header><h1>{state.workbook.title}</h1></header>
    {renderMarkdown(state.introduction)}
    {state.introductionComplete ? <p className="next-ready">The first lesson is ready below.</p> : <button className="button primary introduction-continue" onClick={() => completeIntroduction().then(refresh)}>Ready to continue</button>}
    <div ref={setSentinel} className="introduction-end" aria-hidden="true" />
  </section>;
}

function App() {
  const [state, setState] = useState<State>();
  const [viewed, setViewed] = useState<string>();
  useEffect(() => { fetch("api/workbook/state").then((response) => response.json()).then((next: State) => setState(next)); }, []);
  useEffect(() => { if (state) document.title = state.workbook.title; }, [state?.workbook.title]);
  useEffect(() => {
    if (!state?.introductionComplete) return;
    document.getElementById(`part-${state.progress.activeLessonId}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
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
  const parts = useMemo(() => [...new Set(state?.chapters.map((chapter) => chapter.part) ?? [])], [state]);
  if (!state) return <p className="loading">Loading workbook…</p>;
  const emerged = state.chapters.filter((chapter) => chapter.lesson);
  const viewedLesson = viewed ?? state.progress.activeLessonId;
  return <div className="shell">
    <aside className="rail" aria-label="Lesson navigation">
      <div className="brand"><span className="brand-mark" aria-hidden="true">↗</span> {state.workbook.title}</div>
      <nav className="curriculum" aria-label="Workbook navigation">{parts.map((part) => <div key={part}><p className="part-name">{part}</p>{state.chapters.filter((chapter) => chapter.part === part).map((chapter) => {
        const complete = state.progress.completedLessons.includes(chapter.id);
        const current = chapter.id === state.progress.activeLessonId;
        if (!chapter.lesson) return <span key={chapter.id} className="lesson-row ahead unavailable" aria-disabled="true"><span>{chapter.title}</span></span>;
        return <details key={chapter.id} className="lesson-nav" open={viewedLesson === chapter.id}><summary><a href={`#lesson-${chapter.id}`} className={`lesson-row ${complete ? "done" : current ? "current" : "ahead"}`} onClick={() => setViewed(chapter.id)}>{chapter.title}</a></summary>{viewedLesson === chapter.id && <nav className="lesson-outline" aria-label={`${chapter.title} outline`}>{chapter.lesson.blocks.map((block) => <a href={`#${block.id}`} key={block.id} aria-current={block.id === state.progress.activeBlockId ? "true" : undefined}>{block.title}</a>)}</nav>}</details>;
      })}</div>)}</nav>
    </aside>
    <main><article className="page">
      <WorkbookIntroduction state={state} refresh={setState} />
      {emerged.map((chapter) => <article data-lesson-id={chapter.id} key={chapter.id} className="chapter">
        <section id={`part-${chapter.id}`} className="part-chapter" aria-label={chapter.part}><div><p className="part-title">{chapter.part}</p><div className="part-copy">{renderMarkdown(chapter.partMarkdown)}</div></div></section>
        <header id={`lesson-${chapter.id}`}><p className="eyebrow">Part {chapter.partNumber}, Lesson {chapter.lessonNumber}</p><h1>{chapter.lesson!.hero.title}</h1><p className="dek">{chapter.lesson!.hero.dek}</p><div className="lesson-meta">{chapter.lesson!.hero.meta.map((chip) => <span className="chip" key={chip}>{chip}</span>)}</div></header>
        <section className="opening"><p className="section-label">{chapter.lesson!.opening.sectionLabel}</p><h2>{chapter.lesson!.opening.heading}</h2><div className="prose-callout">{renderMarkdown(chapter.lesson!.opening.markdown)}</div><ul className="outcomes">{chapter.lesson!.opening.outcomes.map((outcome) => <li key={outcome}>{outcome}</li>)}</ul></section>
        {chapter.lesson!.blocks.map((block) => <BlockView key={block.id} block={block} progress={state.progress} refresh={setState} />)}
      </article>)}
    </article></main>
  </div>;
}

createRoot(document.getElementById("root")!).render(<App />);
