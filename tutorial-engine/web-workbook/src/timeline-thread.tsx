import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Markdown } from "./markdown.js";
import type { PublicTimelineMessage, PublicTimelineRecord } from "../../src/workbook/public-contract.js";

export type { PublicTimelineRecord };
type TimelineMessageRecord = PublicTimelineMessage;
type TimelineThreadRecord = PublicTimelineRecord;

const composerMaxHeightPx = 160;
const defaultTutorReplyScrollGapPx = 14;

export type TutorReplyRevealGeometry = {
  replyTop: number;
  replyBottom: number;
  viewportHeight: number;
  composerTop?: number | null;
  safeTop?: number;
  gapPx?: number;
};

export function computeTutorReplyRevealScrollDelta({ replyTop, replyBottom, viewportHeight, composerTop, safeTop = 0, gapPx = defaultTutorReplyScrollGapPx }: TutorReplyRevealGeometry): number {
  const safeBottom = Math.max(safeTop, Math.min(viewportHeight, composerTop ?? viewportHeight) - gapPx);
  const replyHeight = Math.max(0, replyBottom - replyTop);
  const safeHeight = Math.max(0, safeBottom - safeTop);
  if (replyTop >= safeTop && replyBottom <= safeBottom) return 0;
  if (replyHeight <= safeHeight && replyTop < safeTop) return replyTop - safeTop;
  if (replyBottom > safeBottom) return replyBottom - safeBottom;
  if (replyTop < safeTop) return replyTop - safeTop;
  return 0;
}

function parseCssPixelValue(value: string, fallback: number): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function revealTutorReplyIfNeeded(replyElement: HTMLElement, composerDock: HTMLElement | null): number {
  const replyRect = replyElement.getBoundingClientRect();
  const composerRect = composerDock?.getBoundingClientRect();
  const style = replyElement.ownerDocument.defaultView?.getComputedStyle?.(replyElement);
  const gapPx = parseCssPixelValue(style?.getPropertyValue("--timeline-reply-scroll-gap") ?? "", defaultTutorReplyScrollGapPx);
  const delta = computeTutorReplyRevealScrollDelta({
    replyTop: replyRect.top,
    replyBottom: replyRect.bottom,
    viewportHeight: window.innerHeight,
    composerTop: composerRect?.top,
    gapPx,
  });
  if (Math.abs(delta) < 0.5) return 0;
  const scrollRoot = document.scrollingElement ?? document.documentElement;
  const maxScrollY = Math.max(0, scrollRoot.scrollHeight - window.innerHeight);
  const nextScrollY = Math.max(0, Math.min(maxScrollY, window.scrollY + delta));
  const clampedDelta = nextScrollY - window.scrollY;
  if (Math.abs(clampedDelta) < 0.5) return 0;
  window.scrollTo({ top: nextScrollY, left: window.scrollX, behavior: "instant" });
  return clampedDelta;
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

export function TimelineThread({ records, activeLessonId, activeBlockId, onSend, onDoItForMe, renderContinuation, renderTerminalHistory, practiceSurface, practiceSurfaceBlockId, completionPanel, readyBlockIds = [], inputDisabled = false, activeReflectionReviewing = false }: {
  records: readonly TimelineThreadRecord[];
  activeLessonId: string;
  activeBlockId: string;
  onSend(text: string): Promise<void>;
  onDoItForMe?(): void;
  renderContinuation?(record: TimelineMessageRecord): React.ReactNode;
  /** A durable, static terminal transcript directly below its own authored record. */
  renderTerminalHistory?(record: TimelineMessageRecord): React.ReactNode;
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
  const composerDockRef = useRef<HTMLDivElement | null>(null);
  const responseEntryRefs = useRef(new Map<string, HTMLElement>());
  const knownResponseIds = useRef<Set<string> | null>(null);
  const recordMatchesActive = (record: { lessonId: string; blockId: string }) => record.blockId === activeBlockId && (record.lessonId === activeLessonId || activeBlockId.includes("--"));
  const activeAuthoredRecordId = [...records].reverse().find((record) => isAuthoredCourseRecord(record) && recordMatchesActive(record))?.id;
  const readyBlockIdSet = new Set(readyBlockIds);
  const responseRecords = records.filter((record) => isMessageRecord(record) && record.role === "assistant" && !isAuthoredCourseRecord(record));
  const latestResponseId = responseRecords.at(-1)?.id;
  const responseIdsKey = responseRecords.map((record) => record.id).join("\u0000");
  // `records` is a new array every render, so the set below is memoised on the ids it contains
  // rather than on the array's identity. That lets the effect depend on exactly what it reads:
  // previously it read responseRecords while depending on a key derived from it, which was correct
  // but only provably so to a reader.
  const responseIdSet = useMemo(() => new Set(responseIdsKey ? responseIdsKey.split("\u0000") : []), [responseIdsKey]);
  useLayoutEffect(() => {
    if (knownResponseIds.current === null) {
      knownResponseIds.current = responseIdSet;
      return;
    }
    const shouldScroll = latestResponseId !== undefined && !knownResponseIds.current.has(latestResponseId);
    knownResponseIds.current = responseIdSet;
    if (!shouldScroll) return;
    const latestResponseElement = responseEntryRefs.current.get(latestResponseId);
    if (latestResponseElement) revealTutorReplyIfNeeded(latestResponseElement, composerDockRef.current);
  }, [latestResponseId, responseIdSet]);
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
  const responseEntryRef = (recordId: string) => (el: HTMLElement | null) => {
    if (el) responseEntryRefs.current.set(recordId, el);
    else responseEntryRefs.current.delete(recordId);
  };
  const renderConversationRecord = (record: TimelineThreadRecord) => {
    if (!isMessageRecord(record)) return null;
    const className = record.role === "user" ? "timeline-message learner" : `timeline-message tutor${record.presentation === "review" ? " review" : ""}`;
    const trackResponse = record.role === "assistant" && !(record.source === "authored" && record.presentation === "course");
    return <article key={record.id} ref={trackResponse ? responseEntryRef(record.id) : undefined} className={className}><b>{record.role === "user" ? "You" : record.presentation === "review" ? "Tutor review" : "Tutor"}</b>{record.role === "user" ? <p>{record.text}</p> : <Markdown source={record.source === "authored" && record.presentation === "course" ? "authored" : "generated"}>{record.text}</Markdown>}</article>;
  };
  const reflectionReviewingNode = activeReflectionReviewing ? <aside className="timeline-message tutor thinking" role="status" aria-live="polite" aria-label="Tutor is thinking"><b>Tutor</b><span className="tutor-thinking-dots" aria-hidden="true"><span className="tutor-thinking-dot" /><span className="tutor-thinking-dot" /><span className="tutor-thinking-dot" /></span><span className="tutor-thinking-label">Thinking</span></aside> : null;
  const renderedRecords = (() => {
    const nodes: React.ReactNode[] = [];
    let renderedActiveBlock = false;
    let renderedPracticeSurface = false;
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
        nodes.push(<section key={record.id} id={record.blockId} className={`work-block active-block-region${active ? " is-active" : ""}`} tabIndex={-1} data-active-block={active ? "true" : undefined}>
          <article className={`timeline-authored-content${transitionClass}`}><Markdown source="authored" lessonFrame={isLessonFrameRecord(record)}>{record.text}</Markdown></article>
          {renderTerminalHistory?.(record)}
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
    <div ref={composerDockRef} className="timeline-composer-dock fixed-composer">
      <form className="timeline-input fixed-composer" onSubmit={send}>
        <textarea ref={textareaRef} className="timeline-composer-textarea" name="message" rows={1} aria-label="Message the tutor" value={draft} onInput={(event) => setDraft(event.currentTarget.value)} onChange={(event) => setDraft(event.target.value)} onKeyDown={handleComposerKeyDown} disabled={inputDisabled || pending} />
        <button className="round-send" aria-label="Send message" title="Send message" disabled={inputDisabled || pending || !draft.trim()}>{pending ? "…" : "↑"}</button>
      </form>
    </div>
  </section>;
}
