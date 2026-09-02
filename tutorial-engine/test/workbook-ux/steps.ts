export type WorkbookUxTestSurface = 'setup' | 'editor' | 'terminal';

/**
 * Where the live practice band sits when a checkpoint is taken.
 *
 * - `inflow`: the band is in the flow of the page, part-way down the viewport, as it lands after
 *   Continue or when the learner has scrolled a little.
 * - `docked`: the learner has scrolled the band to the top, where it sticks while the conversation
 *   scrolls beneath it.
 * - `away`: the learner scrolled back up to reread something, and the band is below the fold.
 *
 * The band's geometry is the same in all three; what changes is what the page must not do when
 * feedback lands.
 */
export type WorkbookUxTestGeometryState = 'inflow' | 'docked' | 'away';

export interface WorkbookUxTestStepDeclaration {
  readonly id: number;
  readonly name: string;
  readonly surface: WorkbookUxTestSurface;
  readonly requestedState?: WorkbookUxTestGeometryState;
  readonly kind: 'setup' | 'scroll' | 'feedback' | 'acceptance';
  readonly requiredMotion: boolean;
}

export const WORKBOOK_UX_TEST_STEPS = {
  initial: { id: 1, name: 'initial settled marker', surface: 'setup', kind: 'setup', requiredMotion: false },
  revealEditor: { id: 2, name: 'reveal editor through structural Continue controls', surface: 'setup', kind: 'scroll', requiredMotion: false },
  editorInflowFeedback: { id: 11, name: 'editor feedback arrives with the band in flow; page holds still', surface: 'editor', requestedState: 'inflow', kind: 'feedback', requiredMotion: false },
  editorDockedFeedback: { id: 12, name: 'editor feedback arrives with the band docked; page holds still', surface: 'editor', requestedState: 'docked', kind: 'feedback', requiredMotion: false },
  editorAwayFeedback: { id: 13, name: 'editor feedback arrives with the band below the fold; page holds still', surface: 'editor', requestedState: 'away', kind: 'feedback', requiredMotion: false },
  editorAccepted: { id: 14, name: 'editor accepted draft unlocks terminal', surface: 'editor', kind: 'acceptance', requiredMotion: false },
  terminalInflowFeedback: { id: 21, name: 'terminal feedback arrives with the band in flow; page holds still', surface: 'terminal', requestedState: 'inflow', kind: 'feedback', requiredMotion: false },
  terminalDockedFeedback: { id: 22, name: 'terminal feedback arrives with the band docked; page holds still', surface: 'terminal', requestedState: 'docked', kind: 'feedback', requiredMotion: false },
  terminalAwayFeedback: { id: 23, name: 'terminal feedback arrives with the band below the fold; page holds still', surface: 'terminal', requestedState: 'away', kind: 'feedback', requiredMotion: false },
  editorScrollToInflow: { id: 31, name: 'editor reveal: Continue lands the band in view, then it is placed in flow', surface: 'editor', requestedState: 'inflow', kind: 'scroll', requiredMotion: false },
  editorScrollToDocked: { id: 32, name: 'editor scroll back from below the fold to the docked band', surface: 'editor', requestedState: 'docked', kind: 'scroll', requiredMotion: true },
  editorScrollAway: { id: 33, name: 'editor revision typed in flow, then scrolled below the fold', surface: 'editor', requestedState: 'away', kind: 'scroll', requiredMotion: true },
  terminalScrollToInflow: { id: 34, name: 'terminal reveal: Continue lands the band in view, then it is placed in flow', surface: 'terminal', requestedState: 'inflow', kind: 'scroll', requiredMotion: false },
  terminalScrollToDocked: { id: 35, name: 'terminal scroll back from below the fold to the docked band', surface: 'terminal', requestedState: 'docked', kind: 'scroll', requiredMotion: true },
  terminalScrollAway: { id: 36, name: 'terminal command submitted in flow, then scrolled below the fold', surface: 'terminal', requestedState: 'away', kind: 'scroll', requiredMotion: true },
} as const satisfies Record<string, WorkbookUxTestStepDeclaration>;

export type WorkbookUxTestStepKey = keyof typeof WORKBOOK_UX_TEST_STEPS;

export const WORKBOOK_UX_TEST_STEP_LIST: readonly WorkbookUxTestStepDeclaration[] = Object.values(WORKBOOK_UX_TEST_STEPS);

export const REQUIRED_MOTION_STEP_IDS = WORKBOOK_UX_TEST_STEP_LIST
  .filter((step) => step.requiredMotion)
  .map((step) => step.id);

export const REQUIRED_STATE_CHECKPOINT_STEP_IDS = [
  WORKBOOK_UX_TEST_STEPS.editorInflowFeedback.id,
  WORKBOOK_UX_TEST_STEPS.editorDockedFeedback.id,
  WORKBOOK_UX_TEST_STEPS.editorAwayFeedback.id,
  WORKBOOK_UX_TEST_STEPS.terminalInflowFeedback.id,
  WORKBOOK_UX_TEST_STEPS.terminalDockedFeedback.id,
  WORKBOOK_UX_TEST_STEPS.terminalAwayFeedback.id,
] as const;

export const SCROLL_CHECKPOINT_STEP_IDS = [
  WORKBOOK_UX_TEST_STEPS.editorScrollToInflow.id,
  WORKBOOK_UX_TEST_STEPS.editorScrollToDocked.id,
  WORKBOOK_UX_TEST_STEPS.editorScrollAway.id,
  WORKBOOK_UX_TEST_STEPS.terminalScrollToInflow.id,
  WORKBOOK_UX_TEST_STEPS.terminalScrollToDocked.id,
  WORKBOOK_UX_TEST_STEPS.terminalScrollAway.id,
] as const;
