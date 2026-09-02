import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Markdown } from "./markdown.js";
import { announceContent } from "./scroll-authority.js";
import type { PublicTimelineMessage, PublicTimelineRecord } from "../../src/workbook/public-contract.js";

export type { PublicTimelineRecord };
type TimelineMessageRecord = PublicTimelineMessage;
type TimelineThreadRecord = PublicTimelineRecord;

const composerMaxHeightPx = 160;

/** The DOM id of a conversation record's article, which the scroll authority can announce and reveal. */
export function timelineMessageElementId(recordId: string): string {
  return `timeline-message-${recordId}`;
}

function isMessageRecord(record: TimelineThreadRecord): boolean {
  return (record as { type?: unknown }).type === "message";
}

function isAuthoredCourseRecord(record: TimelineThreadRecord): boolean {
  return isMessageRecord(record) && record.presentation === "course" && record.source === "authored";
}

function isLessonFrameRecord(record: TimelineThreadRecord): boolean {
  return isAuthoredCourseRecord(record) && (record.blockId === "__lesson_frame__" || /^lesson--[a-z0-9]+(?:-[a-z0-9]+)*$/.test(record.blockId));
}

function belongsToAuthoredBlock(record: TimelineThreadRecord, authored: TimelineMessageRecord): boolean {
  return record.lessonId === authored.lessonId && record.blockId === authored.blockId;
}

function resizeComposerTextarea(textarea: HTMLTextAreaElement) {
  textarea.style.height = "auto";
  const nextHeight = Math.min(textarea.scrollHeight, composerMaxHeightPx);
  textarea.style.height = `${nextHeight}px`;
  textarea.style.overflowY = textarea.scrollHeight > composerMaxHeightPx ? "auto" : "hidden";
}

export function TimelineThread({ records, activeLessonId, activeBlockId, onSend, onDoItForMe, renderContinuation, renderPracticeHistory, practiceSurface, practiceSurfaceBlockId, completionPanel, readyBlockIds = [], inputDisabled = false, activeReflectionReviewing = false }: {
  records: readonly TimelineThreadRecord[];
  activeLessonId: string;
  activeBlockId: string;
  onSend(text: string): Promise<void>;
  onDoItForMe?(): void;
  renderContinuation?(record: TimelineMessageRecord): React.ReactNode;
  /** A durable, static practice surface directly below its own authored record. */
  renderPracticeHistory?(record: TimelineMessageRecord): React.ReactNode;
  /** One live practice surface, anchored to its authored record whether ready or active. */
  practiceSurface?: React.ReactNode;
  practiceSurfaceBlockId?: string;
  completionPanel?: React.ReactNode;
  readyBlockIds?: readonly string[];
  inputDisabled?: boolean;
  activeReflectionReviewing?: boolean;
}) {
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [commandInserted, setCommandInserted] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const messageEntryRefs = useRef(new Map<string, HTMLElement>());
  const knownMessageIds = useRef<Set<string> | null>(null);
  const recordMatchesActive = (record: { lessonId: string; blockId: string }) => record.blockId === activeBlockId && (record.lessonId === activeLessonId || activeBlockId.includes("--"));
  const activeAuthoredRecordId = [...records].reverse().find((record) => isAuthoredCourseRecord(record) && recordMatchesActive(record))?.id;
  const readyBlockIdSet = new Set(readyBlockIds);
  const conversationRecords = records.filter((record): record is TimelineMessageRecord => isMessageRecord(record) && !isAuthoredCourseRecord(record));
  const latestMessage = conversationRecords.at(-1);
  const latestMessageId = latestMessage?.id;
  const latestMessageIsReply = latestMessage?.role === "assistant";
  const latestMessageIsReview = latestMessage?.presentation === "review";
  const messageIdsKey = conversationRecords.map((record) => record.id).join("\u0000");
  // `records` is a new array every render, so the set below is memoised on the ids it contains
  // rather than on the array's identity. That lets the effect depend on exactly what it reads.
  const messageIdSet = useMemo(() => new Set(messageIdsKey ? messageIdsKey.split("\u0000") : []), [messageIdsKey]);
  // A message that arrives after mount is announced, never scrolled to. The learner may be
  // reading or typing above; the scroll authority shows the "new below" chip if it landed below
  // the fold and leaves the page where the learner put it.
  useLayoutEffect(() => {
    if (knownMessageIds.current === null) {
      knownMessageIds.current = messageIdSet;
      return;
    }
    const fresh = latestMessageId !== undefined && !knownMessageIds.current.has(latestMessageId);
    knownMessageIds.current = messageIdSet;
    if (!fresh) return;
    const element = messageEntryRefs.current.get(latestMessageId);
    if (!element) return;
    // A review is also welded to the live practice surface; if that bar is in view the learner is
    // already reading the review, and the chip would only point at its copy below.
    const representatives = latestMessageIsReview ? [element, ...Array.from(document.querySelectorAll<HTMLElement>(".current-activity-band .live-block-feedback"))] : [element];
    announceContent(element, latestMessageIsReply ? "New reply below" : "New message below", representatives);
  }, [latestMessageId, latestMessageIsReply, latestMessageIsReview, messageIdSet]);
  useLayoutEffect(() => {
    if (textareaRef.current) resizeComposerTextarea(textareaRef.current);
  }, [draft]);
  useEffect(() => { setCommandInserted(false); }, [activeLessonId, activeBlockId]);
  const submitText = async (text: string) => {
    const trimmed = text.trim();
    if (inputDisabled || pending || !trimmed) return;
    setDraft("");
    setPending(true);
    try {
      await onSend(trimmed);
    } catch (error) {
      setDraft(text);
      throw error;
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
  const messageEntryRef = (recordId: string) => (el: HTMLElement | null) => {
    if (el) messageEntryRefs.current.set(recordId, el);
    else messageEntryRefs.current.delete(recordId);
  };
  const renderConversationRecord = (record: TimelineThreadRecord) => {
    if (!isMessageRecord(record)) return null;
    const className = record.role === "user" ? "timeline-message learner" : `timeline-message tutor${record.presentation === "review" ? " review" : ""}`;
    return <article key={record.id} id={timelineMessageElementId(record.id)} ref={messageEntryRef(record.id)} className={className}><b>{record.role === "user" ? "You" : record.presentation === "review" ? "Tutor review" : "Tutor"}</b>{record.role === "user" ? <p>{record.text}</p> : <Markdown source={record.source === "authored" && record.presentation === "course" ? "authored" : "generated"}>{record.text}</Markdown>}</article>;
  };
  const reflectionReviewingNode = activeReflectionReviewing ? <aside className="timeline-message tutor thinking" role="status" aria-live="polite" aria-label="Tutor is thinking"><b>Tutor</b><span className="tutor-thinking-dots" aria-hidden="true"><span className="tutor-thinking-dot" /><span className="tutor-thinking-dot" /><span className="tutor-thinking-dot" /></span><span className="tutor-thinking-label">Thinking</span></aside> : null;
  const renderedRecords = (() => {
    const nodes: React.ReactNode[] = [];
    let renderedActiveBlock = false;
    let renderedPracticeSurface = false;
    const renderedPracticeHistoryBlocks = new Set<string>();
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      if (!record || !isMessageRecord(record)) continue;
      if (isAuthoredCourseRecord(record)) {
        // A ready successor is authored as soon as this block's work is accepted, while this
        // block remains active until the learner continues. Later conversation still belongs to
        // this block, so collect it by its lifecycle identity rather than by the next course row.
        const following = records.filter((candidate) => isMessageRecord(candidate) && !isAuthoredCourseRecord(candidate) && belongsToAuthoredBlock(candidate, record));
        const active = recordMatchesActive(record);
        const transitionClass = record.blockId.startsWith("part--") || record.lessonId.startsWith("workbook:part:") && record.blockId === "__part__"
          ? " timeline-part-transition"
          : "";
        const canInsertCommand = Boolean(onDoItForMe && record.id === activeAuthoredRecordId);
        const lastMessage = following.at(-1) ?? record;
        if (active) renderedActiveBlock = true;
        const placesPracticeSurface = !renderedPracticeSurface && record.blockId === practiceSurfaceBlockId;
        if (placesPracticeSurface) renderedPracticeSurface = true;
        const practiceHistoryKey = `${record.lessonId}\u0000${record.blockId}`;
        const practiceHistory = renderedPracticeHistoryBlocks.has(practiceHistoryKey) ? null : renderPracticeHistory?.(record);
        if (practiceHistory) renderedPracticeHistoryBlocks.add(practiceHistoryKey);
        nodes.push(<section key={record.id} id={record.blockId} className={`work-block active-block-region${active ? " is-active" : ""}`} tabIndex={-1} data-active-block={active ? "true" : undefined}>
          <article className={`timeline-authored-content${transitionClass}`}><Markdown source="authored" lessonFrame={isLessonFrameRecord(record)}>{record.text}</Markdown></article>
          {practiceHistory}
          {placesPracticeSurface && practiceSurface}
          {canInsertCommand && <button className="button primary timeline-do-it" onClick={() => { onDoItForMe?.(); setCommandInserted(true); }}>{commandInserted ? "Inserted — press Enter" : "Do it for me"}</button>}
          {following.map(renderConversationRecord)}
          {active && reflectionReviewingNode}
          {renderContinuation?.(lastMessage)}
          {readyBlockIdSet.has(record.blockId) ? <div className="ready-successor-scroll-runway" aria-hidden="true" /> : null}
        </section>);
        continue;
      }
      const hasAuthoredBlock = records.some((candidate) => isAuthoredCourseRecord(candidate) && belongsToAuthoredBlock(record, candidate));
      if (!hasAuthoredBlock) nodes.push(renderConversationRecord(record));
    }
    if (!renderedActiveBlock) nodes.push(reflectionReviewingNode);
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
