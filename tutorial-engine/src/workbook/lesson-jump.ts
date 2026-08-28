import { loadWorkbook, type LoadedWorkbook } from "./load.js";
import { WorkbookTimeline } from "./timeline.js";
import { buildWorkbookBlockStream, lessonPreambleBlockId } from "./workbook-blocks.js";

export class LessonJumpError extends Error {}

export interface LessonJumpTarget { lessonId: string; preambleBlockId: string; }

/** Resolve either an authored lesson id or its numeric prefix (for example, 007). */
export function resolveLessonJump(loaded: LoadedWorkbook, selector: string): LessonJumpTarget {
  const exact = loaded.chapters.filter((chapter) => chapter.lesson.id === selector);
  const numeric = /^\d+$/.test(selector)
    ? loaded.chapters.filter((chapter) => {
      const prefix = /^(\d+)(?:-|$)/.exec(chapter.lesson.id)?.[1];
      return prefix !== undefined && Number(prefix) === Number(selector);
    })
    : [];
  const matches = exact.length ? exact : numeric;
  if (matches.length === 0) throw new LessonJumpError(`No lesson matches '${selector}'.`);
  if (matches.length > 1) throw new LessonJumpError(`Lesson selector '${selector}' is ambiguous: ${matches.map((chapter) => chapter.lesson.id).join(", ")}.`);
  const lessonId = matches[0]!.lesson.id;
  return { lessonId, preambleBlockId: lessonPreambleBlockId(lessonId) };
}

/**
 * Make a fresh session a deliberately test-only view of one lesson. Previous blocks are compact
 * completion records, not replayed authored messages, so they cannot fill the tutor's history.
 */
export async function initializeLessonJump(sessionRoot: string, loaded: LoadedWorkbook, target: LessonJumpTarget): Promise<void> {
  const timeline = new WorkbookTimeline({ stateRoot: sessionRoot });
  if ((await timeline.read()).length > 0) throw new LessonJumpError("A lesson jump can only initialize a fresh session.");
  const stream = buildWorkbookBlockStream(loaded);
  const targetIndex = stream.findIndex((block) => block.id === target.preambleBlockId);
  if (targetIndex < 0) throw new LessonJumpError(`Lesson '${target.lessonId}' has no preamble block.`);
  await timeline.run(async () => {
    await timeline.appendWithinRun({ type: "lesson_jump_started", lessonId: target.lessonId, selector: target.lessonId, testOnly: true });
    for (const block of stream.slice(0, targetIndex)) {
      await timeline.appendWithinRun({ type: "block_skipped", lessonId: block.lessonId, blockId: block.id, reason: "lesson-jump-prerequisite" });
    }
  });
}

export async function loadAndResolveLessonJump(contentRoot: string, selector: string): Promise<{ loaded: LoadedWorkbook; target: LessonJumpTarget }> {
  const loaded = await loadWorkbook(contentRoot);
  return { loaded, target: resolveLessonJump(loaded, selector) };
}
