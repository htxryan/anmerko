declare const __ANMERKO_JOURNEYS__: boolean;

// The build defines this per target: on for Chrome, Edge, and Firefox, off for
// Orion. Test harnesses bundled without the define keep journeys off.
export const journeysEnabled = typeof __ANMERKO_JOURNEYS__ !== 'undefined' && __ANMERKO_JOURNEYS__;
