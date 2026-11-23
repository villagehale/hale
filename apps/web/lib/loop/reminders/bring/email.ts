import { type Database, schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { llmFamilyContext, withLlmContext } from '~/lib/analytics/llm-trace';
import { CALENDAR_CLOCK_TOLERANCE_MS } from '~/lib/channel/calendar-ask';
import type { ExtractionKind } from '~/lib/sentinel/types';
import { bringItemsReminderEnabled } from './flag';
import type { BringItemsReader } from './read';
import { bringItemsAlreadyRead, bringSourceRef, recordBringItems } from './store';

/**
 * VIL-720 · WHAT AN EMAIL SAYS TO BRING, kept for that parent's reminder.
 *
 * Called from the Gmail alert (integrations/email-alert.ts) in two places, both already
 * past the sentinel's verdict that this mail is about the children:
 *
 *   - the email is about an event the family already holds (exactly one correlated
 *     `family_events` row): the list is kept against that event now. This is the reminder
 *     email ("swim tomorrow, bring goggles") the alert itself goes quiet on;
 *   - the email is about an occasion Hale is about to offer to add: the list is kept
 *     PENDING on that offer's `(integration, message)` pair, and the parent's yes attaches
 *     it (email-alert-offer.ts). A no leaves it to age out (store.ts).
 *
 * Never a cancellation or an unclear read, and never a 13+ child's mail (rule #1: teen
 * content stays category-only). The body is fetched for this read alone and dropped.
 * Never throws: the alert it rides on has its own job (rule #11: every ending is named).
 */

export type EmailBringCapture =
  | { status: 'off' }
  | { status: 'skipped'; reason: 'kind' | 'teen' | 'time' | 'already_read' | 'not_configured' }
  | { status: 'none' }
  | { status: 'recorded'; count: number; onEvent: boolean }
  | { status: 'already_recorded' }
  | { status: 'unavailable' }
  | { status: 'failed'; stage: 'body' | 'read' | 'store' };

/** The two outside effects this needs. Either missing is `not_configured`, logged. */
export interface EmailBringPorts {
  readBody?: (messageId: string) => Promise<string>;
  readBringItems?: BringItemsReader;
}

export interface EmailBringInput {
  familyId: string;
  parentUserId: string;
  integrationId: string;
  messageId: string;
  envelope: { subject: string; from: string };
  kind: ExtractionKind;
  /** What the email calls the occasion, and its start (ISO) when known. */
  event: { title: string; startsAt: string | null };
  /** The household event the list belongs to, or null to keep it pending on its offer. */
  eventId: string | null;
  /** Whether a 13+ child is the subject. Asked only once the flag is on. */
  teen: () => Promise<boolean>;
  now: Date;
}

const READABLE_KINDS: ReadonlySet<ExtractionKind> = new Set([
  'new_event',
  'reminder_only',
  'reschedule',
  'booking_confirmation',
]);

async function eventStartAgrees(
  database: Database,
  eventId: string,
  emailStartsAt: string | null,
): Promise<boolean> {
  if (!emailStartsAt) return false;
  const email = new Date(emailStartsAt);
  if (Number.isNaN(email.getTime())) return false;
  const [event] = await database
    .select({ startsAt: schema.familyEvents.startsAt })
    .from(schema.familyEvents)
    .where(eq(schema.familyEvents.id, eventId))
    .limit(1);
  if (!event) return false;
  return Math.abs(event.startsAt.getTime() - email.getTime()) <= CALENDAR_CLOCK_TOLERANCE_MS;
}

function className(err: unknown): string {
  return err instanceof Error ? err.constructor.name : 'unknown';
}

export async function captureEmailBringItems(
  database: Database,
  input: EmailBringInput,
  ports: EmailBringPorts,
): Promise<EmailBringCapture> {
  if (!bringItemsReminderEnabled()) return { status: 'off' };
  const outcome = await capture(database, input, ports);
  console.info(
    {
      familyId: input.familyId,
      outcome: outcome.status,
      ...('reason' in outcome ? { reason: outcome.reason } : {}),
      ...('stage' in outcome ? { stage: outcome.stage } : {}),
      ...('count' in outcome ? { count: outcome.count, onEvent: outcome.onEvent } : {}),
    },
    'email alert: bring items',
  );
  return outcome;
}

async function capture(
  database: Database,
  input: EmailBringInput,
  ports: EmailBringPorts,
): Promise<EmailBringCapture> {
  if (!READABLE_KINDS.has(input.kind)) return { status: 'skipped', reason: 'kind' };
  // The household correlation window is wide enough to pick the same title on the
  // next day. A list is kept only when this email and that event name the same start.
  if (
    input.eventId !== null &&
    !(await eventStartAgrees(database, input.eventId, input.event.startsAt))
  ) {
    return { status: 'skipped', reason: 'time' };
  }
  try {
    if (await input.teen()) return { status: 'skipped', reason: 'teen' };
  } catch (err) {
    // Fail closed: a teen check that cannot answer is a teen.
    console.warn({ detail: className(err) }, 'email alert: bring items teen check failed');
    return { status: 'skipped', reason: 'teen' };
  }
  if (!ports.readBody || !ports.readBringItems) {
    return { status: 'skipped', reason: 'not_configured' };
  }
  const sourceRef = bringSourceRef(input.integrationId, input.messageId);
  try {
    if (await bringItemsAlreadyRead(database, { ownerUserId: input.parentUserId, sourceRef })) {
      return { status: 'skipped', reason: 'already_read' };
    }
  } catch (err) {
    console.warn({ detail: className(err) }, 'email alert: bring items lookup failed');
    return { status: 'failed', stage: 'store' };
  }
  let body: string;
  try {
    body = await ports.readBody(input.messageId);
  } catch (err) {
    console.warn({ detail: className(err) }, 'email alert: bring items body unread');
    return { status: 'failed', stage: 'body' };
  }
  const reader = ports.readBringItems;
  let read: Awaited<ReturnType<BringItemsReader>>;
  try {
    read = await withLlmContext(
      { stage: 'reminder', mode: 'bring_items_read', ...llmFamilyContext(input.familyId) },
      () =>
        reader({
          event: input.event,
          source: {
            kind: 'email',
            from: input.envelope.from,
            subject: input.envelope.subject,
            body,
          },
        }),
    );
  } catch (err) {
    console.warn({ detail: className(err) }, 'email alert: bring items read threw');
    return { status: 'failed', stage: 'read' };
  }
  if (read.status === 'unavailable') return { status: 'unavailable' };
  if (read.status === 'failed') return { status: 'failed', stage: 'read' };
  if (read.status === 'none') return { status: 'none' };
  try {
    const stored = await recordBringItems(database, {
      familyId: input.familyId,
      ownerUserId: input.parentUserId,
      eventId: input.eventId,
      sourceKind: 'email',
      sourceRef,
      items: read.items,
      now: input.now,
    });
    if (stored === 'already_recorded') return { status: 'already_recorded' };
    if (stored === 'empty') return { status: 'none' };
    return { status: 'recorded', count: read.items.length, onEvent: input.eventId !== null };
  } catch (err) {
    console.warn({ detail: className(err) }, 'email alert: bring items not stored');
    return { status: 'failed', stage: 'store' };
  }
}
