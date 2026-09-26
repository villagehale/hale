import { type Database, schema } from '@hale/db';
import { and, eq, isNull } from 'drizzle-orm';
import { linqFromE164 } from './config';
import { retrieveLinqContactCard, setupLinqContactCard, shareLinqContactCard } from './transport';

/**
 * VIL-335 — push Hale's Name and Photo card once on a 1:1 iMessage chat,
 * after the first outbound has already landed.
 *
 * Linq's card is first name plus a public image. There is no organization
 * field, so the name iMessage shows is "Hale". The photo is the turtle mark
 * the welcome mail already loads from the app origin. Override with
 * LINQ_CONTACT_IMAGE_URL when that asset moves; a local path cannot be the
 * photo because Linq fetches the URL itself.
 *
 * Configuring the card does not show it. Linq shares only after at least one
 * outbound, via POST /v3/chats/{chatId}/share_contact_card. That moment is
 * Hale's first successful 1:1 send (the greeting, or a details-first first
 * send), which is before onboard finishes. The year-find ladder calls again
 * only as a retry when this attempt released the claim. It does not push a
 * second card, and it does not add a chat line.
 *
 * The share is one-shot per active channel. A group is not this moment. SMS
 * is not this moment. A failure is logged as code and status and does not
 * fail the turn. Setup that never reached the parent's chat releases the
 * claim, so a later fix of the image URL or the partner key can retry. A
 * share that was attempted stays consumed so a retry cannot push the card
 * twice.
 */

export const HALE_CONTACT_FIRST_NAME = 'Hale';

/** The turtle tile the digest and welcome mail already point at. */
export const HALE_CONTACT_IMAGE_URL_DEFAULT = 'https://app.villagehale.com/email-logo.png';

export function haleContactImageUrl(): string {
  const override = (process.env.LINQ_CONTACT_IMAGE_URL ?? '').trim();
  return override.length > 0 ? override : HALE_CONTACT_IMAGE_URL_DEFAULT;
}

/**
 * True for a 1:1 iMessage chat with an id. Onboard completion is not the
 * gate: the first outbound is earlier than that. Groups and SMS are not this.
 * `onboardComplete` is accepted and ignored so a caller written when that
 * flag was the gate still typechecks.
 */
export function linqContactCardMoment(input: {
  channel: string;
  chatId: string | null;
  isGroup: boolean;
  onboardComplete?: boolean;
}): boolean {
  return (
    input.channel === 'imessage' &&
    !input.isGroup &&
    typeof input.chatId === 'string' &&
    input.chatId.length > 0
  );
}

export type LinqContactCardOutcome =
  | { status: 'shared' }
  | { status: 'not_sent'; reason: 'not_a_moment' | 'already_shared' | 'no_from' | 'not_configured' }
  | {
      status: 'not_sent';
      reason: 'card_refused' | 'share_refused';
      code: string;
      httpStatus: number;
    }
  | { status: 'not_sent'; reason: 'unreachable' };

export async function shareHaleContactCardOnce(
  database: Database,
  args: {
    familyId: string;
    parentUserId: string;
    chatId: string | null;
    channel: string;
    isGroup: boolean;
    /** Ignored. The first 1:1 outbound is the moment, including before onboard. */
    onboardComplete?: boolean;
    now: Date;
    fetch?: typeof fetch;
  },
): Promise<LinqContactCardOutcome> {
  if (
    !linqContactCardMoment({
      channel: args.channel,
      chatId: args.chatId,
      isGroup: args.isGroup,
    })
  ) {
    return { status: 'not_sent', reason: 'not_a_moment' };
  }
  const chatId = args.chatId;
  if (!chatId) return { status: 'not_sent', reason: 'not_a_moment' };

  // A missing line does not burn the one-shot. There is no card to share.
  if (!linqFromE164()) {
    const missing = await deliverHaleLinqContactCard({
      chatId,
      familyId: args.familyId,
      fetch: args.fetch,
    });
    return missing.outcome;
  }

  const [claimed] = await database
    .update(schema.parentChannels)
    .set({ linqContactCardSharedAt: args.now, updatedAt: args.now })
    .where(
      and(
        eq(schema.parentChannels.familyId, args.familyId),
        eq(schema.parentChannels.userId, args.parentUserId),
        isNull(schema.parentChannels.revokedAt),
        isNull(schema.parentChannels.linqContactCardSharedAt),
      ),
    )
    .returning({ id: schema.parentChannels.id });
  if (!claimed) return { status: 'not_sent', reason: 'already_shared' };

  const delivered = await deliverHaleLinqContactCard({
    chatId,
    familyId: args.familyId,
    fetch: args.fetch,
  });
  if (!delivered.holdClaim) await clearContactCardClaim(database, claimed.id);
  if (delivered.audit) {
    await database.insert(schema.auditLog).values({
      familyId: args.familyId,
      actor: args.parentUserId,
      actionTaken: 'linq_contact_card_shared',
      targetTable: 'parent_channels',
      targetId: claimed.id,
      after: delivered.audit,
    });
  }
  return delivered.outcome;
}

export interface HaleContactCardDelivery {
  outcome: Exclude<LinqContactCardOutcome, { reason: 'not_a_moment' | 'already_shared' }>;
  /** False when nothing reached the parent's chat, so a later call may retry. */
  holdClaim: boolean;
  /** Written to audit_log once a family exists. Null when there is nothing to record. */
  audit: Record<string, unknown> | null;
}

/**
 * Setup, confirm the line card is active, and share. No channel-row claim:
 * before a family exists the intake session holds that, and
 * {@link shareHaleContactCardOnce} holds it on parent_channels afterwards.
 */
export async function deliverHaleLinqContactCard(args: {
  chatId: string;
  familyId: string | null;
  fetch?: typeof fetch;
}): Promise<HaleContactCardDelivery> {
  const from = linqFromE164();
  if (!from) {
    console.warn(
      { familyId: args.familyId },
      'linq contact card: LINQ_FROM_E164 is unset — the card was not shared',
    );
    return {
      outcome: { status: 'not_sent', reason: 'no_from' },
      holdClaim: false,
      audit: null,
    };
  }

  const imageUrl = haleContactImageUrl();
  const setup = await setupLinqContactCard({
    phoneNumber: from,
    firstName: HALE_CONTACT_FIRST_NAME,
    imageUrl,
    fetch: args.fetch,
  });
  if (setup.status === 'accepted') {
    // Linq: confirm the card is live on the line before share. A create/patch
    // body that omitted is_active used to count as applied, and the share's
    // empty 2xx was then audited as delivered.
    const live = await retrieveLinqContactCard({ phoneNumber: from, fetch: args.fetch });
    if (live.status !== 'active') {
      console.warn(
        { familyId: args.familyId, retrieve: live.status },
        'linq contact card: the card is not active on the line — nothing was shared',
      );
      return {
        holdClaim: false,
        audit: { outcome: 'card_inactive', retrieve: live.status },
        outcome:
          live.status === 'not_configured'
            ? { status: 'not_sent', reason: 'not_configured' }
            : live.status === 'unreachable'
              ? { status: 'not_sent', reason: 'unreachable' }
              : {
                  status: 'not_sent',
                  reason: 'card_refused',
                  code: live.status === 'refused' ? live.code : 'card_inactive',
                  httpStatus: live.status === 'refused' ? live.httpStatus : 0,
                },
      };
    }
  }

  if (setup.status !== 'accepted') {
    const code = setup.status === 'refused' ? setup.code : setup.status;
    const httpStatus = setup.status === 'refused' ? setup.httpStatus : 0;
    console.warn(
      { familyId: args.familyId, code, httpStatus },
      'linq contact card: the Hale card was not applied',
    );
    // Nothing was shared. A bad image URL or a missing key must not burn the
    // one-shot, or a sandbox fix of LINQ_CONTACT_IMAGE_URL could never retry.
    if (setup.status === 'not_configured') {
      return {
        outcome: { status: 'not_sent', reason: 'not_configured' },
        holdClaim: false,
        audit: null,
      };
    }
    return {
      holdClaim: false,
      audit: { outcome: 'card_refused', code },
      outcome:
        setup.status === 'unreachable'
          ? { status: 'not_sent', reason: 'unreachable' }
          : { status: 'not_sent', reason: 'card_refused', code, httpStatus },
    };
  }

  try {
    await shareLinqContactCard({ chatId: args.chatId, fetch: args.fetch });
  } catch (err) {
    const code = err instanceof Error && 'code' in err ? String(err.code) : 'unknown';
    const httpStatus =
      err instanceof Error && 'httpStatus' in err && typeof err.httpStatus === 'number'
        ? err.httpStatus
        : 0;
    console.warn(
      { familyId: args.familyId, code, httpStatus },
      'linq contact card: share did not land',
    );
    return {
      holdClaim: true,
      audit: { outcome: 'share_refused', code },
      outcome: { status: 'not_sent', reason: 'share_refused', code, httpStatus },
    };
  }

  return {
    holdClaim: true,
    audit: { outcome: 'shared', firstName: HALE_CONTACT_FIRST_NAME },
    outcome: { status: 'shared' },
  };
}

/** Setup never reached the parent's chat. Release the claim. A share that
 * was attempted stays consumed so a retry cannot push the card twice. */
async function clearContactCardClaim(database: Database, channelId: string): Promise<void> {
  await database
    .update(schema.parentChannels)
    .set({ linqContactCardSharedAt: null })
    .where(eq(schema.parentChannels.id, channelId));
}
