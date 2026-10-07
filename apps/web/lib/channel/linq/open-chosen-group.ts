import { type Database, schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { startCoParentInvite } from '~/lib/channel/caregiver/invites';
import { f14EnabledFor } from '~/lib/channel/f14';
import { type ReplyLanguage, replyLanguage } from '~/lib/channel/language';
import { resolveSendablePhone } from '~/lib/channels/sms-consent-core';
import { decryptString } from '~/lib/crypto/string-cipher';
import { linqGroupOnboardingV2Enabled } from './config';
import { type OpenHouseholdGroupOutcome, openHouseholdLinqGroup } from './group';

/**
 * Flag on, and the model chose a new group. Open the household thread with the
 * path main already uses ({@link openHouseholdLinqGroup}). A phone we do not
 * yet trust goes through the existing co-parent invite (the parent confirms
 * the scope; the YES that texts them is also what opens the group). No phone
 * yet seats nobody new: the parent is already in the family, and the absence
 * is `waiting_phone`.
 */
export type OpenChosenGroupOutcome =
  | { status: 'flag_off' }
  | { status: 'not_new' }
  | { status: 'waiting_phone' }
  | { status: 'invite_dark' }
  | { status: 'invite_started'; reply: string }
  | { status: 'invite_refused'; reason: string }
  | OpenHouseholdGroupOutcome;

const CONFIRMED_INVITE = new Set(['accepted', 'awaiting_caregiver_reply', 'identity_noted']);

export async function openChosenHouseholdGroup(
  database: Database,
  args: {
    mode: 'existing' | 'new' | null;
    familyId: string;
    parentUserId: string;
    parentPhoneE164: string;
    now: Date;
    inboundBody: string;
    /** A number in this message that is not yet a confirmed co-parent. */
    namedPhone?: { phoneE164: string; name: string | null } | null;
    fetch?: typeof fetch;
  },
): Promise<OpenChosenGroupOutcome> {
  if (!linqGroupOnboardingV2Enabled()) return { status: 'flag_off' };
  if (args.mode !== 'new') return { status: 'not_new' };

  const confirmed = await confirmedCoParentPhone(database, args.familyId, args.parentPhoneE164);
  if (confirmed) {
    return openHouseholdLinqGroup(database, {
      familyId: args.familyId,
      parentUserId: args.parentUserId,
      parentPhoneE164: args.parentPhoneE164,
      coParentPhoneE164: confirmed,
      now: args.now,
      fetch: args.fetch,
    });
  }

  const named = args.namedPhone ?? null;
  if (named && named.phoneE164 !== args.parentPhoneE164) {
    return startInviteForUnconfirmed(database, args, named);
  }

  await database.insert(schema.auditLog).values({
    familyId: args.familyId,
    actor: args.parentUserId,
    actionTaken: 'linq_group_held',
    targetTable: 'families',
    targetId: args.familyId,
    after: { outcome: 'waiting_phone' },
  });
  console.warn(
    { familyId: args.familyId, reason: 'waiting_phone' },
    'linq group: a new group was chosen and no co-parent phone is confirmed yet',
  );
  return { status: 'waiting_phone' };
}

async function confirmedCoParentPhone(
  database: Database,
  familyId: string,
  parentPhone: string,
): Promise<string | null> {
  const members = await database
    .select({
      familyId: schema.familyMembers.familyId,
      userId: schema.familyMembers.userId,
      role: schema.familyMembers.role,
    })
    .from(schema.familyMembers);
  const seated = members.find((row) => row.familyId === familyId && row.role === 'co_parent');
  if (seated) {
    const phone = await resolveSendablePhone(database, seated.userId);
    if (phone && phone !== parentPhone) return phone;
  }

  const invites = await database
    .select({
      familyId: schema.caregiverInvites.familyId,
      role: schema.caregiverInvites.role,
      state: schema.caregiverInvites.state,
      phoneE164Encrypted: schema.caregiverInvites.phoneE164Encrypted,
    })
    .from(schema.caregiverInvites);
  const noted = invites.find(
    (row) =>
      row.familyId === familyId &&
      row.role === 'co_parent' &&
      CONFIRMED_INVITE.has(row.state) &&
      row.phoneE164Encrypted,
  );
  if (!noted) return null;
  const phone = decryptString(noted.phoneE164Encrypted);
  return phone && phone !== parentPhone ? phone : null;
}

async function startInviteForUnconfirmed(
  database: Database,
  args: {
    familyId: string;
    parentUserId: string;
    parentPhoneE164: string;
    now: Date;
    inboundBody: string;
  },
  named: { phoneE164: string; name: string | null },
): Promise<OpenChosenGroupOutcome> {
  if (!f14EnabledFor(args.familyId)) {
    console.warn(
      { familyId: args.familyId, reason: 'invite_dark' },
      'linq group: the co-parent invite stays dark, so the new group was not opened',
    );
    return { status: 'invite_dark' };
  }
  const language = replyLanguage(args.inboundBody);
  const name = await inviterName(database, args.parentUserId);
  const started = await startCoParentInvite(database, {
    familyId: args.familyId,
    invitedByUserId: args.parentUserId,
    inviterPhoneE164: args.parentPhoneE164,
    inviterName: name,
    parsed: {
      ok: true,
      role: 'co_parent',
      name: named.name ?? inviteeLabel(language),
      phoneE164: named.phoneE164,
    },
    language,
    now: args.now,
  });
  if (started.status === 'refused') return { status: 'invite_refused', reason: started.reason };
  return { status: 'invite_started', reply: started.reply };
}

function inviteeLabel(language: ReplyLanguage): string {
  return language === 'fr' ? 'cette personne' : 'them';
}

async function inviterName(database: Database, userId: string): Promise<string | null> {
  const rows = await database
    .select({ id: schema.users.id, name: schema.users.name })
    .from(schema.users)
    .where(and(eq(schema.users.id, userId)));
  return rows.find((row) => row.id === userId)?.name ?? null;
}
