declare const __TARGET_JOURNEYS__: boolean;

// Whether this build target includes journeys: scripts/extension/build.mjs
// defines it per target (Chrome, Edge, and Firefox yes; Orion no). It is not a
// switch; nothing at build or run time turns it on. Bundles built without the
// define, such as test harnesses, leave journeys out.
export const targetJourneys = typeof __TARGET_JOURNEYS__ !== 'undefined' && __TARGET_JOURNEYS__;
