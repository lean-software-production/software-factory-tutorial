import type { LoadedWorkbook, WorkbookChapter } from "./load.js";
import type { WorkbookBlock, WorkbookBlockType, WorkbookLesson } from "./contract.js";

export type BlockId = string;
export type AnchorId = string;

export type StructuralBlockKind = "workbook-introduction" | "part-preamble" | "lesson-preamble";
export type DeclaredBlockKind = WorkbookBlockType;

export type StructuralWorkbookBlock = {
  origin: "structural";
  kind: StructuralBlockKind;
  id: BlockId;
  anchorId: AnchorId;
  title: string;
  markdown: string;
  lessonId: string;
  partId?: string;
  chapter?: WorkbookChapter;
};

export type DeclaredWorkbookBlock = {
  origin: "declared";
  kind: DeclaredBlockKind;
  id: BlockId;
  anchorId: AnchorId;
  lessonId: string;
  declaredId: string;
  title: string;
  markdown: string;
  block: WorkbookBlock;
  chapter: WorkbookChapter;
};

export type OrderedWorkbookBlock = StructuralWorkbookBlock | DeclaredWorkbookBlock;

export const WORKBOOK_INTRODUCTION_BLOCK_ID = "workbook--introduction";
export const WORKBOOK_COMPLETE_ANCHOR_ID = "workbook--complete";

const SOURCE_COMPONENT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function assertSourceComponent(component: string, label: string): void {
  if (!SOURCE_COMPONENT.test(component) || component.includes("--")) throw new Error(`${label} "${component}" must be lowercase kebab case and must not contain --.`);
}

export function partBlockId(partId: string): BlockId {
  assertSourceComponent(partId, "Part id");
  return `part--${partId}`;
}

export function lessonPreambleBlockId(lessonId: string): BlockId {
  assertSourceComponent(lessonId, "Lesson id");
  return `lesson--${lessonId}`;
}

export function declaredBlockId(lessonId: string, blockId: string): BlockId {
  assertSourceComponent(lessonId, "Lesson id");
  assertSourceComponent(blockId, "Block id");
  return `lesson--${lessonId}--${blockId}`;
}

export function anchorForBlock(blockId: BlockId): AnchorId { return blockId; }
export function fragmentForAnchor(anchorId: AnchorId): `#${string}` { return `#${anchorId}`; }
export function domIdForAnchor(anchorId: AnchorId): string { return anchorId; }

export function declaredSourceFromBlockId(blockId: string): { lessonId: string; declaredId: string } | undefined {
  const match = /^lesson--(.+)--([^]+)$/.exec(blockId);
  if (!match) return undefined;
  const lessonId = match[1]!;
  const declaredId = match[2]!;
  if (!SOURCE_COMPONENT.test(lessonId) || !SOURCE_COMPONENT.test(declaredId)) return undefined;
  return { lessonId, declaredId };
}

export function structuralLessonId(block: Pick<OrderedWorkbookBlock, "id" | "origin">): string {
  return block.id;
}

function lessonFrameMarkdown(lesson: Pick<WorkbookLesson, "dek" | "outcomes">): string {
  return [lesson.dek, "## What you will learn", lesson.outcomes.map((outcome) => `- ${outcome}`).join("\n")].join("\n\n");
}

export function buildWorkbookBlockStream(loaded: LoadedWorkbook): OrderedWorkbookBlock[] {
  const stream: OrderedWorkbookBlock[] = [{
    origin: "structural",
    kind: "workbook-introduction",
    id: WORKBOOK_INTRODUCTION_BLOCK_ID,
    anchorId: WORKBOOK_INTRODUCTION_BLOCK_ID,
    title: loaded.identity.title,
    markdown: loaded.introduction,
    lessonId: WORKBOOK_INTRODUCTION_BLOCK_ID,
  }];

  const emittedParts = new Set<string>();
  for (const chapter of loaded.chapters) {
    if (chapter.partId && chapter.part && !emittedParts.has(chapter.partId)) {
      emittedParts.add(chapter.partId);
      const id = partBlockId(chapter.partId);
      stream.push({
        origin: "structural",
        kind: "part-preamble",
        id,
        anchorId: id,
        title: chapter.part,
        markdown: chapter.partMarkdown ?? "",
        lessonId: id,
        partId: chapter.partId,
        chapter,
      });
    }

    const lessonId = lessonPreambleBlockId(chapter.lesson.id);
    stream.push({
      origin: "structural",
      kind: "lesson-preamble",
      id: lessonId,
      anchorId: lessonId,
      title: chapter.lesson.title,
      markdown: lessonFrameMarkdown(chapter.lesson),
      lessonId,
      chapter,
    });

    for (const block of chapter.lesson.blocks) {
      const id = declaredBlockId(chapter.lesson.id, block.id);
      stream.push({
        origin: "declared",
        kind: block.type,
        id,
        anchorId: id,
        lessonId: chapter.lesson.id,
        declaredId: block.id,
        title: block.title,
        markdown: block.markdown,
        block,
        chapter,
      });
    }
  }
  return stream;
}

export function blockText(block: OrderedWorkbookBlock, workbookTitle?: string): string {
  if (block.origin === "declared") return `## ${block.title}\n\n${block.markdown}`;
  if (block.kind === "workbook-introduction") return `# ${workbookTitle ?? block.title}\n\n${block.markdown}`;
  if (block.kind === "part-preamble") return block.markdown.trim() ? `# ${block.title}\n\n${block.markdown}` : `# ${block.title}`;
  return `# ${block.title}\n\n${block.markdown}`;
}

export function successorAnchor(stream: readonly OrderedWorkbookBlock[], completedBlockId: BlockId): AnchorId {
  const index = stream.findIndex((block) => block.id === completedBlockId);
  const successor = index >= 0 ? stream[index + 1] : undefined;
  return successor?.anchorId ?? WORKBOOK_COMPLETE_ANCHOR_ID;
}
