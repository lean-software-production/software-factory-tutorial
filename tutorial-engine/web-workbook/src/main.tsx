import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

type Block = { id: string; type: string; title: string; markdown?: string; command?: string; context?: string; expectedObservation?: string; help?: Record<string,string>; prompt?: string; label?: string };
type Chapter = { id: string; title: string; part?: string; state: "migrated" | "unavailable"; lesson?: { id: string; title: string; status: string; keyConcepts: string[]; learningOutcomes: string[]; blocks: Block[] } };
type Progress = { activeLessonId: string; activeBlockId: string; completedLessons: string[]; blocks: { id: string; ready: boolean; active: boolean; completed: boolean }[]; unexpected: Record<string,string[]>; reflections: Record<string,string> };
type State = { title: string; chapters: Chapter[]; progress: Progress; adapter: { note: string } };

async function post(blockId: string, body: object): Promise<State> {
  const response = await fetch("api/workbook/events", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ blockId, ...body }) });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}
function renderMarkdown(text = "") { return text.split(/\n\n+/).map((p, i) => <p key={i}>{p.split(/(\*\*[^*]+\*\*)/).map((part, j) => part.startsWith("**") ? <strong key={j}>{part.slice(2,-2)}</strong> : part)}</p>); }

function TerminalBlock({ block, progress, refresh }: { block: Block; progress: Progress; refresh(s: State): void }) {
  const state = progress.blocks.find((b) => b.id === block.id)!; const [evidence, setEvidence] = useState(""); const [help, setHelp] = useState<string>(); const [other, setOther] = useState("");
  return <section id={block.id} className={`block practice ${state.active ? "active" : ""}`} aria-disabled={!state.ready}>
    <h3>{block.title}</h3><p><b>Terminal context:</b> {block.context}</p><pre><code>{block.command}</code></pre><p><b>Expected observation:</b> {block.expectedObservation}</p>
    {!state.ready && <p className="held">This practice is visible but held until the previous required block is complete.</p>}
    {state.completed ? <p className="done">Observation acknowledged.</p> : state.ready && <div className="controls">
      <button onClick={() => post(block.id,{ action:"acknowledge" }).then(refresh)}>I saw this</button>
      <button onClick={() => setHelp(block.help?.explain)}>Explain this command</button><button onClick={() => setHelp(block.help?.command)}>Show the command again</button><button onClick={() => setHelp(block.help?.expected)}>Describe expected output</button>
      <label>I saw something different<textarea value={evidence} onChange={(e)=>setEvidence(e.target.value)} /></label><button onClick={() => post(block.id,{ action:"unexpected", evidence }).then(refresh)}>Record evidence and keep trying</button>
      <label>Something else<textarea value={other} onChange={(e)=>setOther(e.target.value)} /></label><button onClick={() => { setHelp("This free-text request is recorded for this block only. Model-backed help is not wired in this vertical slice."); return post(block.id,{ action:"help", request: other }).then(refresh); }}>Ask locally</button>
    </div>}
    {help && <aside className="help">{help}</aside>}{progress.unexpected[block.id]?.map((item, i) => <p className="evidence" key={i}>Recorded different output: {item}</p>)}
  </section>;
}
function BlockView({ block, progress, refresh }: { block: Block; progress: Progress; refresh(s: State): void }) {
  const p = progress.blocks.find((b) => b.id === block.id);
  if (block.type === "narrative") return <section id={block.id} className="block narrative"><h3>{block.title}</h3>{renderMarkdown(block.markdown)}</section>;
  if (block.type === "terminal-practice") return <TerminalBlock block={block} progress={progress} refresh={refresh}/>;
  if (block.type === "reflection") return <section id={block.id} className="block reflection"><h3>{block.title}</h3><p>{block.prompt}</p><textarea defaultValue={progress.reflections[block.id] ?? ""} id={`${block.id}-answer`} />{p?.completed ? <p className="done">Reflection recorded. Participation is what counts here.</p> : p?.ready && <button onClick={() => post(block.id,{ action:"reflect", response:(document.getElementById(`${block.id}-answer`) as HTMLTextAreaElement).value }).then(refresh)}>Record reflection</button>}</section>;
  return <section id={block.id} className="block transition"><h3>{block.title}</h3>{renderMarkdown(block.markdown)}{p?.completed ? <p className="done">Lesson complete.</p> : p?.ready && <button onClick={() => post(block.id,{ action:"transition" }).then(refresh)}>{block.label}</button>}</section>;
}
function App() {
  const [state, setState] = useState<State>(); const [viewed, setViewed] = useState("001");
  useEffect(() => { fetch("api/workbook/state").then((r) => r.json()).then((s: State) => setState(s)); }, []);
  useEffect(() => { if (!state) return; document.getElementById(state.progress.activeBlockId)?.scrollIntoView({ block: "nearest" }); }, [state?.progress.activeBlockId]);
  useEffect(() => { if (!state) return; const onScroll = () => { let current = viewed; for (const c of state.chapters.filter((chapter) => chapter.state === "migrated")) { const el = document.getElementById(`lesson-${c.id}`); if (el && el.getBoundingClientRect().top < 120) current = c.id; } setViewed(current); }; addEventListener("scroll", onScroll); return () => removeEventListener("scroll", onScroll); }, [state, viewed]);
  const parts = useMemo(() => [...new Set(state?.chapters.map((c) => c.part) ?? [])], [state]); if (!state) return <p>Loading workbook…</p>;
  const visibleBlocks = (lesson: NonNullable<Chapter["lesson"]>) => { const active = lesson.blocks.findIndex((block) => block.id === state.progress.activeBlockId); return lesson.blocks.slice(0, active < 0 ? lesson.blocks.length : active + 1); };
  return <><nav className="rail" aria-label="Curriculum"><h1>Workbook</h1>{parts.map((part) => <div key={part}><h2>{part}</h2>{state.chapters.filter((c)=>c.part===part).map((c) => c.lesson ? <a key={c.id} href={`#lesson-${c.id}`} className={`${c.id===state.progress.activeLessonId ? "active-lesson" : ""} ${c.state}`} onClick={()=>setViewed(c.id)}><span>{c.id}</span> {c.title}{viewed===c.id && <ol>{visibleBlocks(c.lesson).map((b)=><li key={b.id}>{b.title}</li>)}</ol>}</a> : <span key={c.id} className="rail-entry unavailable" aria-disabled="true"><span>{c.id}</span> {c.title}</span>)}</div>)}</nav><main className="paper"><p className="draft">Lesson 001 workbook material is draft pending human curriculum review. {state.adapter.note}</p>{state.chapters.filter((c) => c.lesson).map((c) => <article id={`lesson-${c.id}`} key={c.id} className="chapter"><h2>{c.id}. {c.title}</h2><p className="status">{c.id===state.progress.activeLessonId ? "Active lesson" : "Ahead of progress; reading does not advance progress."}</p><h3>Key concepts</h3><ul>{c.lesson!.keyConcepts.map((x)=><li key={x}>{x}</li>)}</ul><h3>Learning outcomes</h3><ul>{c.lesson!.learningOutcomes.map((x)=><li key={x}>{x}</li>)}</ul>{visibleBlocks(c.lesson!).map((b)=><BlockView key={b.id} block={b} progress={state.progress} refresh={setState}/>)}</article>)}</main></>;
}

createRoot(document.getElementById("root")!).render(<App />);
