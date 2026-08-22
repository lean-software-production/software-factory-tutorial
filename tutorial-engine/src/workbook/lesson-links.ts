/**
 * Canonical workbook lesson references let one authored document link to an
 * earlier lesson by its stable flat directory id — `[[lesson:<flat-id>]]`
 * — rather than a hand-written title or anchor that can drift out of date.
 * `loadWorkbook()` resolves every token to standard Markdown only after it has
 * discovered and globally numbered every chapter; this module owns the DOM
 * anchor algorithm, the reference catalog, and the earlier-lesson-only policy,
 * so the resolved hrefs and the UI's rendered lesson ids can never drift apart.
 */

/** Sanitize any string into the subset of characters valid in an HTML id/anchor. */
function domSafe(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]+/g, "-");
}

/** The DOM id a lesson's chapter article is rendered with. */
export function lessonElementId(lessonId: string): string {
  return `lesson-${domSafe(lessonId)}`;
}

/** The in-page anchor href that navigates to a lesson's chapter article. */
export function lessonAnchorHref(lessonId: string): string {
  return `#${lessonElementId(lessonId)}`;
}

/** One resolvable reference target: a lesson's canonical id, its current global number, and its title. */
export interface LessonReferenceTarget {
  id: string;
  lessonNumber: number;
  title: string;
}

/** The full set of lessons a reference may resolve against, keyed by canonical chapter id. */
export type LessonCatalog = ReadonlyMap<string, LessonReferenceTarget>;

/** Build the reference catalog from every loaded chapter, keyed by its canonical id. */
export function buildLessonCatalog(chapters: readonly LessonReferenceTarget[]): LessonCatalog {
  const catalog = new Map<string, LessonReferenceTarget>();
  for (const chapter of chapters) catalog.set(chapter.id, chapter);
  return catalog;
}

/**
 * Where a reference is being resolved from, and the policy that applies there:
 * `workbook.md` may not reference any lesson; a part's `part.md` may only
 * reference a lesson before that part's first lesson; a lesson's dek or block
 * may only reference a strictly earlier lesson than itself.
 */
export type ReferenceContext =
  | { kind: "workbook"; path: string }
  | { kind: "part"; path: string; firstLessonNumber: number }
  | { kind: "lesson"; path: string; lessonId: string; lessonNumber: number };

const OPEN_TOKEN = "[[lesson:";
const CLOSE_TOKEN = "]]";
const CANONICAL_SYNTAX = "[[lesson:<flat-id>]]";
const CANONICAL_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function withSyntaxHint(message: string): string {
  return `${message} Use the canonical syntax ${CANONICAL_SYNTAX}.`;
}

/** Escape the characters that would otherwise break the Markdown link label we generate. */
function escapeMarkdownLinkLabel(label: string): string {
  return label.replace(/[\\[\]]/g, (char) => `\\${char}`);
}

/**
 * Scan `markdown` for `[[lesson:...]]` reference tokens and resolve each one to a
 * standard Markdown link, `[Lesson N: Title](#anchor)`, using `catalog` and the
 * earlier-lesson policy encoded by `context`. Throws a source-location error naming
 * `context.path` and the canonical syntax for any malformed, unknown, or
 * policy-violating token; text with no tokens is returned unchanged.
 */
export function resolveLessonReferences(markdown: string, catalog: LessonCatalog, context: ReferenceContext): string {
  let result = "";
  let cursor = 0;
  while (true) {
    const openIndex = markdown.indexOf(OPEN_TOKEN, cursor);
    if (openIndex === -1) {
      result += markdown.slice(cursor);
      break;
    }
    result += markdown.slice(cursor, openIndex);

    const bodyStart = openIndex + OPEN_TOKEN.length;
    const closeIndex = markdown.indexOf(CLOSE_TOKEN, bodyStart);
    if (closeIndex === -1) {
      const tail = markdown.slice(bodyStart).trim();
      throw new Error(withSyntaxHint(
        `${context.path}: unterminated lesson reference "${OPEN_TOKEN}${tail}" is missing its closing "]]".`,
      ));
    }

    const raw = markdown.slice(bodyStart, closeIndex);
    const id = raw.trim();
    const token = `${OPEN_TOKEN}${raw}${CLOSE_TOKEN}`;

    if (!id) throw new Error(withSyntaxHint(`${context.path}: empty lesson reference "${token}".`));
    if (!CANONICAL_ID_PATTERN.test(id)) {
      throw new Error(withSyntaxHint(`${context.path}: malformed lesson reference "${token}".`));
    }

    const target = catalog.get(id);
    if (!target) {
      throw new Error(withSyntaxHint(
        `${context.path}: unknown lesson reference "${token}"; no lesson with canonical id "${id}" exists.`,
      ));
    }

    if (context.kind === "workbook") {
      throw new Error(withSyntaxHint(`${context.path}: workbook.md may not contain a lesson reference; found "${token}".`));
    } else if (context.kind === "part") {
      if (!(target.lessonNumber < context.firstLessonNumber)) {
        throw new Error(withSyntaxHint(
          `${context.path}: lesson reference "${token}" must name a lesson before this part's first lesson (lesson ${context.firstLessonNumber}).`,
        ));
      }
    } else {
      if (target.id === context.lessonId) {
        throw new Error(withSyntaxHint(
          `${context.path}: lesson reference "${token}" refers to its own lesson; a lesson may only reference a strictly earlier lesson.`,
        ));
      }
      if (!(target.lessonNumber < context.lessonNumber)) {
        throw new Error(withSyntaxHint(
          `${context.path}: lesson reference "${token}" refers to a later lesson; a lesson may only reference a strictly earlier lesson.`,
        ));
      }
    }

    result += `[Lesson ${target.lessonNumber}: ${escapeMarkdownLinkLabel(target.title)}](${lessonAnchorHref(target.id)})`;
    cursor = closeIndex + CLOSE_TOKEN.length;
  }
  return result;
}
