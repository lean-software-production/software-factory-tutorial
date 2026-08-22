import React, { useState } from "react";
import { Markdown } from "../../web/src/markdown";

type TimelineMessageRecord = { type: "message"; id: string; sequence: number; at: string; lessonId: string; blockId: string; role: "assistant" | "user"; source: "authored" | "learner" | "main_tutor" | "block_tutor" | "tutor"; presentation: "course" | "chat" | "hint" | "review"; text: string };
export type PublicTimelineRecord =
  | TimelineMessageRecord
  | { type: "tutor_failed"; id: string; sequence: number; at: string; lessonId: string; blockId: string; failureId: string; operation: string; publicMessage: string };
type InternalTimelineRecord = { type: "block_tutor_briefed" | "block_tutor_readiness" | "block_summarized" | "lesson_summarized"; id: string; sequence: number; at: string; lessonId?: string; blockId?: string; text?: string };
type TimelineThreadRecord = PublicTimelineRecord | InternalTimelineRecord;

export function TimelineThread({ records, activeLessonId, activeBlockId, onSend, onRetry, renderContinuation }: {
  records: readonly TimelineThreadRecord[];
  activeLessonId: string;
  activeBlockId: string;
  onSend(text: string): Promise<void>;
  onRetry(failureId: string): Promise<void>;
  renderContinuation?(record: TimelineMessageRecord): React.ReactNode;
}) {
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const send = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = (event.currentTarget || event.target) as HTMLFormElement;
    const formText = (form.elements.namedItem("message") as HTMLTextAreaElement | null)?.value ?? "";
    const text = (draft.trim() || formText.trim());
    if (pending || !text) return;
    setPending(true);
    try {
      await onSend(text);
      setDraft("");
    } finally {
      setPending(false);
    }
  };
  return <section className="timeline-thread has-fixed-composer" aria-label="Tutor conversation">
    {records.map((record) => {
      if (record.type === "tutor_failed") return <aside key={record.id} className="timeline-message tutor failure" aria-live="polite"><b>Tutor unavailable</b><p>{record.publicMessage}</p><button className="button secondary" onClick={() => void onRetry(record.failureId)}>Retry</button></aside>;
      if (record.type !== "message") return null;
      if (record.presentation === "course") return <React.Fragment key={record.id}><article className="timeline-message authored"><p className="section-label">Course note</p><Markdown>{record.text}</Markdown></article>{record.lessonId === activeLessonId && record.blockId === activeBlockId && renderContinuation?.(record)}</React.Fragment>;
      const className = record.role === "user" ? "timeline-message learner" : `timeline-message tutor${record.presentation === "review" ? " review" : record.presentation === "hint" ? " hint" : ""}`;
      return <article key={record.id} className={className}><b>{record.role === "user" ? "You" : record.presentation === "review" ? "Tutor review" : "Tutor"}</b><p>{record.text}</p></article>;
    })}
    <form className="timeline-input fixed-composer" onSubmit={send}><label>Message the tutor<textarea name="message" value={draft} onInput={(event) => setDraft(event.currentTarget.value)} onChange={(event) => setDraft(event.target.value)} disabled={pending} /></label><button className="button primary" disabled={pending || !draft.trim()}>{pending ? "Thinking…" : "Send"}</button></form>
  </section>;
}
