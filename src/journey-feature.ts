declare const __ANMERKO_JOURNEYS__: boolean;

// Prototype exposure stays off until the plan's browser and privacy gates pass.
export const journeysEnabled = typeof __ANMERKO_JOURNEYS__ !== 'undefined' && __ANMERKO_JOURNEYS__;
