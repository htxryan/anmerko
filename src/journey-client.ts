import { extensionApi } from './platform';
import type { JourneySession } from './journey-core';
import { isJourneyBackgroundSender } from './journey-messaging';
import type { JourneyClient } from './journey-ui';

type JourneyOwner = { ownerTabId?: number; ownerWindowId?: number };
type JourneyResponse = { ok: true; value?: unknown } | { ok: false; code?: unknown; error?: unknown };

const CLIENT_ERROR = 'Could not update the journey. Try again.';
const LAUNCH_ERROR = 'Open anmerko from a website before starting a journey.';
const PERMISSION_ERROR = 'Allow access to all websites to record a journey, then try again.';
const INTENT_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const BACKEND_GUIDANCE: Record<string, string> = {
  busy: 'Finish or discard the existing journey before starting another.',
  'owner-unavailable': 'Reopen anmerko from the original website and try again.',
  'initial-capture-failed': 'The initial journey screenshot failed. Try again.',
  'launch-expired': 'This launch expired. Reopen anmerko from the original website.',
  'permission-required': 'Allow the requested permissions, then try again.',
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
      const guidance = response && typeof response.code === 'string' && Object.hasOwn(BACKEND_GUIDANCE, response.code)
        ? BACKEND_GUIDANCE[response.code] : undefined;
      throw new Error(guidance ?? CLIENT_ERROR);
    }
    return response.value;
  }

  return {
    supportsEnteredValues: false,
    read: async () => command('ANMERKO_JOURNEY_STATE') as Promise<JourneySession>,
    start(_includeEnteredValues: boolean): Promise<void> {
      let currentOwner: JourneyOwner | undefined;
      try { currentOwner = owner?.(); }
      catch { throw new Error(LAUNCH_ERROR); }
      const native = validOwner(currentOwner) ? currentOwner : undefined;
      const fallbackIntent = owner ? undefined : validIntent(intent) ? intent : undefined;
      if (!native && !fallbackIntent) throw new Error(LAUNCH_ERROR);
      const generation = ++actionGeneration;
      let permission: Promise<boolean>;
      try {
        permission = api.permissions.request({ origins: ['<all_urls>'], permissions: ['webNavigation'] });
      } catch {
        throw new Error(PERMISSION_ERROR);
      }
      return permission.then(async granted => {
        if (generation !== actionGeneration) return;
        if (!granted) throw new Error(PERMISSION_ERROR);
        if (generation !== actionGeneration) return;
        if (native) await command('ANMERKO_JOURNEY_START', native);
        else await command('ANMERKO_JOURNEY_START', { intent: fallbackIntent });
      }, () => {
        if (generation !== actionGeneration) return;
        throw new Error(PERMISSION_ERROR);
      });
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
