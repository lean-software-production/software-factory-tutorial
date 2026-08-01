import { StrictMode, useEffect, useMemo, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import mermaid from "mermaid";
import { ChoiceIcon } from "./choice-icon.js";
import { FileExcerptCodeBlock, Markdown } from "./markdown.js";
import { parseTutorialEvent, serializeBrowserMessage, type BrowserMessage, type RunState, type SessionBootstrap, type TutorialEvent } from "../../src/protocol/events.js";
import type { ProgressItem } from "../../src/lesson/load.js";
import "./styles.css";

type Event = Exclude<TutorialEvent, { type: "snapshot" }>;
type Snapshot = Extract<TutorialEvent, { type: "snapshot" }>;
type WireEvent = Event | Snapshot;

function applyEvent(events: Event[], incoming: Event): Event[] {
  if (incoming.type === "assistant-delta") {
    const existing = events.findIndex((event) => event.type === "assistant-delta" && event.messageId === incoming.messageId);
    if (existing >= 0) {
      const event = events[existing] as Extract<Event, { type: "assistant-delta" }>;
      return events.map((item, index) => index === existing ? { ...incoming, delta: event.delta + incoming.delta } : item);
    }
  }
  if (incoming.type === "assistant-message") {
    const existing = events.findIndex((event) => event.type === "assistant-delta" && event.messageId === incoming.messageId);
    if (existing >= 0) return events.map((item, index) => index === existing ? incoming : item);
  }
  return [...events, incoming];
}

function MermaidCard({ source, text }: { source: string; text: string }) {
  const [svg, setSvg] = useState<string>();
  const [failed, setFailed] = useState(false);
  const id = useMemo(() => `mermaid-${Math.random().toString(36).slice(2)}`, []);
  useEffect(() => {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: "base",
      themeVariables: {
        primaryColor: "#dbeafe",
        primaryBorderColor: "#2563eb",
        primaryTextColor: "#172554",
        secondaryColor: "#dcfce7",
        tertiaryColor: "#fef3c7",
        lineColor: "#64748b"
      }
    });
    void mermaid.render(id, source).then(({ svg: rendered }) => setSvg(rendered)).catch(() => setFailed(true));
  }, [id, source]);
  return <>
    <p className="visually-hidden">Diagram description: {text}</p>
    {svg && !failed ? <div className="diagram" dangerouslySetInnerHTML={{ __html: svg }} /> : <pre className="raw-diagram">{source}</pre>}
    {failed && <p className="muted">Diagram rendering failed; Mermaid source is shown.</p>}
  </>;
}

function Card({ children, title, className = "" }: { children: ReactNode; title?: string; className?: string }) {
  return <article className={`card ${className}`}>{title && <h2>{title}</h2>}{children}</article>;
}

function TranscriptEvent({ event, send }: { event: Event; send: (message: BrowserMessage) => void }) {
  switch (event.type) {
    case "assistant-delta": case "assistant-message": return <Card className="assistant"><Markdown>{event.type === "assistant-delta" ? event.delta : event.markdown}</Markdown></Card>;
    case "user-message": return <Card className="user"><Markdown>{event.markdown}</Markdown></Card>;
    case "presentation": return <Card title={event.presentation.title} className="presentation">{event.presentation.kind === "markdown" ? <Markdown>{event.presentation.markdown}</Markdown> : <MermaidCard source={event.presentation.mermaid} text={event.presentation.text} />}</Card>;
    case "file-excerpt": return <Card title={event.title} className="excerpt"><p className="path">{event.path}:{event.startLine}</p><FileExcerptCodeBlock path={event.path} source={event.content} />{event.truncated && <p className="muted">Excerpt only</p>}</Card>;
    case "validation": return <Card title={`${event.passed ? "Passed" : "Failed"}: ${event.label}`} className={event.passed ? "validation pass" : "validation fail"}><p className="path">$ {event.command} · {event.durationMs}ms</p><pre>{event.output || "(no output)"}</pre></Card>;
    case "choice": return <ChoiceCard event={event} send={send} />;
    case "tool-start": case "tool-progress": case "tool-complete": return null;
    case "tool-error": case "error": return <Card title="Something needs attention" className="error"><p>{event.message}</p>{event.retryable && <p className="muted">You can retry or tell the coach what happened.</p>}</Card>;
    case "choice-resolved": case "run-state": case "session-state": case "audit": return null;
  }
}

function ChoiceCard({ event, send }: { event: Extract<Event, { type: "choice" }>; send: (message: BrowserMessage) => void }) {
  const [chosen, setChosen] = useState<string>();
  return <Card title="Your choice" className="choice"><p>{event.question}</p><div className="options">{event.options.map((option) => <button key={option.id} disabled={event.historical || Boolean(chosen)} onClick={() => { setChosen(option.id); send({ type: "choose", choiceId: event.id, optionId: option.id }); }}><span className="choice-option-label"><ChoiceIcon category={option.icon} /><strong>{option.label}</strong></span>{option.description && <span className="choice-option-description">{option.description}</span>}</button>)}</div>{event.historical && <p className="muted">This was a choice from the saved session.</p>}</Card>;
}

function SessionStartCard({ session, send }: { session: SessionBootstrap; send: (message: BrowserMessage) => void }) {
  if (session.state !== "select") return null;
  return <Card title="Continue this tutorial?" className="choice"><p>A saved session was found. Resume keeps the factory files and shows the earlier transcript. Starting again removes everything in <code>factory/</code>.</p><div className="options"><button onClick={() => send({ type: "start-session", mode: "resume" })}><span className="choice-option-label"><ChoiceIcon category="do" /><strong>Resume saved session</strong></span></button><button onClick={() => send({ type: "start-session", mode: "fresh" })}><span className="choice-option-label"><ChoiceIcon category="restart" /><strong>Start again</strong></span><span className="choice-option-description">Deletes factory/* and begins from the first step.</span></button></div></Card>;
}

function App() {
  const [title, setTitle] = useState("Tutorial");
  const [state, setState] = useState<RunState>("working");
  const [events, setEvents] = useState<Event[]>([]);
  const [validationCommands, setValidationCommands] = useState<Array<{ id: string; label: string }>>([]);
  const [progress, setProgress] = useState<ProgressItem[]>([]);
  const [session, setSession] = useState<SessionBootstrap>({ state: "starting", hasSavedSession: false });
  const [text, setText] = useState("");
  const send = (message: BrowserMessage) => {
    if (message.type === "start-session") setSession((current) => ({ ...current, state: "starting" }));
    void fetch("/api/messages", { method: "POST", headers: { "Content-Type": "application/json" }, body: serializeBrowserMessage(message) });
  };
  useEffect(() => {
    const source = new EventSource("/api/events");
    source.onmessage = ({ data }) => {
      const event = parseTutorialEvent(data) as WireEvent;
      if (event.type === "snapshot") { setTitle(event.title); setState(event.runState); setEvents(event.events.reduce(applyEvent, [])); setValidationCommands(event.validationCommands); setProgress(event.progress); setSession(event.session); return; }
      if (event.type === "run-state") setState(event.state);
      if (event.type === "session-state") { setSession(event.session); return; }
      setEvents((current) => applyEvent(current, event));
    };
    return () => source.close();
  }, []);
  return <main><header><div><p className="eyebrow">LOCAL TUTORIAL</p><h1>{title}</h1><nav className="progress" aria-label="Tutorial progress">{progress.map((item) => <span key={item.id} className={item.state}>{item.label}</span>)}</nav></div><span className={`state ${state}`}>{state.replace("-", " ")}</span></header>
    <section className="transcript" aria-live="polite"><SessionStartCard session={session} send={send} />{events.map((event, index) => <TranscriptEvent key={`${event.type}-${index}`} event={event} send={send} />)}{session.state !== "select" && state === "working" && <div className="thinking" role="status"><span aria-hidden="true" />Thinking…</div>}</section>
    {session.state === "active" && <footer><form onSubmit={(event) => { event.preventDefault(); if (text.trim()) { send({ type: "chat", text }); setText(""); } }}><label className="visually-hidden" htmlFor="chat">Message the coach</label><textarea id="chat" value={text} onChange={(event) => setText(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); if (text.trim()) { send({ type: "chat", text }); setText(""); } } }} placeholder="Ask the coach or steer the current step…" rows={2} /><button type="submit">Send</button></form><div className="secondary"><button onClick={() => send({ type: "abort" })} disabled={state === "idle"}>Stop</button>{validationCommands.map((command) => <button key={command.id} onClick={() => send({ type: "run-validation", commandId: command.id })}>{command.label}</button>)}</div></footer>}
  </main>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
