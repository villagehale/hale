/**
 * Mirror of @hale/types ONBOARDING_INTENTS — the native bundle can't import
 * server/package code that pulls in Node, so the value/label pairs are hand-copied
 * (same pattern as api-types.ts). Short labels for the chip layout. Shared by the
 * intents step and the preview call.
 */
export const ONBOARDING_INTENTS: { value: string; label: string }[] = [
  { value: 'activities', label: 'Activities & classes' },
  { value: 'childcare', label: 'Childcare' },
  { value: 'milestones', label: 'Milestones & development' },
  { value: 'planning', label: 'Weekly planning & routine' },
  { value: 'sitter', label: 'Trusted sitter/nanny' },
  { value: 'health', label: 'Health & specialists' },
  { value: 'community', label: 'Meeting other families' },
  { value: 'exploring', label: 'Just exploring' },
];
