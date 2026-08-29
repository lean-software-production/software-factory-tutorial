export type WorkbookFactorySurface = 'setup' | 'editor' | 'terminal';
export type WorkbookFactoryGeometryState = 'small' | 'mid' | 'full';

export interface WorkbookFactoryStepDeclaration {
  readonly id: number;
  readonly name: string;
  readonly surface: WorkbookFactorySurface;
  readonly requestedState?: WorkbookFactoryGeometryState;
  readonly kind: 'setup' | 'scroll' | 'feedback' | 'acceptance';
  readonly requiredMotion: boolean;
}

export const WORKBOOK_FACTORY_STEPS = {
  initial: { id: 1, name: 'initial settled marker', surface: 'setup', kind: 'setup', requiredMotion: false },
  revealEditor: { id: 2, name: 'reveal editor through structural Continue controls', surface: 'setup', kind: 'scroll', requiredMotion: false },
  editorSmallFeedback: { id: 11, name: 'editor small feedback arrives and settles', surface: 'editor', requestedState: 'small', kind: 'feedback', requiredMotion: false },
  editorMidFeedback: { id: 12, name: 'editor mid-scroll feedback arrives and settles', surface: 'editor', requestedState: 'mid', kind: 'feedback', requiredMotion: false },
  editorFullFeedback: { id: 13, name: 'editor full-width feedback arrives and settles', surface: 'editor', requestedState: 'full', kind: 'feedback', requiredMotion: false },
  editorAccepted: { id: 14, name: 'editor accepted draft unlocks terminal', surface: 'editor', kind: 'acceptance', requiredMotion: false },
  terminalSmallFeedback: { id: 21, name: 'terminal small Practice Coach feedback arrives and settles', surface: 'terminal', requestedState: 'small', kind: 'feedback', requiredMotion: false },
  terminalMidFeedback: { id: 22, name: 'terminal mid-scroll Practice Coach feedback arrives and settles', surface: 'terminal', requestedState: 'mid', kind: 'feedback', requiredMotion: false },
  terminalFullFeedback: { id: 23, name: 'terminal full-width Practice Coach feedback arrives and settles', surface: 'terminal', requestedState: 'full', kind: 'feedback', requiredMotion: false },
  editorScrollToSmall: { id: 31, name: 'editor reveal scroll to small activity band', surface: 'editor', requestedState: 'small', kind: 'scroll', requiredMotion: false },
  editorScrollToMid: { id: 32, name: 'editor scroll from small to mid activity band', surface: 'editor', requestedState: 'mid', kind: 'scroll', requiredMotion: true },
  editorScrollToFull: { id: 33, name: 'editor scroll from mid to full-width activity band', surface: 'editor', requestedState: 'full', kind: 'scroll', requiredMotion: true },
  terminalScrollToSmall: { id: 34, name: 'terminal reveal scroll to small activity band', surface: 'terminal', requestedState: 'small', kind: 'scroll', requiredMotion: false },
  terminalScrollToMid: { id: 35, name: 'terminal scroll from small to mid activity band', surface: 'terminal', requestedState: 'mid', kind: 'scroll', requiredMotion: true },
  terminalScrollToFull: { id: 36, name: 'terminal scroll from mid to full-width activity band', surface: 'terminal', requestedState: 'full', kind: 'scroll', requiredMotion: true },
} as const satisfies Record<string, WorkbookFactoryStepDeclaration>;

export type WorkbookFactoryStepKey = keyof typeof WORKBOOK_FACTORY_STEPS;

export const WORKBOOK_FACTORY_STEP_LIST: readonly WorkbookFactoryStepDeclaration[] = Object.values(WORKBOOK_FACTORY_STEPS);

export const REQUIRED_MOTION_STEP_IDS = WORKBOOK_FACTORY_STEP_LIST
  .filter((step) => step.requiredMotion)
  .map((step) => step.id);

export const REQUIRED_STATE_CHECKPOINT_STEP_IDS = [
  WORKBOOK_FACTORY_STEPS.editorSmallFeedback.id,
  WORKBOOK_FACTORY_STEPS.editorMidFeedback.id,
  WORKBOOK_FACTORY_STEPS.editorFullFeedback.id,
  WORKBOOK_FACTORY_STEPS.terminalSmallFeedback.id,
  WORKBOOK_FACTORY_STEPS.terminalMidFeedback.id,
  WORKBOOK_FACTORY_STEPS.terminalFullFeedback.id,
] as const;

export const SCROLL_CHECKPOINT_STEP_IDS = [
  WORKBOOK_FACTORY_STEPS.editorScrollToSmall.id,
  WORKBOOK_FACTORY_STEPS.editorScrollToMid.id,
  WORKBOOK_FACTORY_STEPS.editorScrollToFull.id,
  WORKBOOK_FACTORY_STEPS.terminalScrollToSmall.id,
  WORKBOOK_FACTORY_STEPS.terminalScrollToMid.id,
  WORKBOOK_FACTORY_STEPS.terminalScrollToFull.id,
] as const;
