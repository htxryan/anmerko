import { extensionApi, firefoxExtension } from './platform';
import type { JourneyDraftImage, JourneyDraftV1, JourneySession, JourneyUrlRedactionTarget } from './journey-core';
import { isJourneyBackgroundSender } from './journey-messaging';
import { JOURNEY_SAVE_IN_PROGRESS, JOURNEY_SAVE_IN_PROGRESS_ERROR } from './journey-ui';
import type { JourneyClient, JourneyDiscardTarget, JourneyImageChange, JourneyReviewTarget, JourneySavedSummary } from './journey-ui';

type JourneyOwner = { ownerTabId?: number; ownerWindowId?: number };
type ReviewingSession = Extract<JourneySession, { phase: 'reviewing' }>;
type JourneyResponse = { ok: true; value?: unknown } | { ok: false; code?: unknown; error?: unknown };

const CLIENT_ERROR = 'Could not update the journey. Try again.';
const LAUNCH_ERROR = 'Open anmerko from a website before starting a journey.';
const INTENT_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const BACKEND_GUIDANCE: Record<string, string> = {
  busy: 'Finish or discard the existing journey before starting another.',
  'owner-unavailable': 'anmerko could not reach the website tab. On that tab, click anmerko in the browser toolbar or Extensions menu, then try again.',
  'initial-capture-failed': 'The initial journey screenshot failed. Try again.',
  'launch-expired': 'This journey link expired. On the website tab, choose Record journey again.',
  'session-storage-failed': 'Journey storage failed. Reset journey storage to continue. A previous draft or the latest action may be lost.',
  'stale-review': 'Another review tab changed this journey. Reload the review and try again.',
  'saved-journeys-full': 'Saved journeys are full. Delete saved journeys to make room for this one, then save again.',
};

function validOwner(value: JourneyOwner | undefined): value is { ownerTabId: number; ownerWindowId: number } {
  return Number.isSafeInteger(value?.ownerTabId) && (value?.ownerTabId as number) >= 0
    && Number.isSafeInteger(value?.ownerWindowId) && (value?.ownerWindowId as number) >= 0;
}

function validIntent(value: string | undefined): value is string {
  return typeof value === 'string' && INTENT_PATTERN.test(value);
}

function savingError(): Error {
  return Object.assign(new Error(JOURNEY_SAVE_IN_PROGRESS_ERROR), { code: JOURNEY_SAVE_IN_PROGRESS });
}

function staleError(): Error {
  return Object.assign(new Error(BACKEND_GUIDANCE['stale-review']), { code: 'stale-review' });
}

function errorCode(error: unknown): unknown {
  return (error as { code?: unknown } | null)?.code;
}

// Whether a session is, or is saving, the given review.
function holdsReview(session: JourneySession | undefined, review: JourneyReviewTarget): boolean {
  return (session?.phase === 'reviewing' || session?.phase === 'saving')
    && session.journeyId === review.journeyId && session.sessionId === review.sessionId;
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

  // review, when given, is the review the edit was made in: its journey and
  // the session that recorded or reopened it. Any other journey, or another
  // review of the same one, is refused as another tab's change, even while it
  // saves. Only a screenshot edit reads the screenshots.
  async function reviewing(review?: JourneyReviewTarget, screenshots = false): Promise<ReviewingSession> {
    const current = await command('ANMERKO_JOURNEY_STATE', screenshots ? {} : { screenshots: false }) as JourneySession;
    if (review !== undefined && current.phase !== 'idle' && (current.journeyId !== review.journeyId
      || ('sessionId' in current && current.sessionId !== review.sessionId))) throw staleError();
    if (current.phase === 'saving') throw savingError();
    if (current.phase !== 'reviewing') throw new Error(CLIENT_ERROR);
    return current;
  }

  // The edit names the review it read, which the background checks when it
  // applies it: a review switched since is refused as stale. A save holds the
  // review in its saving phase, and the background refuses edits then as
  // stale too. When the review has not changed since this edit read it, or
  // this review's save has since finished, the save refused it, not another
  // tab: say so, so the view can wait for the save instead.
  async function reviewEdit(current: ReviewingSession, type: string, extra: Record<string, unknown>): Promise<void> {
    try {
      await command(type, {
        epoch: current.epoch, journeyId: current.journeyId, sessionId: current.sessionId,
        revision: current.draft.revision, ...extra,
      });
    } catch (error) {
      if (errorCode(error) !== 'stale-review') throw error;
      const latest = await command('ANMERKO_JOURNEY_STATE', { screenshots: false }).catch(() => undefined) as JourneySession | undefined;
      if ((latest?.phase === 'saving' && holdsReview(latest, current))
        || (latest?.phase === 'saved' && latest.journeyId === current.journeyId)
        || (latest?.phase === 'reviewing' && holdsReview(latest, current) && latest.epoch === current.epoch
          && latest.draft.revision === current.draft.revision)) throw savingError();
      throw error;
    }
  }

  return {
    supportsEnteredValues: true,
    pageLoadsEndJourney: firefoxExtension(),
    // A journey view shows screenshots only in review. While recording it
    // shows the step count, so each recorded step reads no screenshots.
    read: async () => command('ANMERKO_JOURNEY_STATE', { screenshots: 'review' }) as Promise<JourneySession>,
    updateSummary: async (expected: string, actual: string, review?: JourneyReviewTarget): Promise<void> => {
      await reviewEdit(await reviewing(review), 'ANMERKO_JOURNEY_UPDATE_SUMMARY', {
        updatedAt: new Date().toISOString(), expected, actual,
      });
    },
    removeStep: async (stepId: string, review?: JourneyReviewTarget): Promise<void> => {
      await reviewEdit(await reviewing(review), 'ANMERKO_JOURNEY_REMOVE_STEP', {
        updatedAt: new Date().toISOString(), stepId,
      });
    },
    editValue: async (stepId: string, value: unknown, review?: JourneyReviewTarget): Promise<void> => {
      await reviewEdit(await reviewing(review), 'ANMERKO_JOURNEY_EDIT_VALUE', {
        updatedAt: new Date().toISOString(), stepId, value,
      });
    },
    redactUrl: async (stepId: string, url: JourneyUrlRedactionTarget, review?: JourneyReviewTarget): Promise<void> => {
      await reviewEdit(await reviewing(review), 'ANMERKO_JOURNEY_REDACT_URL', {
        updatedAt: new Date().toISOString(), stepId, url,
      });
    },
    redactLabel: async (stepId: string, review?: JourneyReviewTarget): Promise<void> => {
      await reviewEdit(await reviewing(review), 'ANMERKO_JOURNEY_REDACT_LABEL', {
        updatedAt: new Date().toISOString(), stepId,
      });
    },
    reviewImage: async (imageId: string, change: JourneyImageChange, review?: JourneyReviewTarget): Promise<void> => {
      const current = await reviewing(review, change.operation === 'replace');
      // A mask drawn on older pixels must not overwrite a change another review tab made since.
      if (change.operation === 'replace' && current.draft.images[imageId]?.dataUrl !== change.maskedFrom) throw staleError();
      await reviewEdit(current, 'ANMERKO_JOURNEY_REVIEW_IMAGE', {
        imageId, operation: change.operation, ...(change.operation === 'replace' ? { dataUrl: change.image.dataUrl } : {}),
      });
    },
    // The background saves only the named review.
    save: async (acknowledged: boolean, review?: JourneyReviewTarget): Promise<{ journeyId: string; revision: number }> => {
      const result = await command('ANMERKO_JOURNEY_SAVE', review
        ? { acknowledged, journeyId: review.journeyId, sessionId: review.sessionId }
        : { acknowledged }) as unknown;
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
    list: async (): Promise<JourneySavedSummary[]> => {
      const result = await command('ANMERKO_JOURNEY_LIST') as unknown;
      if (!Array.isArray(result)) throw new Error(CLIENT_ERROR);
      return result as JourneySavedSummary[];
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
    // A targeted discard is refused as stale once its view no longer shows the
    // current journey; one that finds this review saving says so instead.
    async discard(expected?: JourneyDiscardTarget): Promise<void> {
      ++actionGeneration;
      if (!expected) {
        await command('ANMERKO_JOURNEY_DISCARD');
        return;
      }
      try {
        await command('ANMERKO_JOURNEY_DISCARD', { ...expected });
      } catch (error) {
        if (errorCode(error) === 'stale-review' && expected.phase === 'reviewing') {
          const latest = await command('ANMERKO_JOURNEY_STATE', { screenshots: false }).catch(() => undefined) as JourneySession | undefined;
          if (latest?.phase === 'saving' && holdsReview(latest, expected)) throw savingError();
        }
        throw error;
      }
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
