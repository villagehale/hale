'use server';

import { revalidatePath } from 'next/cache';
import { joinLink } from '~/lib/channel/join/code';
import {
  JOIN_LINK_TTL_MS,
  mintJoinInvite,
  revokeOpenJoinInvites,
} from '~/lib/channel/join/invites';
import { db } from '~/lib/db';
import { currentFamilyId, currentUserId } from '~/lib/family';

export type MintCoParentJoinLinkResult =
  | { status: 'minted'; link: string; expiresAt: string }
  | { status: 'unavailable' };

/**
 * "Add your co-parent" from the app — the web door onto the SMS join rail (never the
 * legacy /api/invite web rail). The click IS the parent's authorisation, and the mint
 * transaction records it: the co_parent_access_grant consent row (evidence NULL — the
 * documented UI-consent convention) plus the co_parent_join_link_minted audit row.
 *
 * ONE LIVE LINK: any link already out is revoked first, so the persistent card can
 * honestly promise "one link, one seat" — the raw code is only showable here, at mint
 * (magic-link semantics; the row keeps just its digest).
 */
export async function mintCoParentJoinLink(): Promise<MintCoParentJoinLinkResult> {
  const database = db();
  const [familyId, userId] = await Promise.all([
    currentFamilyId(database),
    currentUserId(database),
  ]);
  if (!familyId || !userId) {
    return { status: 'unavailable' };
  }

  const now = new Date();
  await revokeOpenJoinInvites(database, { familyId, actorUserId: userId, now });
  const { code } = await mintJoinInvite(database, {
    familyId,
    invitedByUserId: userId,
    verbatimRequest: null,
    channelMessageId: null,
    now,
  });

  revalidatePath('/family');
  return {
    status: 'minted',
    link: joinLink(code),
    expiresAt: new Date(now.getTime() + JOIN_LINK_TTL_MS).toISOString(),
  };
}

export type RevokeCoParentJoinLinksResult =
  | { status: 'revoked' }
  | { status: 'none' }
  | { status: 'unavailable' };

/** Kill the outstanding link(s) now. Read-side expiry makes the forwarded code dead
 * everywhere instantly; each killed link gets its audit row (rule #6). */
export async function revokeCoParentJoinLinks(): Promise<RevokeCoParentJoinLinksResult> {
  const database = db();
  const [familyId, userId] = await Promise.all([
    currentFamilyId(database),
    currentUserId(database),
  ]);
  if (!familyId || !userId) {
    return { status: 'unavailable' };
  }

  const { revokedIds } = await revokeOpenJoinInvites(database, {
    familyId,
    actorUserId: userId,
    now: new Date(),
  });
  revalidatePath('/family');
  return { status: revokedIds.length > 0 ? 'revoked' : 'none' };
}
