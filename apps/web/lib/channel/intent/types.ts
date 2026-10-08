/** What the parent meant, as fields a handler can act on. The model picks. Code does not. */
export const PARENT_INTENTS = [
  'affirm',
  'decline',
  'undo',
  'choose',
  'cadence',
  'connect',
  'disconnect',
  'fresh_link',
  'health_done',
  'health_book',
  'registration',
  'party',
  'signup',
  'memory',
  'weekday_care',
  'join',
  'coparent_number',
  'find_activities',
  'book_checkup',
  'set_reminder',
  'forward_address',
  'forward_off',
  'rec_morning',
  'day_note',
  'unclear',
  'other',
] as const;

export type ParentIntentKind = (typeof PARENT_INTENTS)[number];

export type IntentConfidence = 'high' | 'medium' | 'low';

export interface ParentIntentReading {
  intent: ParentIntentKind;
  confidence: IntentConfidence;
  /** The pending question this answers, when it answers one. */
  targetId: string | null;
  /** 1-based choice from a list Hale offered. */
  index: number | null;
  /** Kind-specific detail. Null when the kind has none. */
  value: string | null;
}

export interface PendingOffer {
  id: string;
  kind: string;
  description: string;
}

export interface IntentTurn {
  role: 'parent' | 'hale';
  body: string;
}

export interface ParentIntentInput {
  text: string;
  recentTurns: readonly IntentTurn[];
  pending: readonly PendingOffer[];
}
