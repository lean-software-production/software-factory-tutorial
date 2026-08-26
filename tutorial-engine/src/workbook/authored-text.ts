/**
 * Formats the Markdown that the workbook presents as authored course material.
 *
 * These helpers deliberately depend only on the small text shapes they format,
 * so both the workbook renderer and Pi-history reconstruction use one source
 * of truth without depending on either subsystem.
 */

export type AuthoredIntroduction = { title: string; markdown: string };
export type AuthoredPartPreamble = { title: string; markdown?: string };
export type AuthoredLessonFrame = {
  title?: string;
  dek: string;
  introduction: string;
  outcomes: readonly string[];
};
export type AuthoredDeclaredBlock = { title: string; markdown: string };

export function formatHeadingText(level: 1 | 2, title: string, markdown: string): string {
  return `#`.repeat(level) + ` ${title}\n\n${markdown}`;
}

export function formatWorkbookIntroductionText(introduction: AuthoredIntroduction): string {
  return formatHeadingText(1, introduction.title, introduction.markdown);
}

/**
 * Preserve the supplied body while using its trimmed form only to decide
 * whether a preamble has content. The loaded workbook has already trimmed
 * authored files, but this keeps the stream formatter's public behaviour.
 */
export function formatPartPreambleText(part: AuthoredPartPreamble): string {
  return part.markdown?.trim() ? formatHeadingText(1, part.title, part.markdown) : `# ${part.title}`;
}

export function formatLessonFrameBody(lesson: Omit<AuthoredLessonFrame, "title">): string {
  return [
    lesson.dek,
    "## What you will learn",
    lesson.outcomes.map((outcome) => `- ${outcome}`).join("\n"),
    lesson.introduction.trim(),
  ].filter((section) => section.trim().length > 0).join("\n\n");
}

export function formatLessonFrameText(lesson: AuthoredLessonFrame): string {
  const body = formatLessonFrameBody(lesson);
  return lesson.title === undefined ? body : formatHeadingText(1, lesson.title, body);
}

export function formatDeclaredBlockText(block: AuthoredDeclaredBlock): string {
  return formatHeadingText(2, block.title, block.markdown);
}
