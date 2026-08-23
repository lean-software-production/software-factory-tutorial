import React, { useLayoutEffect, useRef, useState } from "react";
import { Markdown } from "../../web/src/markdown";

type TimelineMessageRecord = { type: "message"; id: string; sequence: number; at: string; lessonId: string; blockId: string; role: "assistant" | "user"; source: "authored" | "learner" | "main_tutor" | "block_tutor" | "tutor"; presentation: "course" | "chat" | "hint" | "review"; text: string };
export type PublicTimelineRecord =
  | TimelineMessageRecord
  | { type: "tutor_failed"; id: string; sequence: number; at: string; lessonId: string; blockId: string; failureId: string; operation: string; publicMessage: string };
type InternalTimelineRecord = { type: "block_tutor_briefed" | "block_tutor_readiness" | "block_summarized" | "lesson_summarized"; id: string; sequence: number; at: string; lessonId?: string; blockId?: string; text?: string };
type TimelineThreadRecord = PublicTimelineRecord | InternalTimelineRecord;

const composerMaxHeightPx = 160;

function resizeComposerTextarea(textarea: HTMLTextAreaElement) {
  textarea.style.height = "auto";
  const nextHeight = Math.min(textarea.scrollHeight, composerMaxHeightPx);
  textarea.style.height = `${nextHeight}px`;
  textarea.style.overflowY = textarea.scrollHeight > composerMaxHeightPx ? "auto" : "hidden";
}

export function TimelineThread({ records, activeLessonId, activeBlockId, onSend, onRetry, renderContinuation, inputDisabled = false }: {
  records: readonly TimelineThreadRecord[];
  activeLessonId: string;
  activeBlockId: string;
  onSend(text: string): Promise<void>;
  onRetry(failureId: string): Promise<void>;
  renderContinuation?(record: TimelineMessageRecord): React.ReactNode;
  inputDisabled?: boolean;
}) {
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  useLayoutEffect(() => {
    if (textareaRef.current) resizeComposerTextarea(textareaRef.current);
  }, [draft]);
  const submitText = async (text: string) => {
    const trimmed = text.trim();
    if (inputDisabled || pending || !trimmed) return;
    setPending(true);
    try {
      await onSend(trimmed);
      setDraft("");
    } finally {
      setPending(false);
    }
  };
  const send = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = (event.currentTarget || event.target) as HTMLFormElement;
    const formText = (form.elements.namedItem("message") as HTMLTextAreaElement | null)?.value ?? "";
    await submitText(draft || formText);
  };
  const handleComposerKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    if (event.shiftKey) {
      const textarea = event.currentTarget;
      const start = textarea.selectionStart ?? textarea.value.length;
      const end = textarea.selectionEnd ?? start;
      const nextDraft = `${textarea.value.slice(0, start)}\n${textarea.value.slice(end)}`;
      textarea.value = nextDraft;
      textarea.selectionStart = textarea.selectionEnd = start + 1;
      setDraft(nextDraft);
      return;
    }
    void submitText(draft || event.currentTarget.value);
  };
  return <section className="timeline-thread has-fixed-composer" aria-label="Tutor conversation">
    {records.map((record) => {
      if (record.type === "tutor_failed") return <aside key={record.id} className="timeline-message tutor failure" aria-live="polite"><b>Tutor unavailable</b><p>{record.publicMessage}</p><button className="button secondary" onClick={() => void onRetry(record.failureId)}>Retry</button></aside>;
      if (record.type !== "message") return null;
      const continuation = record.lessonId === activeLessonId && record.blockId === activeBlockId ? renderContinuation?.(record) : null;
      if (record.presentation === "course") return <React.Fragment key={record.id}><article className="timeline-message authored"><p className="section-label">Course note</p><Markdown>{record.text}</Markdown></article>{continuation}</React.Fragment>;
      const className = record.role === "user" ? "timeline-message learner" : `timeline-message tutor${record.presentation === "review" ? " review" : record.presentation === "hint" ? " hint" : ""}`;
      return <React.Fragment key={record.id}><article className={className}><b>{record.role === "user" ? "You" : record.presentation === "review" ? "Tutor review" : "Tutor"}</b><p>{record.text}</p></article>{continuation}</React.Fragment>;
    })}
    <div className="timeline-composer-dock fixed-composer">
      <form className="timeline-input fixed-composer" onSubmit={send}>
        <textarea ref={textareaRef} className="timeline-composer-textarea" name="message" rows={1} aria-label="Message the tutor" value={draft} onInput={(event) => setDraft(event.currentTarget.value)} onChange={(event) => setDraft(event.target.value)} onKeyDown={handleComposerKeyDown} disabled={inputDisabled || pending} />
        <button className="round-send" aria-label="Send message" title="Send message" disabled={inputDisabled || pending || !draft.trim()}>{pending ? "…" : "↑"}</button>
      </form>
    </div>
  </section>;
}
