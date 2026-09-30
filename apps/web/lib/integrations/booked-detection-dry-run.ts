import type { AgentClient } from '@hale/agent';
import type { ExtractionKind, FamilyChildRef } from '~/lib/sentinel';
import { type FalseBookingSignal, falseBookingSignal } from '~/lib/sentinel/booking-guard';
import { classifyChildEventEmail } from '~/lib/sentinel/pipeline';
import { bookingDraft } from './booking';

/**
 * Offline booked-detection dry-run.
 *
 * One JSON file of envelopes in, one verdict per email out. It calls the real
 * `classifyChildEventEmail` — triage and extraction, skills off disk — and then the
 * same `bookingDraft` the alert path uses to decide whether a row would be written.
 *
 * IT HAS NO DATABASE AND NO TRANSPORT. There is no parameter for either, so a run
 * cannot write a booking or send an SMS. The body handed to extraction is the
 * fixture's own `body`, or its snippet when the fixture has none; nothing is fetched
 * from a mailbox.
 *
 * Fixtures are synthetic. Do not point this at a real export.
 */

/** A preschooler who does not exist, so a dry-run can resolve child attribution
 * without a household. Not a person's name from a mailbox. */
const SYNTHETIC_CHILD: FamilyChildRef = {
  id: 'child-synthetic',
  name: 'Rowan',
  ageInMonths: 36,
};

export interface DryRunEnvelope {
  id: string;
  sender: string;
  subject: string;
  snippet: string;
  /** ISO 8601 instant the envelope was received. */
  date: string;
  /** Optional stand-in for the body. The snippet is used when this is absent. */
  body?: string;
}

export interface DryRunVerdict {
  id: string;
  kind: ExtractionKind | null;
  /** The deterministic refusal, read off the envelope. Null when the envelope can
   * still be a held place. */
  guard: FalseBookingSignal | null;
  title: string | null;
  wouldRecordBooking: boolean;
  /** Why no booking row would be written, or null when one would. */
  bookingRefusal: string | null;
}

export async function runBookedDetectionDryRun(
  emails: readonly DryRunEnvelope[],
  deps: { client: AgentClient },
): Promise<DryRunVerdict[]> {
  const verdicts: DryRunVerdict[] = [];
  for (const email of emails) {
    const receivedAt = email.date;
    const classification = await classifyChildEventEmail(
      {
        familyId: 'dry-run',
        messageId: email.id,
        subject: email.subject,
        from: email.sender,
        snippet: email.snippet,
        receivedAt,
      },
      {
        client: deps.client,
        children: [SYNTHETIC_CHILD],
        fetchBody: async () => email.body ?? email.snippet,
        correlationCandidates: [],
        familyTimezone: 'America/Toronto',
      },
    );
    const guard = falseBookingSignal({ subject: email.subject, snippet: email.snippet });
    const extraction = classification.extraction;
    if (classification.status !== 'classified' || extraction === null) {
      verdicts.push({
        id: email.id,
        kind: null,
        guard,
        title: null,
        wouldRecordBooking: false,
        bookingRefusal: 'not_classified',
      });
      continue;
    }
    const now = new Date(receivedAt);
    const draft = bookingDraft({
      kind: extraction.kind,
      event: extraction.event,
      from: email.sender,
      teenContent: extraction.teenContent,
      teenAttributed: extraction.teenAttributed,
      sourceConfidence: extraction.sourceConfidence,
      matchedEventRef: extraction.matchedEventRef,
      title: extraction.event.title,
      titleIsFallback: false,
      location: extraction.event.location,
      now: Number.isNaN(now.getTime()) ? new Date() : now,
    });
    verdicts.push({
      id: email.id,
      kind: extraction.kind,
      guard,
      title: extraction.event.title,
      wouldRecordBooking: draft.ok,
      bookingRefusal: draft.ok ? null : draft.reason,
    });
  }
  return verdicts;
}
