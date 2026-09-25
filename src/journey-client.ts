import { extensionApi } from './platform';
import type { JourneyDraftImage, JourneyDraftV1, JourneySession, JourneyUrlRedactionTarget } from './journey-core';
import { isJourneyBackgroundSender } from './journey-messaging';
import type { JourneyClient } from './journey-ui';

type JourneyOwner = { ownerTabId?: number; ownerWindowId?: number };
type JourneyResponse = { ok: true; value?: unknown } | { ok: false; code?: unknown; error?: unknown };

const CLIENT_ERROR = 'Could not update the journey. Try again.';
const LAUNCH_ERROR = 'Open anmerko from a website before starting a journey.';
const INTENT_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const BACKEND_GUIDANCE: Record<string, string> = {
  busy: 'Finish or discard the existing journey before starting another.',
  'owner-unavailable': 'Reopen anmerko from the original website and try again.',
  'initial-capture-failed': 'The initial journey screenshot failed. Try again.',
  'launch-expired': 'This launch expired. Reopen anmerko from the original website.',
  'session-storage-failed': 'Journey storage failed. Reset journey storage to continue. A previous draft or the latest action may be lost.',
  'stale-review': 'Another review tab changed this journey. Reload the review and try again.',
};

function validOwner(value: JourneyOwner | undefined): value is { ownerTabId: number; ownerWindowId: number } {
  return Number.isSafeInteger(value?.ownerTabId) && (value?.ownerTabId as number) >= 0
    && Number.isSafeInteger(value?.ownerWindowId) && (value?.ownerWindowId as number) >= 0;
}

function validIntent(value: string | undefined): value is string {
  return typeof value === 'string' && INTENT_PATTERN.test(value);
}

export function createJourneyClient(
  owner?: () => JourneyOwner,
  intent?: string,
): JourneyClient {
  const api = extensionApi();
  let actionGeneration = 0;

  async function command(type: string, extra: Record<string, unknown> = {}): Promise<unknown> {
    let response: JourneyResponse;
    try {
      response = await api.runtime.sendMessage({ type, ...extra }) as JourneyResponse;
    } catch {
      throw new Error(CLIENT_ERROR);
    }
    if (!response || response.ok !== true) {
      const code = response && typeof response.code === 'string' ? response.code : undefined;
      const guidance = code !== undefined && Object.hasOwn(BACKEND_GUIDANCE, code)
        ? BACKEND_GUIDANCE[code] : undefined;
      throw Object.assign(new Error(guidance ?? CLIENT_ERROR), code ? { code } : {});
    }
    return response.value;
  }

  return {
    supportsEnteredValues: true,
    read: async () => command('ANMERKO_JOURNEY_STATE') as Promise<JourneySession>,
    updateSummary: async (expected: string, actual: string): Promise<void> => {
      const current = await command('ANMERKO_JOURNEY_STATE') as JourneySession;
      if (current.phase !== 'reviewing') throw new Error(CLIENT_ERROR);
      await command('ANMERKO_JOURNEY_UPDATE_SUMMARY', {
        epoch: current.epoch, journeyId: current.journeyId, revision: current.draft.revision,
        updatedAt: new Date().toISOString(), expected, actual,
      });
    },
    removeStep: async (stepId: string): Promise<void> => {
      const current = await command('ANMERKO_JOURNEY_STATE') as JourneySession;
      if (current.phase !== 'reviewing') throw new Error(CLIENT_ERROR);
      await command('ANMERKO_JOURNEY_REMOVE_STEP', {
        epoch: current.epoch, journeyId: current.journeyId, revision: current.draft.revision,
        updatedAt: new Date().toISOString(), stepId,
      });
    },
    editValue: async (stepId: string, value: unknown): Promise<void> => {
      const current = await command('ANMERKO_JOURNEY_STATE') as JourneySession;
      if (current.phase !== 'reviewing') throw new Error(CLIENT_ERROR);
      await command('ANMERKO_JOURNEY_EDIT_VALUE', {
        epoch: current.epoch, journeyId: current.journeyId, revision: current.draft.revision,
        updatedAt: new Date().toISOString(), stepId, value,
      });
    },
    redactUrl: async (stepId: string, url: JourneyUrlRedactionTarget): Promise<void> => {
      const current = await command('ANMERKO_JOURNEY_STATE') as JourneySession;
      if (current.phase !== 'reviewing') throw new Error(CLIENT_ERROR);
      await command('ANMERKO_JOURNEY_REDACT_URL', {
        epoch: current.epoch, journeyId: current.journeyId, revision: current.draft.revision,
        updatedAt: new Date().toISOString(), stepId, url,
      });
    },
    save: async (acknowledged: boolean): Promise<{ journeyId: string; revision: number }> => {
      const result = await command('ANMERKO_JOURNEY_SAVE', { acknowledged }) as unknown;
      if (!result || typeof result !== 'object' || typeof (result as { journeyId?: unknown }).journeyId !== 'string'
        || !Number.isSafeInteger((result as { revision?: unknown }).revision)) {
        throw new Error(CLIENT_ERROR);
      }
      return result as { journeyId: string; revision: number };
    },
    openSnapshot: async (journeyId: string): Promise<{ draft: JourneyDraftV1; images: Record<string, JourneyDraftImage> }> => {
      const result = await command('ANMERKO_JOURNEY_OPEN_SNAPSHOT', { journeyId }) as unknown;
      if (!result || typeof result !== 'object'
        || !('draft' in (result as Record<string, unknown>)) || !('images' in (result as Record<string, unknown>))) {
        throw new Error(CLIENT_ERROR);
      }
      return result as { draft: JourneyDraftV1; images: Record<string, JourneyDraftImage> };
    },
    reopen: async (journeyId: string): Promise<void> => {
      await command('ANMERKO_JOURNEY_REOPEN', { journeyId });
    },
    deleteSnapshot: async (journeyId: string, revision?: number): Promise<void> => {
      await command('ANMERKO_JOURNEY_DELETE_SNAPSHOT', revision === undefined ? { journeyId } : { journeyId, revision });
    },
    list: async (): Promise<Array<{ journeyId: string; revision: number; updatedAt: string; stepCount: number; spansPages: boolean }>> => {
      const result = await command('ANMERKO_JOURNEY_LIST') as unknown;
      if (!Array.isArray(result)) throw new Error(CLIENT_ERROR);
      return result as Array<{ journeyId: string; revision: number; updatedAt: string; stepCount: number; spansPages: boolean }>;
    },
    start(includeEnteredValues: boolean): Promise<void> {
      let currentOwner: JourneyOwner | undefined;
      try { currentOwner = owner?.(); }
      catch { throw new Error(LAUNCH_ERROR); }
      const native = validOwner(currentOwner) ? currentOwner : undefined;
      const fallbackIntent = owner ? undefined : validIntent(intent) ? intent : undefined;
      if (!native && !fallbackIntent) throw new Error(LAUNCH_ERROR);
      ++actionGeneration;
      // No optional permissions any more: a journey records the site it starts
      // on using activeTab, so Start goes straight to the background.
      if (native) return command('ANMERKO_JOURNEY_START', { ...native, includeEnteredValues }) as Promise<void>;
      return command('ANMERKO_JOURNEY_START', { intent: fallbackIntent, includeEnteredValues }) as Promise<void>;
    },
    stop(): Promise<void> {
      ++actionGeneration;
      return command('ANMERKO_JOURNEY_STOP', !owner && validIntent(intent) ? { intent } : {}) as Promise<void>;
    },
    discard(): Promise<void> {
      ++actionGeneration;
      return command('ANMERKO_JOURNEY_DISCARD') as Promise<void>;
    },
    subscribe(changed: () => void): () => void {
      const listener = (message: unknown, sender: chrome.runtime.MessageSender) => {
        if (!isJourneyBackgroundSender(api.runtime, sender)) return;
        if (message && typeof message === 'object'
          && (message as { type?: unknown }).type === 'ANMERKO_JOURNEY_CHANGED') changed();
      };
      api.runtime.onMessage.addListener(listener);
      return () => api.runtime.onMessage.removeListener(listener);
    },
  };
}
