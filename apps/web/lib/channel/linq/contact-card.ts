import { type Database, schema } from '@hale/db';
import { and, eq, isNull } from 'drizzle-orm';
import { linqFromE164 } from './config';
import { setupLinqContactCard, shareLinqContactCard } from './transport';

/**
 * VIL-335 — push Hale's Name and Photo card once, after a fresh 1:1 onboard.
 *
 * Linq's card is first name plus a public image. There is no organization
 * field, so the name iMessage shows is "Hale". The photo is the turtle mark
 * the welcome mail already loads from the app origin. Override with
 * LINQ_CONTACT_IMAGE_URL when that asset moves; a local path cannot be the
 * photo because Linq fetches the URL itself.
 *
 * The share is one-shot per active channel. Mid-intake does not call this —
 * only a completed onboard on a 1:1 Linq chat does. A failure is logged as
 * code and status and does not fail the turn. Setup that never reached the
 * parent's chat releases the claim, so a later fix of the image URL or the
 * partner key can retry. A share that was attempted stays consumed so a
 * retry cannot push the card twice.
 */

export const HALE_CONTACT_FIRST_NAME = 'Hale';

/** The turtle tile the digest and welcome mail already point at. */
export const HALE_CONTACT_IMAGE_URL_DEFAULT = 'https://app.villagehale.com/email-logo.png';

export function haleContactImageUrl(): string {
  const override = (process.env.LINQ_CONTACT_IMAGE_URL ?? '').trim();
  return override.length > 0 ? override : HALE_CONTACT_IMAGE_URL_DEFAULT;
}

/** True only for a finished 1:1 iMessage onboard. Mid-intake and groups are not this. */
export function linqContactCardMoment(input: {
  channel: string;
  chatId: string | null;
  isGroup: boolean;
  onboardComplete: boolean;
}): boolean {
  return (
    input.onboardComplete &&
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
    onboardComplete: boolean;
    now: Date;
    fetch?: typeof fetch;
  },
): Promise<LinqContactCardOutcome> {
  if (
    !linqContactCardMoment({
      channel: args.channel,
      chatId: args.chatId,
      isGroup: args.isGroup,
      onboardComplete: args.onboardComplete,
    })
  ) {
    return { status: 'not_sent', reason: 'not_a_moment' };
  }
  const from = linqFromE164();
  if (!from) {
    console.warn(
      { familyId: args.familyId },
      'linq contact card: LINQ_FROM_E164 is unset — the card was not shared',
    );
    return { status: 'not_sent', reason: 'no_from' };
  }

  const chatId = args.chatId;
  if (!chatId) return { status: 'not_sent', reason: 'not_a_moment' };

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

  const imageUrl = haleContactImageUrl();
  const setup = await setupLinqContactCard({
    phoneNumber: from,
    firstName: HALE_CONTACT_FIRST_NAME,
    imageUrl,
    fetch: args.fetch,
  });
  if (setup.status !== 'accepted') {
    const code = setup.status === 'refused' ? setup.code : setup.status;
    const httpStatus = setup.status === 'refused' ? setup.httpStatus : 0;
    console.warn(
      { familyId: args.familyId, code, httpStatus },
      'linq contact card: the Hale card was not applied',
    );
    // Nothing was shared. A bad image URL or a missing key must not burn the
    // one-shot, or a sandbox fix of LINQ_CONTACT_IMAGE_URL could never retry.
    await clearContactCardClaim(database, claimed.id);
    if (setup.status === 'not_configured') {
      return { status: 'not_sent', reason: 'not_configured' };
    }
    await database.insert(schema.auditLog).values({
      familyId: args.familyId,
      actor: args.parentUserId,
      actionTaken: 'linq_contact_card_shared',
      targetTable: 'parent_channels',
      targetId: claimed.id,
      after: { outcome: 'card_refused', code },
    });
    return setup.status === 'unreachable'
      ? { status: 'not_sent', reason: 'unreachable' }
      : { status: 'not_sent', reason: 'card_refused', code, httpStatus };
  }

  try {
    await shareLinqContactCard({ chatId, fetch: args.fetch });
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
    await database.insert(schema.auditLog).values({
      familyId: args.familyId,
      actor: args.parentUserId,
      actionTaken: 'linq_contact_card_shared',
      targetTable: 'parent_channels',
      targetId: claimed.id,
      after: { outcome: 'share_refused', code },
    });
    return { status: 'not_sent', reason: 'share_refused', code, httpStatus };
  }

  await database.insert(schema.auditLog).values({
    familyId: args.familyId,
    actor: args.parentUserId,
    actionTaken: 'linq_contact_card_shared',
    targetTable: 'parent_channels',
    targetId: claimed.id,
    after: { outcome: 'shared', firstName: HALE_CONTACT_FIRST_NAME },
  });
  return { status: 'shared' };
}

/** Setup never reached the parent's chat. Release the claim. A share that
 * was attempted stays consumed so a retry cannot push the card twice. */
async function clearContactCardClaim(database: Database, channelId: string): Promise<void> {
  await database
    .update(schema.parentChannels)
    .set({ linqContactCardSharedAt: null })
    .where(eq(schema.parentChannels.id, channelId));
}
