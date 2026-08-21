import React, { useState } from "react";
import { Markdown } from "../../web/src/markdown";

export type PublicTimelineRecord =
  | { type: "message"; id: string; sequence: number; at: string; lessonId: string; blockId: string; role: "assistant" | "user"; source: "authored" | "learner" | "tutor"; presentation: "course" | "chat" | "review"; text: string }
  | { type: "tutor_failed"; id: string; sequence: number; at: string; lessonId: string; blockId: string; requestId: string; operation: string; publicMessage: string };

export function TimelineThread({ records, activeBlockId, onSend, onRetry }: {
  records: readonly PublicTimelineRecord[];
  activeBlockId: string;
  onSend(text: string): Promise<void>;
  onRetry(failureId: string): Promise<void>;
}) {
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const send = async (event: React.FormEvent) => {
    event.preventDefault();
    if (pending || !draft.trim()) return;
    setPending(true);
    try {
      await onSend(draft.trim());
      setDraft("");
    } finally {
      setPending(false);
    }
  };
  return <section className="timeline-thread" aria-label="Tutor conversation">
    {records.map((record) => {
      if (record.type === "tutor_failed") return <aside key={record.id} className="timeline-message tutor failure" aria-live="polite"><b>Tutor unavailable</b><p>{record.publicMessage}</p><button className="button secondary" onClick={() => void onRetry(record.id)}>Retry</button></aside>;
      if (record.presentation === "course") return <article key={record.id} className="timeline-message authored"><p className="section-label">Course note</p><Markdown>{record.text}</Markdown></article>;
      const className = record.role === "user" ? "timeline-message learner" : `timeline-message tutor${record.presentation === "review" ? " review" : ""}`;
      return <article key={record.id} className={className}><b>{record.role === "user" ? "You" : record.presentation === "review" ? "Tutor review" : "Tutor"}</b><p>{record.text}</p></article>;
    })}
    <form className="timeline-input" onSubmit={send}><label>Message the tutor<textarea value={draft} onChange={(event) => setDraft(event.target.value)} disabled={pending} /></label><button className="button primary" disabled={pending || !draft.trim()}>{pending ? "Thinking…" : "Send"}</button></form>
  </section>;
}
