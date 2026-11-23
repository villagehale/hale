import type Anthropic from '@anthropic-ai/sdk';
import type { Database } from '@hale/db';
import { llmFamilyContext, withLlmContext } from '~/lib/analytics/llm-trace';
import type { InboundMediaPart } from '~/lib/channel/inbound-media';
import {
  COACH_CALENDAR_INTEGRATION_ID,
  coachOfferMessageId,
} from '~/lib/integrations/email-alert-offer';
import { bringItemsReminderEnabled } from './flag';
import type { BringItemsReader } from './read';
import { bringItemsAlreadyRead, bringSourceRef, recordBringItems } from './store';

/**
 * VIL-720 · WHAT A FLYER SAYS TO BRING, kept for the parent who sent it.
 *
 * A parent sends Hale a flyer or a screenshot 1:1, and the coach's answer offers to put
 * its occasion on the calendar (router/route.ts `recordCoachOfferFromReply`, which wrote
 * the offer row). Only then, after the answer has gone out, the turn's images are fetched
 * once more and read for what they ask the family to bring. The list is kept PENDING on
 * that offer's own (integration, message) pair, and the parent's yes attaches it to the
 * event (email-alert-offer.ts). A turn that offers nothing reads nothing.
 *
 * Images only. A PDF's text layer can carry words the parent never saw on the page, and a
 * bring list lands in a text Hale sends later, so a PDF stays unread here. A group turn is
 * never read: the list would be one parent's, made from something the whole group saw.
 * The image bytes live for this read alone. Never throws (rule #11: every ending named).
 */

export interface CoachBringPorts {
  /** The turn's images as model blocks, fetched again for this read and then dropped. */
  readImages: (parts: readonly InboundMediaPart[]) => Promise<Anthropic.ContentBlockParam[]>;
  readBringItems: BringItemsReader;
}

export type CoachBringCapture =
  | { status: 'off' }
  | { status: 'skipped'; reason: 'group' | 'no_image' | 'not_configured' | 'already_read' }
  | { status: 'none' }
  | { status: 'recorded'; count: number }
  | { status: 'already_recorded' }
  | { status: 'unavailable' }
  | { status: 'failed'; stage: 'media' | 'read' | 'store' };

export interface CoachBringInput {
  familyId: string;
  parentUserId: string;
  /** The outbound row that carried the coach's offer: half of the offer's key. */
  channelMessageId: string;
  /** What the parent typed beside the photo: which event they mean, never an item. */
  parentWords: string;
  /** The occasion the coach offered, as the offer row holds it. */
  event: { title: string; startsAt: string | null };
  media: readonly InboundMediaPart[];
  audience: 'direct' | 'group';
  now: Date;
}

function className(err: unknown): string {
  return err instanceof Error ? err.constructor.name : 'unknown';
}

export async function captureCoachOfferBringItems(
  database: Database,
  input: CoachBringInput,
  ports: CoachBringPorts | undefined,
): Promise<CoachBringCapture> {
  if (!bringItemsReminderEnabled()) return { status: 'off' };
  const outcome = await capture(database, input, ports);
  console.info(
    {
      familyId: input.familyId,
      outcome: outcome.status,
      ...('reason' in outcome ? { reason: outcome.reason } : {}),
      ...('stage' in outcome ? { stage: outcome.stage } : {}),
      ...('count' in outcome ? { count: outcome.count } : {}),
    },
    'coach offer: bring items',
  );
  return outcome;
}

async function capture(
  database: Database,
  input: CoachBringInput,
  ports: CoachBringPorts | undefined,
): Promise<CoachBringCapture> {
  if (input.audience !== 'direct') return { status: 'skipped', reason: 'group' };
  const images = input.media.filter((part) => part.kind === 'image');
  if (images.length === 0) return { status: 'skipped', reason: 'no_image' };
  if (!ports) return { status: 'skipped', reason: 'not_configured' };
  const sourceRef = bringSourceRef(
    COACH_CALENDAR_INTEGRATION_ID,
    coachOfferMessageId(input.channelMessageId),
  );
  try {
    if (await bringItemsAlreadyRead(database, { ownerUserId: input.parentUserId, sourceRef })) {
      return { status: 'skipped', reason: 'already_read' };
    }
  } catch (err) {
    console.warn({ detail: className(err) }, 'coach offer: bring items lookup failed');
    return { status: 'failed', stage: 'store' };
  }
  let attachments: Anthropic.ContentBlockParam[];
  try {
    attachments = (await ports.readImages(images)).filter((block) => block.type === 'image');
  } catch (err) {
    console.warn({ detail: className(err) }, 'coach offer: bring items images unread');
    return { status: 'failed', stage: 'media' };
  }
  if (attachments.length === 0) return { status: 'skipped', reason: 'no_image' };
  let read: Awaited<ReturnType<BringItemsReader>>;
  try {
    read = await withLlmContext(
      { stage: 'reminder', mode: 'bring_items_read', ...llmFamilyContext(input.familyId) },
      () =>
        ports.readBringItems({
          event: input.event,
          source: { kind: 'photo', parentWords: input.parentWords, attachments },
        }),
    );
  } catch (err) {
    console.warn({ detail: className(err) }, 'coach offer: bring items read threw');
    return { status: 'failed', stage: 'read' };
  }
  if (read.status === 'unavailable') return { status: 'unavailable' };
  if (read.status === 'failed') return { status: 'failed', stage: 'read' };
  if (read.status === 'none') return { status: 'none' };
  try {
    const stored = await recordBringItems(database, {
      familyId: input.familyId,
      ownerUserId: input.parentUserId,
      eventId: null,
      sourceKind: 'photo',
      sourceRef,
      items: read.items,
      now: input.now,
    });
    if (stored === 'already_recorded') return { status: 'already_recorded' };
    if (stored === 'empty') return { status: 'none' };
    return { status: 'recorded', count: read.items.length };
  } catch (err) {
    console.warn({ detail: className(err) }, 'coach offer: bring items not stored');
    return { status: 'failed', stage: 'store' };
  }
}
