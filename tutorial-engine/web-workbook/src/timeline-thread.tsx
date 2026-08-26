import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Markdown } from "./markdown.js";

type TimelineMessageRecord = { type: "message"; id: string; sequence: number; at: string; lessonId: string; blockId: string; role: "assistant" | "user"; source: "authored" | "learner" | "main_tutor" | "block_tutor" | "tutor"; presentation: "course" | "chat" | "hint" | "review"; text: string; blockInView?: string };
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

export function TimelineThread({ records, activeLessonId, activeBlockId, onSend, onRetry, onDoItForMe, renderContinuation, activeSurface, completionPanel, readyBlockIds = [], inputDisabled = false, activeReflectionReviewing = false }: {
  records: readonly TimelineThreadRecord[];
  activeLessonId: string;
  activeBlockId: string;
  onSend(text: string): Promise<void>;
  onRetry(failureId: string): Promise<void>;
  onDoItForMe?(): void;
  renderContinuation?(record: TimelineMessageRecord): React.ReactNode;
  activeSurface?: React.ReactNode;
  completionPanel?: React.ReactNode;
  readyBlockIds?: readonly string[];
  inputDisabled?: boolean;
  activeReflectionReviewing?: boolean;
}) {
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [commandInserted, setCommandInserted] = useState(false);
  const [pendingEchoes, setPendingEchoes] = useState<{ id: string; text: string }[]>([]);
  const nextEchoId = useRef(0);
  const latestEntryRef = useRef<HTMLElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const chatEntryCount = records.reduce((count, record) => count + ((record.type === "message" && record.presentation !== "course") || record.type === "tutor_failed" ? 1 : 0), 0) + pendingEchoes.length + (activeReflectionReviewing ? 1 : 0);
  const recordMatchesActive = (record: { lessonId: string; blockId: string }) => record.blockId === activeBlockId && (record.lessonId === activeLessonId || activeBlockId.includes("--"));
  const activeAuthoredRecordId = [...records].reverse().find((record) => record.type === "message" && record.presentation === "course" && record.source === "authored" && recordMatchesActive(record))?.id;
  const readyBlockIdSet = new Set(readyBlockIds);
  useEffect(() => {
    if (chatEntryCount === 0) return;
    (latestEntryRef.current as (HTMLElement & { scrollIntoView?(options?: ScrollIntoViewOptions): void }) | null)?.scrollIntoView?.({ behavior: "smooth", block: "end" });
  }, [chatEntryCount]);
  useLayoutEffect(() => {
    if (textareaRef.current) resizeComposerTextarea(textareaRef.current);
  }, [draft]);
  useEffect(() => { setCommandInserted(false); }, [activeLessonId, activeBlockId]);
  const submitText = async (text: string) => {
    const trimmed = text.trim();
    if (inputDisabled || pending || !trimmed) return;
    setDraft("");
    setPending(true);
    const echoId = `local-echo-${nextEchoId.current++}`;
    setPendingEchoes((echoes) => [...echoes, { id: echoId, text: trimmed }]);
    try {
      await onSend(trimmed);
    } catch (error) {
      setDraft(text);
      throw error;
    } finally {
      setPendingEchoes((echoes) => echoes.filter((echo) => echo.id !== echoId));
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
  const renderConversationRecord = (record: TimelineThreadRecord) => {
    if (record.type === "tutor_failed") return <aside key={record.id} ref={(el) => { latestEntryRef.current = el; }} className="timeline-message tutor failure" aria-live="polite"><b>Tutor unavailable</b><p>{record.publicMessage}</p><button className="button secondary" onClick={() => void onRetry(record.failureId)}>Retry</button></aside>;
    if (record.type !== "message") return null;
    const className = record.role === "user" ? "timeline-message learner" : `timeline-message tutor${record.presentation === "review" ? " review" : record.presentation === "hint" ? " hint" : ""}`;
    return <article key={record.id} ref={(el) => { latestEntryRef.current = el; }} className={className}><b>{record.role === "user" ? "You" : record.presentation === "review" ? "Tutor review" : "Tutor"}</b>{record.role === "user" ? <p>{record.text}</p> : <Markdown source={record.source === "authored" && record.presentation === "course" ? "authored" : "generated"}>{record.text}</Markdown>}</article>;
  };
  const pendingEchoNodes = pendingEchoes.map((echo) => <article key={echo.id} ref={(el) => { latestEntryRef.current = el; }} className="timeline-message learner"><b>You</b><p>{echo.text}</p></article>);
  const pendingThinkingNode = pendingEchoes.length > 0 || activeReflectionReviewing ? <aside ref={(el) => { latestEntryRef.current = el; }} className="timeline-message tutor thinking" role="status" aria-live="polite" aria-label="Tutor is thinking"><b>Tutor</b><span className="tutor-thinking-dots" aria-hidden="true"><span className="tutor-thinking-dot" /><span className="tutor-thinking-dot" /><span className="tutor-thinking-dot" /></span><span className="tutor-thinking-label">Thinking</span></aside> : null;
  const renderedRecords = (() => {
    const nodes: React.ReactNode[] = [];
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      if (!record) continue;
      if (record.type === "message" && record.presentation === "course" && record.source === "authored") {
        const following: TimelineThreadRecord[] = [];
        let nextIndex = index + 1;
        while (nextIndex < records.length) {
          const next = records[nextIndex]!;
          if (next.type === "message" && next.presentation === "course" && next.source === "authored") break;
          if (("lessonId" in next ? next.lessonId : undefined) === record.lessonId && ("blockId" in next ? next.blockId : undefined) === record.blockId) following.push(next);
          nextIndex += 1;
        }
        const active = recordMatchesActive(record);
        const transitionClass = record.blockId.startsWith("part--") || record.lessonId.startsWith("workbook:part:") && record.blockId === "__part__"
          ? " timeline-part-transition"
          : "";
        const canInsertCommand = Boolean(onDoItForMe && record.id === activeAuthoredRecordId);
        const lastMessage = ([...following].reverse().find((candidate): candidate is TimelineMessageRecord => candidate.type === "message") ?? record);
        nodes.push(<section key={record.id} id={record.blockId} className={`work-block active-block-region${active ? " is-active" : ""}`} tabIndex={-1} data-active-block={active ? "true" : undefined}>
          <article className={`timeline-authored-content${transitionClass}`}><Markdown source="authored">{record.text}</Markdown></article>
          {active && activeSurface}
          {canInsertCommand && <button className="button primary timeline-do-it" onClick={() => { onDoItForMe?.(); setCommandInserted(true); }}>{commandInserted ? "Inserted — press Enter" : "Do it for me"}</button>}
          {following.map(renderConversationRecord)}
          {active && pendingEchoNodes}
          {active && pendingThinkingNode}
          {renderContinuation?.(lastMessage)}
          {readyBlockIdSet.has(record.blockId) ? <div className="ready-successor-scroll-runway" aria-hidden="true" /> : null}
        </section>);
        index = nextIndex - 1;
        continue;
      }
      const hasPriorCourse = records.slice(0, index).some((candidate) => candidate.type === "message" && candidate.presentation === "course" && candidate.source === "authored" && "lessonId" in record && candidate.lessonId === record.lessonId && candidate.blockId === record.blockId);
      if (!hasPriorCourse) nodes.push(renderConversationRecord(record));
    }
    if (!nodes.some((node: any) => node?.props?.["data-active-block"] === "true")) nodes.push(...pendingEchoNodes, pendingThinkingNode);
    return nodes;
  })();
  return <section className="timeline-thread has-fixed-composer" aria-label="Tutor conversation">
    {renderedRecords}
    {completionPanel}
    <div className="timeline-composer-dock fixed-composer">
      <form className="timeline-input fixed-composer" onSubmit={send}>
        <textarea ref={textareaRef} className="timeline-composer-textarea" name="message" rows={1} aria-label="Message the tutor" value={draft} onInput={(event) => setDraft(event.currentTarget.value)} onChange={(event) => setDraft(event.target.value)} onKeyDown={handleComposerKeyDown} disabled={inputDisabled || pending} />
        <button className="round-send" aria-label="Send message" title="Send message" disabled={inputDisabled || pending || !draft.trim()}>{pending ? "…" : "↑"}</button>
      </form>
    </div>
  </section>;
}
