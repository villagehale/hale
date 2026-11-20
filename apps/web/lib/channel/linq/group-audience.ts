import { type Database, schema } from '@hale/db';
import { and, desc, eq, isNotNull, isNull, notInArray } from 'drizzle-orm';
import { sendLinqChatMessage, sendLinqPoll } from '~/lib/channel/outbound-transport';
import { type ContentClass, ROLE_SCOPE } from '~/lib/channel/role-scope';
import { normalizePhoneE164 } from '~/lib/channels/phone';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { linqFromE164 } from './config';
import { type ListChatHandles, isUndefinedTable } from './roster';
import { LinqSendError } from './transport';

/**
 * Group onboarding v2 — what a family group may hear.
 *
 * Everyone in the chat reads every group line, so the group's scope is the narrowest
 * scope in it: the intersection of `ROLE_SCOPE` over every live member. A known parent
 * or a confirmed co-parent brings the parent scope, a confirmed grandparent, nanny or
 * babysitter the caregiver scope, and anyone who has not said who they are, said "not
 * family", stopped, or belongs to another family brings nothing. Only kid lines ever
 * qualify (`GROUP_CONTENT`): health, registration, settings and suggestions stay 1:1
 * even in a chat of parents.
 *
 * Until the roster is `confirmed`, the only group lines are the roster's own (asks,
 * acknowledgements, STOP) and a direct `reply` to someone in the thread. A `confirmed`
 * chat whose scope is empty takes nothing at all. A send that names no content class
 * is refused: a class nobody stated cannot be proved to be in scope. A chat with no
 * roster that no family holds takes a `reply` only.
 *
 * The roster is a cache of who was seated; the chat is the truth. Before a household
 * line, the floor reads the chat's present participants once (`listChatHandles`). Every
 * present handle other than Hale's line must be a live member of this roster by phone
 * hash; an email, an unrostered phone or a failed read holds the line, and the scope is
 * the narrowest role among the people actually present. A read Linq refuses as a fact
 * about this chat, in its own words, is `participants_unreadable`, a durable answer like
 * any other refusal: 404 with Linq's 2001 (no such chat) or 403 with 2005 (not this
 * account's chat). The status alone is not Linq speaking: an edge or WAF page can answer
 * 403 or 404 too. Every other failed read is about Hale's side, the path or the moment (a
 * 401 or no Linq key is Hale's own credential; a 403/404 without Linq's code, a 408, a rate
 * limit, a 5xx, a timeout, a thrown transport error) and is `participants_unverified`, the
 * one verdict queued work waits out.
 * The roster tables are read on every group send, so a missing table is the named
 * `not_migrated` refusal.
 */

export const GROUP_CONTENT: readonly ContentClass[] = [
  'schedule',
  'pickup_duty',
  'event_logistics',
];

/** `reply` answers someone in the thread and carries no household content. */
export type GroupLineClass = ContentClass | 'reply' | 'unclassified';

export type GroupHoldReason =
  | 'not_migrated'
  | 'group_roles_unconfirmed'
  | 'group_audience_empty'
  | 'group_audience_refused'
  | 'participants_unverified'
  | 'participants_unreadable'
  | 'participant_unresolved'
  | 'chat_not_group';

export type GroupAudienceVerdict =
  | { allowed: true; reason: 'not_household_group' | 'in_scope' }
  | { allowed: false; reason: GroupHoldReason };

const GONE: schema.LinqRosterMemberStatus[] = ['left', 'removed'];
const ASKING: readonly schema.LinqGroupRosterStatus[] = ['roles_proposed', 'partial'];

type AudienceMember = {
  status: schema.LinqRosterMemberStatus;
  confirmedRole: schema.LinqRosterConfirmedRole | null;
};

type RosterMember = AudienceMember & { phoneE164Hash: string };

function memberScope(member: AudienceMember): ReadonlySet<ContentClass> {
  if (member.status === 'known_parent') return ROLE_SCOPE.primary_parent;
  if (member.status === 'confirmed' && member.confirmedRole) {
    // Aunt, uncle, and cousin are family. Their 1:1 scope stays empty. In a group
    // they may hear the same kid lines a grandparent hears.
    if (member.confirmedRole === 'extended') return ROLE_SCOPE.grandparent;
    return ROLE_SCOPE[member.confirmedRole];
  }
  return new Set();
}

/** The classes every live member may see. A chat nobody is left in has no audience. */
export function audienceScope(members: readonly AudienceMember[]): Set<ContentClass> {
  if (members.length === 0) return new Set();
  return new Set(
    GROUP_CONTENT.filter((contentClass) =>
      members.every((member) => memberScope(member).has(contentClass)),
    ),
  );
}

export type RosterAudience = {
  rosterId: string;
  familyId: string | null;
  status: schema.LinqGroupRosterStatus;
  members: RosterMember[];
};

export async function readRosterAudience(
  database: Database,
  chatId: string,
): Promise<RosterAudience | null | 'not_migrated'> {
  try {
    const [roster] = await database
      .select({
        id: schema.linqGroupRosters.id,
        familyId: schema.linqGroupRosters.familyId,
        status: schema.linqGroupRosters.status,
      })
      .from(schema.linqGroupRosters)
      .where(eq(schema.linqGroupRosters.chatId, chatId));
    if (!roster) return null;
    const members = await database
      .select({
        status: schema.linqGroupRosterMembers.status,
        confirmedRole: schema.linqGroupRosterMembers.confirmedRole,
        phoneE164Hash: schema.linqGroupRosterMembers.phoneE164Hash,
      })
      .from(schema.linqGroupRosterMembers)
      .where(
        and(
          eq(schema.linqGroupRosterMembers.rosterId, roster.id),
          notInArray(schema.linqGroupRosterMembers.status, GONE),
        ),
      );
    return { rosterId: roster.id, familyId: roster.familyId, status: roster.status, members };
  } catch (err) {
    if (isUndefinedTable(err)) return 'not_migrated';
    throw err;
  }
}

/** `linq_group_sends_held`, once per roster: the household's trail says why the group is quiet. */
async function noteSendsHeld(
  database: Database,
  roster: { rosterId: string; familyId: string },
): Promise<void> {
  const [prior] = await database
    .select({ id: schema.auditLog.id })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.familyId, roster.familyId),
        eq(schema.auditLog.actionTaken, 'linq_group_sends_held'),
        eq(schema.auditLog.targetId, roster.rosterId),
      ),
    )
    .limit(1);
  if (prior) return;
  await database.insert(schema.auditLog).values({
    familyId: roster.familyId,
    actor: 'system',
    actionTaken: 'linq_group_sends_held',
    targetTable: 'linq_group_rosters',
    targetId: roster.rosterId,
    after: { reason: 'group_roles_unconfirmed' },
  });
}

function refused(reason: GroupHoldReason, lineClass: GroupLineClass): GroupAudienceVerdict {
  console.info({ outcome: reason, lineClass }, 'linq group audience: not sent into the group');
  return { allowed: false, reason };
}

/** A consented shared group has no household roster; a plan tally is not household-year content. */
async function liveSharedGroup(database: Database, chatId: string): Promise<boolean> {
  const [join] = await database
    .select({ id: schema.linqMultiFamilyJoins.id })
    .from(schema.linqMultiFamilyJoins)
    .where(
      and(eq(schema.linqMultiFamilyJoins.chatId, chatId), isNull(schema.linqMultiFamilyJoins.leftAt)),
    )
    .limit(1);
  if (join) return true;
  const [plan] = await database
    .select({ id: schema.linqGroupPlans.id })
    .from(schema.linqGroupPlans)
    .where(and(eq(schema.linqGroupPlans.chatId, chatId), isNull(schema.linqGroupPlans.closedAt)))
    .limit(1);
  return Boolean(plan);
}

export async function groupAudienceAllows(
  database: Database,
  chatId: string,
  lineClass: GroupLineClass,
  listChatHandles: ListChatHandles,
): Promise<GroupAudienceVerdict> {
  const roster = await readRosterAudience(database, chatId);
  if (roster === 'not_migrated') return refused('not_migrated', lineClass);

  if (!roster) {
    const [holder] = await database
      .select({ id: schema.families.id })
      .from(schema.families)
      .where(eq(schema.families.linqGroupChatId, chatId))
      .limit(1);
    if (lineClass === 'reply') {
      return { allowed: true, reason: holder ? 'in_scope' : 'not_household_group' };
    }
    if (!holder && lineClass === 'event_logistics' && (await liveSharedGroup(database, chatId))) {
      return { allowed: true, reason: 'not_household_group' };
    }
    return refused('group_roles_unconfirmed', lineClass);
  }

  if (roster.status !== 'confirmed') {
    if (lineClass === 'reply' && ASKING.includes(roster.status)) {
      return { allowed: true, reason: 'in_scope' };
    }
    if (roster.familyId) {
      await noteSendsHeld(database, { rosterId: roster.rosterId, familyId: roster.familyId });
    }
    return refused('group_roles_unconfirmed', lineClass);
  }

  if (lineClass === 'reply') {
    if (audienceScope(roster.members).size === 0) {
      return refused('group_audience_empty', lineClass);
    }
    return { allowed: true, reason: 'in_scope' };
  }
  if (lineClass === 'unclassified' || !GROUP_CONTENT.includes(lineClass)) {
    return refused('group_audience_refused', lineClass);
  }
  return livePresenceAllows(roster.members, chatId, lineClass, listChatHandles);
}

type LiveRead =
  | { ok: true; handles: string[]; isGroup: boolean | null }
  | { ok: false; failure: 'temporary'; status: string; code?: string; httpStatus?: number }
  | { ok: false; failure: 'permanent'; status: string; httpStatus?: number };

/** Linq's own refusals of this chat, by HTTP status: 404 "Chat not found" (2001) and 403
 * "Access denied" (2005, credentials valid, not this account's chat). Both must agree. A 401
 * is Hale's own credential, so it is not here.
 * https://docs.linqapp.com/error/codes/2xxx/2001/
 * https://docs.linqapp.com/channel/imessage/error/codes/2xxx/2005/ */
const CHAT_REFUSALS: ReadonlyMap<number, string> = new Map([
  [404, '2001'],
  [403, '2005'],
]);

async function readPresent(chatId: string, listChatHandles: ListChatHandles): Promise<LiveRead> {
  try {
    const read = await listChatHandles({ chatId });
    if (read.status === 'ok') return { ok: true, handles: read.handles, isGroup: read.isGroup };
    if (read.status === 'refused' && CHAT_REFUSALS.get(read.httpStatus) === read.code) {
      return { ok: false, failure: 'permanent', status: read.status, httpStatus: read.httpStatus };
    }
    if (read.status === 'refused') {
      const { status, code, httpStatus } = read;
      return { ok: false, failure: 'temporary', status, code, httpStatus };
    }
    return { ok: false, failure: 'temporary', status: read.status };
  } catch (err) {
    // A thrown refusal (a Preview capture run among them) never settles queued work.
    if (err instanceof LinqSendError) {
      return { ok: false, failure: 'temporary', status: 'threw', code: err.code };
    }
    throw err;
  }
}

async function livePresenceAllows(
  members: readonly RosterMember[],
  chatId: string,
  lineClass: ContentClass,
  listChatHandles: ListChatHandles,
): Promise<GroupAudienceVerdict> {
  const startedAt = Date.now();
  const read = await readPresent(chatId, listChatHandles);
  const readMs = Date.now() - startedAt;
  if (!read.ok && read.failure === 'permanent') {
    console.info(
      {
        outcome: 'participants_unreadable',
        lineClass,
        status: read.status,
        httpStatus: read.httpStatus,
        readMs,
      },
      'linq group audience: live participants read',
    );
    return { allowed: false, reason: 'participants_unreadable' };
  }
  if (!read.ok) {
    console.info(
      {
        outcome: 'participants_unverified',
        lineClass,
        status: read.status,
        code: read.code,
        httpStatus: read.httpStatus,
        readMs,
      },
      'linq group audience: live participants read',
    );
    return { allowed: false, reason: 'participants_unverified' };
  }

  const from = linqFromE164();
  const haleLine = from ? normalizePhoneE164(from) : null;
  const byHash = new Map(members.map((member) => [member.phoneE164Hash, member]));
  const matched = new Map<string, RosterMember>();
  let present = 0;
  let unresolved = 0;
  for (const handle of new Set(read.handles)) {
    const phone = normalizePhoneE164(handle);
    if (phone && phone === haleLine) continue;
    present += 1;
    const member = phone ? byHash.get(phoneBlindIndex(phone)) : undefined;
    if (!member) unresolved += 1;
    else matched.set(member.phoneE164Hash, member);
  }

  const verdict = presenceVerdict(read.isGroup, unresolved, [...matched.values()], lineClass);
  console.info(
    { outcome: verdict.reason, lineClass, present, unresolved, readMs },
    'linq group audience: live participants read',
  );
  return verdict;
}

function presenceVerdict(
  isGroup: boolean | null,
  unresolved: number,
  matched: readonly RosterMember[],
  lineClass: ContentClass,
): GroupAudienceVerdict {
  if (isGroup === false) return { allowed: false, reason: 'chat_not_group' };
  if (unresolved > 0) return { allowed: false, reason: 'participant_unresolved' };
  const scope = audienceScope(matched);
  if (scope.size === 0) return { allowed: false, reason: 'group_audience_empty' };
  if (!scope.has(lineClass)) return { allowed: false, reason: 'group_audience_refused' };
  return { allowed: true, reason: 'in_scope' };
}

const FLOOR_PASS: unique symbol = Symbol('floor-pass');
/** Every pass `chatFloorAllows` minted. A copy (a spread with another class) is not one. */
const ISSUED = new WeakSet<FloorPass>();

/**
 * What `chatFloorAllows` hands back when a line may enter `chatId`. The floored sends
 * below take nothing else, so a sender that may address a 1:1 or a group cannot decide
 * the audience itself. Only a pass this module minted is honoured: a cast, or a copy
 * with another chat or class written in, is refused at send time. A pass is good for one
 * chat and the one class it was asked for: a `reply` pass from an unclaimed chat cannot
 * carry a household line.
 */
export type FloorPass = {
  readonly chatId: string;
  readonly lineClass: GroupLineClass;
  readonly [FLOOR_PASS]: true;
};

export type FloorPassRefusal = 'pass_forged' | 'pass_wrong_chat' | 'pass_wrong_class';

/** A floored send that was not given a pass for this chat and this class. Nothing was sent. */
export class FloorPassRefused extends Error {
  constructor(readonly reason: FloorPassRefusal) {
    super(`linq floor: no pass from chatFloorAllows for this send (${reason})`);
    this.name = 'FloorPassRefused';
  }
}

export type ChatFloorVerdict =
  | {
      allowed: true;
      reason: 'direct' | Extract<GroupAudienceVerdict, { allowed: true }>['reason'];
      pass: FloorPass;
    }
  | Extract<GroupAudienceVerdict, { allowed: false }>;

/**
 * The floor for a sender that may address a 1:1 or a group. It skips the floor only when
 * the chat is provably the recipient's own 1:1: Linq said `is_group: false` on that
 * recipient's own inbound in this chat (`channel_messages.in_group`), and never `true`.
 * Household rows that are absent, or a caller's label, are not proof, so every other chat
 * (unclaimed, multi-family, not yet rostered, never recorded) goes through
 * {@link groupAudienceAllows} and is held unless it passes.
 */
export async function chatFloorAllows(
  database: Database,
  input: {
    chatId: string;
    recipientUserId: string;
    lineClass: GroupLineClass;
    listChatHandles: ListChatHandles;
  },
): Promise<ChatFloorVerdict> {
  const [recorded] = await database
    .select({ inGroup: schema.channelMessages.inGroup })
    .from(schema.channelMessages)
    .where(
      and(
        eq(schema.channelMessages.parentUserId, input.recipientUserId),
        eq(schema.channelMessages.providerChatId, input.chatId),
        eq(schema.channelMessages.direction, 'in'),
        isNotNull(schema.channelMessages.inGroup),
      ),
    )
    .orderBy(desc(schema.channelMessages.inGroup))
    .limit(1);
  const pass: FloorPass = Object.freeze({
    chatId: input.chatId,
    lineClass: input.lineClass,
    [FLOOR_PASS]: true as const,
  });
  ISSUED.add(pass);
  if (recorded?.inGroup === false) return { allowed: true, reason: 'direct', pass };
  const verdict = await groupAudienceAllows(
    database,
    input.chatId,
    input.lineClass,
    input.listChatHandles,
  );
  return verdict.allowed ? { ...verdict, pass } : verdict;
}

function requirePass(pass: FloorPass, chatId: string, lineClass: GroupLineClass): void {
  const reason: FloorPassRefusal | null = !ISSUED.has(pass)
    ? 'pass_forged'
    : pass.chatId !== chatId
      ? 'pass_wrong_chat'
      : pass.lineClass !== lineClass
        ? 'pass_wrong_class'
        : null;
  if (!reason) return;
  console.warn(
    { outcome: 'floor_pass_refused', reason, lineClass, passClass: pass.lineClass },
    'linq floor: refused a send without its pass, nothing sent',
  );
  throw new FloorPassRefused(reason);
}

/** `lineClass` is the class of what this send carries, and must be the one the pass was given for. */
export async function sendFlooredChatMessage(
  pass: FloorPass,
  lineClass: GroupLineClass,
  input: Parameters<typeof sendLinqChatMessage>[0],
): ReturnType<typeof sendLinqChatMessage> {
  requirePass(pass, input.chatId, lineClass);
  return sendLinqChatMessage(input);
}

export async function sendFlooredPoll(
  pass: FloorPass,
  lineClass: GroupLineClass,
  input: Parameters<typeof sendLinqPoll>[0],
): ReturnType<typeof sendLinqPoll> {
  requirePass(pass, input.chatId, lineClass);
  return sendLinqPoll(input);
}
