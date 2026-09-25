export const JOURNEY_LIMITS = {
  maxDurationMs: 5 * 60 * 1_000,
  maxSteps: 30,
  maxImageLongestSide: 1_920,
  maxImageBytes: 768 * 1_024,
  maxJourneyImageBytes: 5 * 1_024 * 1_024,
  maxSessionBytes: 8 * 1_024 * 1_024,
  maxReviewedImageBytes: 50 * 1_024 * 1_024,
  maxReviewedManifestBytes: 5 * 1_024 * 1_024,
  maxJourneys: 100,
  maxExportBytes: 50 * 1_024 * 1_024,
  maxUrlBytes: 32 * 1_024,
  maxEventPayloadBytes: 64 * 1_024,
  maxReviewIdleMs: 30 * 60 * 1_000,
  reviewWarningMs: 2 * 60 * 1_000,
  maxSummaryCharacters: 4_000,
  maxTargetSegments: 12,
  maxTargetTextCharacters: 120,
  maxFieldValueCharacters: 2_000,
  maxJourneyFieldTextBytes: 16 * 1_024,
  maxIdCharacters: 128,
  maxSelectorSegmentCharacters: 256,
  maxLimitations: 30,
  maxLimitationCharacters: 500,
  sessionMetadataReserveBytes: 1_024,
} as const;

export const CAPTURE_FAILURES = [
  'superseded',
  'navigation-timeout',
  'capture-denied',
  'protected-page',
  'page-document-changed',
  'viewport-changed',
  'too-large',
  'storage-limit',
  'stopped',
  'capture-error',
] as const;

export type CaptureFailure = typeof CAPTURE_FAILURES[number];

export const STOP_REASONS = [
  'user',
  'duration-limit',
  'step-limit',
  'image-budget',
  'session-storage-limit',
  'left-site',
  'focus-lost',
  'tab-lost',
  'protected-page',
  'capture-failed',
  // Appended so drafts and snapshots with the earlier reasons stay valid.
  'page-access-lost',
] as const;

export type StopReason = typeof STOP_REASONS[number];
