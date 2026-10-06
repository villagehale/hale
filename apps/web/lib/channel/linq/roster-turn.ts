import type { Database } from '@hale/db';
import { matchKeyword } from '~/lib/channel/intake/keywords';
import { resolveVerifiedChannelByPhone } from '~/lib/channels/sms-consent-core';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { realHumanPhone } from './group-coparent';
import type { RoleWordKey } from './group-onboarding-line-input';
import type { LinqInboundText } from './payload';
import { type ListChatHandles, attachRosterToFamily, ensureRoster } from './roster';
import {
  type RosterVoicePorts,
  acknowledgeRole,
  askMember,
  askRoster,
  firstName,
  liveRosterMember,
  readRosterByChat,
  reaskRole,
  sayNoFamilyYet,
} from './roster-ask';
import {
  type RosterReading,
  type RosterRoleClassifier,
  readRosterReplyWithClassifier,
} from './roster-reading';
import { declineRosterMember, seatConfirmedMember } from './roster-seat';

/**
 * Group onboarding v2 — a group message, read against the roster before anything else.
 *
 * A member Hale asked is answered here: seated on their own words, re-asked once when
 * code cannot read them, or recorded as not family. Someone the roster never saw is
 * asked, not read. A chat Hale knows nobody in gets its one line and then silence. A
 * known parent's message, a confirmed member's, and STOP/HELP/START are not this
 * module's: they go on to the household router.
 */

export interface RosterTurnPorts extends RosterVoicePorts {
  classifier: RosterRoleClassifier | undefined;
  listHandles?: ListChatHandles;
  recordInbound: (
    message: LinqInboundText,
    owner: { familyId: string; userId: string },
  ) => Promise<string | null>;
}

export type RosterTurn =
  | { handled: false }
  | {
      handled: true;
      outcome: string;
      count: 'intake' | 'ignored';
      body: Record<string, unknown>;
    };

const NOT_HANDLED: RosterTurn = { handled: false };

function handled(
  outcome: string,
  count: 'intake' | 'ignored',
  extra: Record<string, unknown> = {},
): RosterTurn {
  return { handled: true, outcome, count, body: { outcome, ...extra } };
}

function roleWordFor(reading: Extract<RosterReading, { kind: 'role' }>): RoleWordKey | null {
  if (reading.role === 'parent') {
    return reading.parentRole === 'mother'
      ? 'mom'
      : reading.parentRole === 'father'
        ? 'dad'
        : 'parent';
  }
  if (reading.role === 'not_family' || reading.role === 'decline') return null;
  return reading.role;
}

export async function takeRosterTurn(
  database: Database,
  message: LinqInboundText,
  ports: RosterTurnPorts,
): Promise<RosterTurn> {
  if (matchKeyword(message.text)) return NOT_HANDLED;
  const phone = realHumanPhone(message.senderHandle);
  if (!phone) return NOT_HANDLED;

  const ensured = await ensureRoster(database, {
    chatId: message.chatId,
    now: ports.now,
    listHandles: ports.listHandles,
  });
  if (
    ensured.outcome === 'flag_off' ||
    ensured.outcome === 'not_migrated' ||
    ensured.outcome === 'roster_absent'
  ) {
    return NOT_HANDLED;
  }
  let roster = await readRosterByChat(database, message.chatId);
  if (!roster) return NOT_HANDLED;

  if (roster.status === 'no_family') {
    if (await resolveVerifiedChannelByPhone(database, phone)) {
      await attachRosterToFamily(database, { phoneE164: phone, now: ports.now });
      roster = await readRosterByChat(database, message.chatId);
      if (!roster || roster.status === 'no_family') return NOT_HANDLED;
    } else {
      const said = await sayNoFamilyYet(database, { chatId: message.chatId, ...ports });
      return handled(said.outcome, 'ignored', 'notice' in said ? { notice: said.notice } : {});
    }
  }
  if (roster.status === 'mixed_family') return handled('roster_mixed_family', 'ignored');
  if (
    roster.status !== 'roles_proposed' &&
    roster.status !== 'partial' &&
    roster.status !== 'confirmed'
  ) {
    return NOT_HANDLED;
  }

  let askedNow = false;
  if (roster.status !== 'confirmed' && !roster.askedAt) {
    const asked = await askRoster(database, { chatId: message.chatId, ...ports });
    askedNow = asked.outcome === 'roster_asked';
  }
  const member = await liveRosterMember(database, roster.id, phoneBlindIndex(phone));
  if (member?.status === 'known_parent' || member?.status === 'confirmed') return NOT_HANDLED;
  if (askedNow) return handled('roster_asked', 'intake');
  if (!member || member.status === 'proposed') {
    const asked = await askMember(database, { chatId: message.chatId, phone, ...ports });
    return handled(asked.outcome, 'intake', 'notice' in asked ? { notice: asked.notice } : {});
  }
  if (member.status !== 'asked' && member.status !== 'reasked') {
    return handled('roster_member_settled', 'ignored');
  }

  const reading = await readRosterReplyWithClassifier(message.text, ports.classifier);
  const reply = { messageId: message.messageId, text: message.text };
  if (reading.kind === 'unclear') {
    if (member.status === 'reasked') return handled('role_unclear_final', 'ignored');
    const notice = await reaskRole(database, { roster, member, reply, ...ports });
    return handled('role_unclear', 'intake', { notice });
  }
  const word = roleWordFor(reading);
  if (!word) {
    const declined = await declineRosterMember(database, {
      rosterMemberId: member.id,
      status: reading.role === 'not_family' ? 'not_family' : 'declined',
      now: ports.now,
    });
    return handled('role_declined', 'ignored', {
      status: declined.outcome === 'declined' ? declined.status : null,
    });
  }

  const seated = await seatConfirmedMember(database, {
    rosterMemberId: member.id,
    reading:
      reading.role === 'parent'
        ? { role: 'parent', parentRole: reading.parentRole }
        : { role: reading.role as 'grandparent' | 'nanny' | 'babysitter', parentRole: null },
    verbatimReply: message.text,
    now: ports.now,
  });
  if (seated.outcome === 'seat_refused') {
    return handled('seat_refused', 'ignored', { reason: seated.reason });
  }
  if (seated.outcome !== 'seated') return handled(seated.outcome, 'ignored');
  if (roster.familyId) {
    await ports.recordInbound(message, { familyId: roster.familyId, userId: seated.userId });
  }
  const notice = await acknowledgeRole(database, {
    roster,
    member,
    role: word,
    name: await firstName(database, seated.userId),
    reply,
    ...ports,
  });
  return handled('role_confirmed', 'intake', { role: seated.role, notice });
}
