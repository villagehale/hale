/**
 * The E2 sentinel's shared types — the envelope E1 hands in, and the typed
 * classification E3 consumes. Kept in one file so the public contract has a
 * single, greppable definition (imported by triage/extract/pipeline and by
 * whatever calls `classifyChildEventEmail`).
 */

/** E1's `events.ingested` gmail envelope — subject/from/snippet ONLY, the shape
 * `syncGmail` in apps/web/lib/integrations/sync.ts enqueues. No body: fetching
 * one is this pipeline's own on-demand, extraction-time-only step. */
export interface InboxEnvelope {
  familyId: string;
  /** The Gmail message id — the ref `fetchGmailMessageBody` re-fetches by. */
  messageId: string;
  subject: string;
  from: string;
  snippet: string;
  /** ISO 8601 instant the envelope was received — the reference point the
   * extraction stage resolves relative dates ("this Saturday") against. */
  receivedAt: string;
}

/** A family child slice — name-only matching context, never a cross-family leak
 * (rule #1: one family's children names only in context). */
export interface FamilyChildRef {
  id: string;
  name: string;
  ageInMonths: number;
}

export type ExtractionKind = 'cancellation' | 'reschedule' | 'new_event' | 'reminder_only' | 'unclear';

/** The typed extraction event fields (ticket's `event` sub-object). */
export interface ExtractedEvent {
  title: string;
  /** SUGGESTIVE name-in-text match against `FamilyChildRef.id` — never a binding.
   * A downstream step (E3) confirms with the parent before acting on it. */
  childRef: string | null;
  originalTime: string | null;
  newTime: string | null;
  location: string | null;
}

/** A reference to the family_events / week_plans row a correlation matched,
 * or null when the extraction is an unmatched (candidate-new) occasion. */
export interface CorrelatedEventRef {
  table: 'family_events' | 'week_plans_item';
  id: string;
}

/**
 * The pipeline's public output — the typed contract E3 consumes. Carries NO
 * email body (rule #1: only the typed extraction + quote_evidence sentence
 * persist, per E1 retention). `quoteEvidence` and `event.title` are generalized
 * when `teenContent` is true (see pipeline.ts) rather than surfacing a 13+
 * child's personal correspondence verbatim.
 */
export interface SentinelClassification {
  status: 'triaged_out' | 'classified';
  familyId: string;
  messageId: string;
  /** Present only when status === 'classified' (triage said child_related). */
  extraction: {
    kind: ExtractionKind;
    event: ExtractedEvent;
    sourceConfidence: number;
    quoteEvidence: string | null;
    teenContent: boolean;
    matchedEventRef: CorrelatedEventRef | null;
  } | null;
  usage: {
    triage: { promptTokens: number; completionTokens: number };
    extract: { promptTokens: number; completionTokens: number } | null;
  };
}
