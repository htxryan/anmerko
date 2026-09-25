import type { ElementContext, Note } from './core';
import type { JourneyClient } from './journey-ui';
import type { ComponentContextV1 } from './component-context';

export type StoreChanges = Record<string, { newValue?: unknown }>;

export interface Store {
  read(key: string): Promise<unknown>;
  readAll(): Promise<Record<string, unknown>>;
  write(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
  subscribe(listener: (changes: StoreChanges) => void): () => void;
}

export type DraftTargetIdentity = { viewToken: string; draftId: string; draftToken: string; targetToken: string; revision: number };
export type ComponentContextUpdate = DraftTargetIdentity & { value: ComponentContextV1 };
export type ViewState = {
  url: string;
  pageTitle?: string;
  draft: Note | null;
  scope: string;
  picking: boolean;
  settings: boolean;
  preambleDraft?: string | null;
  capturing?: boolean;
  composeOnPage?: boolean;
  viewToken?: string;
  draftToken?: string;
  targetToken?: string;
  revision?: number;
  componentContextUpdate?: ComponentContextUpdate;
};
export type PresentationMode = 'native' | 'overlay' | 'remote' | 'minimized' | 'closed';

export interface Controller {
  ready: Promise<void>;
  close(): boolean;
  dispose(): void;
  reveal(): void;
  viewState(): ViewState;
  applyState(state: ViewState): void;
  present(mode: PresentationMode, canDock: boolean, state?: ViewState, notifySidebar?: boolean): void;
  sidebarClosed(): void;
  startCapture(): Promise<void>;
  locate(note: Note, parent: boolean, identity?: DraftTargetIdentity): ElementContext | boolean | null;
  hierarchy(note: Note): string[] | null;
  status(text?: string, error?: boolean): void;
  connectionFailed(error?: unknown): void;
}

export interface Presentation {
  native: boolean;
  dockViaToolbar: boolean;
  sync(state: ViewState, remote: boolean): Promise<void>;
  changeLayout(mode: string, state: ViewState, mobile: boolean): Promise<void>;
  locate(note: Note, parent: boolean, identity?: DraftTargetIdentity): Promise<ElementContext | boolean | null>;
  hierarchy(note: Note): Promise<string[] | null>;
  startCapture(): Promise<void>;
  captureError(message: string): void;
  connect(controller: Controller, signal: AbortSignal): void;
}

export interface Runtime {
  store: Store;
  attachStyles(shadow: ShadowRoot, signal: AbortSignal): void | Promise<void>;
  capture?: () => Promise<string>;
  captureUnavailable?: string;
  captureComponentContext?: (element: Element, selectorPath: string[], signal: AbortSignal) => Promise<ComponentContextV1 | null>;
  storageError: string;
  settingsLabel: string;
  presentation?: Presentation;
  journeys?: JourneyClient;
  openJourney?: () => Promise<void>;
  // Whether a journey waits for review, so a page panel can offer it.
  journeyReviewPending?: () => Promise<boolean>;
  // Reports when this page records a journey, so a floating panel can step aside.
  watchJourneyRecording?: (listener: (recording: boolean) => void) => () => void;
  onDispose?: () => void;
}
