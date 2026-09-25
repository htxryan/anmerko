import type { JourneyDraftImage, JourneySession } from './journey-core';

// Screenshot data URLs are most of a review's size, and a review view reads
// the journey again after every change, the typed-result autosave included.
// So the background names each screenshot it sends with a token, and a view
// that names the tokens it already holds gets those screenshots without their
// data URLs. A token names one data URL: a masked screenshot gets a new one.
export interface JourneyStateWithScreenshots {
  state: JourneySession;
  // The token of each screenshot in state, by image ID.
  tokens: Record<string, string>;
}

// A view never holds more screenshots than a journey keeps steps.
const MAX_HELD = 64;

// Kept in the background for the life of its worker. Only the current
// journey's screenshots have tokens: each read forgets the rest.
export function createJourneyScreenshotTokens(newToken: () => string = () => crypto.randomUUID()) {
  const issued = new Map<string, { dataUrl: string; token: string }>();
  return (state: JourneySession, held: unknown): JourneyStateWithScreenshots => {
    const holding = new Set(Array.isArray(held)
      ? held.slice(0, MAX_HELD).filter((token): token is string => typeof token === 'string')
      : []);
    const images = 'draft' in state ? state.draft.images : {};
    const tokens: Record<string, string> = {};
    const sent: Record<string, JourneyDraftImage> = {};
    for (const [imageId, image] of Object.entries(images)) {
      if (typeof image.dataUrl !== 'string') { sent[imageId] = image; continue; }
      let entry = issued.get(imageId);
      if (entry?.dataUrl !== image.dataUrl) {
        entry = { dataUrl: image.dataUrl, token: newToken() };
        issued.set(imageId, entry);
      }
      tokens[imageId] = entry.token;
      if (holding.has(entry.token)) {
        const { dataUrl: _dataUrl, ...metadata } = image;
        sent[imageId] = metadata;
      } else sent[imageId] = image;
    }
    for (const imageId of issued.keys()) if (!Object.hasOwn(tokens, imageId)) issued.delete(imageId);
    return { state: 'draft' in state ? { ...state, draft: { ...state.draft, images: sent } } : state, tokens };
  };
}
