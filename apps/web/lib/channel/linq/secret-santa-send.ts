import { type Database, schema } from '@hale/db';
import { isEnabled } from '@hale/flags';
import { and, eq, inArray, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
import { isGarbledRefusal } from '~/lib/channel/garbled-refusal';
import { householdTimezone, knownTimezone } from '~/lib/channel/household-timezone';
import { isParentHeld, isSenderHeld } from '~/lib/channel/intake/opt-out-hold';
import { proactiveQuietNow } from '~/lib/channel/outbound-gate';
import { readLineHold } from '~/lib/channel/proactive/review';
import { acceptSpokenLine } from '~/lib/channel/spoken-line';
import { errorLabel } from '~/lib/channel/proactive/queue';
import { normalizePhoneE164 } from '~/lib/channels/phone';
import { resolveSendablePhone, resolveVerifiedChannelByHash } from '~/lib/channels/sms-consent-core';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { type OneToOneSend, defaultOneToOneSend, sendOneToOne } from './connect-link-1to1';
import type { deliverShared } from './multi-family';
import {
  SANTA_DONE_TEMPLATE,
  type SecretSantaLineWriter,
  composeSantaDoneLine,
  foldName,
  nameAppears,
  secretSantaEnabled,
} from './secret-santa';
import { clearPairing, receiverForGiver } from './secret-santa-pairings';
import { LinqSendError } from './transport';

/**
 * VIL-686 — each giver's draw, sent 1:1 and never in the group.
 *
 * One sender (`sendDrawLine`) for every draw text. Its recipient is a discriminated
 * union, never a nullable user: a customer resolved from the giver's own number at send
 * time (never from the shared-chat people row's family or user, and never a fallback to
 * anyone else's parent), or a reply in the chat the giver themselves just texted. A giver
 * Hale cannot reach is HELD with a named reason; nothing is sent to anyone else.
 *
 * A draw text answers the giver's own "I'm in", so it is a requested message, and it still
 * passes the CASL gate: a verified, unrevoked channel (or the giver's own live 1:1 turn),
 * no opt-out held, a healthy line, and daytime in the giver's zone for the sweep.
 *
 * Every gate runs before the pointer is decrypted or a word is drafted.
 */

export const SANTA_DRAW_TEMPLATE = 'linq:secret_santa_draw';
export const SANTA_NOTE_TEMPLATE = 'linq:secret_santa_note';
/**
 * Linq line protection: at most this many NEW 1:1 chats are opened per sweep, so a draw in
 * a big group never bursts the sending line. Keyed to the provider, never to what one
 * person receives; the rest go on the next pass.
 */
export const SANTA_NEW_CHATS_PER_SWEEP = 5;
/** A transient failure or an unwritten line is retried this many times, then named. */
export const SANTA_MAX_ATTEMPTS = 6;
/** A claim older than this with no delivery may have landed: never resent automatically. */
export const SANTA_CLAIM_STUCK_MS = 15 * 60_000;
/** The sweep backstops a lost done line only this long after the draw. */
const DONE_BACKSTOP_MS = 24 * 3_600_000;

type HeldReason = schema.SecretSantaHeldReason;

export type DrawRecipient =
  | { kind: 'customer'; userId: string; familyId: string }
  | { kind: 'reply'; send: (body: string) => Promise<{ providerMessageId: string }> };

export type DrawSendOutcome =
  | { outcome: 'delivered' }
  | { outcome: 'already_delivered' }
  | { outcome: 'in_flight' }
  | { outcome: 'paced' }
  | { outcome: 'flag_off' }
  | { outcome: 'held'; reason: HeldReason };

export interface SantaSendPorts {
  writer: SecretSantaLineWriter | null;
  oneToOne?: OneToOneSend;
}

function santaLive(): boolean {
  return secretSantaEnabled() && isEnabled('voice');
}

async function hold(database: Database, participantId: string, reason: HeldReason) {
  await database
    .update(schema.secretSantaParticipants)
    .set({ heldReason: reason })
    .where(eq(schema.secretSantaParticipants.id, participantId));
}

async function releaseClaim(database: Database, participantId: string, reason: HeldReason) {
  await database
    .update(schema.secretSantaParticipants)
    .set({ claimedAt: null, heldReason: reason })
    .where(eq(schema.secretSantaParticipants.id, participantId));
}

/** A drawn draw that can no longer be completed: every giver not yet told is held. */
async function markStale(database: Database, drawId: string, now: Date) {
  await database
    .update(schema.secretSantaDraws)
    .set({
      staleAt: sql`coalesce(${schema.secretSantaDraws.staleAt}, ${now.toISOString()}::timestamptz)`,
    })
    .where(eq(schema.secretSantaDraws.id, drawId));
  await database
    .update(schema.secretSantaParticipants)
    .set({ heldReason: 'draw_stale' })
    .where(
      and(
        eq(schema.secretSantaParticipants.drawId, drawId),
        isNull(schema.secretSantaParticipants.deliveredAt),
      ),
    );
}

async function hasRevokedChannel(database: Database, hash: string): Promise<boolean> {
  const [row] = await database
    .select({ id: schema.parentChannels.id })
    .from(schema.parentChannels)
    .where(
      and(eq(schema.parentChannels.phoneE164Hash, hash), isNotNull(schema.parentChannels.revokedAt)),
    )
    .limit(1);
  return Boolean(row);
}

/** By the giver's own number: a customer, a number that stopped Hale, or nobody yet. */
export async function resolveDrawRecipient(
  database: Database,
  phoneHash: string,
): Promise<{ kind: 'customer'; userId: string; familyId: string } | 'opted_out' | 'not_texted_hale'> {
  const channel = await resolveVerifiedChannelByHash(database, phoneHash);
  if (channel) return { kind: 'customer', userId: channel.userId, familyId: channel.familyId };
  return (await hasRevokedChannel(database, phoneHash)) ? 'opted_out' : 'not_texted_hale';
}

async function zoneOf(database: Database, userId: string, familyId: string): Promise<string> {
  const [user] = await database
    .select({ timezone: schema.users.timezone })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  return knownTimezone(user?.timezone) ?? (await householdTimezone(database, familyId));
}

/** Quiet hours in the person's own zone (else their household's), Florida's 20:00 included. */
export async function santaQuietNow(
  database: Database,
  recipient: { userId: string; familyId: string },
  now: Date,
): Promise<boolean> {
  return proactiveQuietNow({
    now,
    timeZone: await zoneOf(database, recipient.userId, recipient.familyId),
    phone: () => resolveSendablePhone(database, recipient.userId),
  });
}

/** No earlier 1:1 from Hale to this person: the first one says who Hale is. */
async function firstOneToOne(database: Database, userId: string): Promise<boolean> {
  const messages = schema.channelMessages;
  const [prior] = await database
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.parentUserId, userId),
        eq(messages.direction, 'out'),
        ne(messages.status, 'failed'),
        sql`(${messages.providerChatId} IS NULL OR (
          NOT EXISTS (SELECT 1 FROM linq_shared_group_people p WHERE p.chat_id = ${messages.providerChatId})
          AND NOT EXISTS (SELECT 1 FROM families f WHERE f.linq_group_chat_id = ${messages.providerChatId})
        ))`,
      ),
    )
    .limit(1);
  return !prior;
}

async function auditAttempt(
  database: Database,
  input: {
    recipient: DrawRecipient;
    draw: { id: string; organizerFamilyId: string | null; organizerUserId: string | null };
    outcome: string;
  },
): Promise<void> {
  if (input.recipient.kind === 'customer') {
    await database.insert(schema.auditLog).values({
      familyId: input.recipient.familyId,
      actor: input.recipient.userId,
      actionTaken: 'linq_secret_santa_draw_sent',
      targetTable: 'secret_santa_draws',
      targetId: input.draw.id,
      audience: input.recipient.userId,
      after: { outcome: input.outcome },
    });
    return;
  }
  // A guest has no family of their own: the delivery is counted on the draw, never naming
  // the person.
  if (!input.draw.organizerFamilyId) {
    console.warn(
      { outcome: 'secret_santa_audit_no_family', drawId: input.draw.id },
      'secret santa: guest delivery not audited',
    );
    return;
  }
  await database.insert(schema.auditLog).values({
    familyId: input.draw.organizerFamilyId,
    actor: input.draw.organizerUserId ?? 'system',
    actionTaken: 'linq_secret_santa_delivery_counted',
    targetTable: 'secret_santa_draws',
    targetId: input.draw.id,
    after: { outcome: input.outcome, count: 1 },
  });
}

/**
 * A giver's draft goes only when it is non-empty, carries the receiver's name exactly, has
 * no link or contact beyond it, and names nobody else in the draw. A name that is part of
 * the giver's or receiver's own name is skipped, so "Ana Li" never trips on "Ana".
 */
export function giverDraftUsable(
  line: string,
  names: { giver: string; receiver: string; everyone: readonly string[] },
): boolean {
  const body = line.trim();
  if (!body || !body.includes(names.receiver)) return false;
  if (acceptSpokenLine(body, [names.receiver]) === null) return false;
  const own = new Set([foldName(names.giver), foldName(names.receiver)]);
  return !names.everyone.some(
    (other) =>
      !own.has(foldName(other)) &&
      !nameAppears(names.giver, other) &&
      !nameAppears(names.receiver, other) &&
      nameAppears(body, other),
  );
}

interface LoadedGiver {
  id: string;
  drawId: string;
  called: string | null;
  deliveredAt: Date | null;
  claimedAt: Date | null;
  attempts: number;
  heldReason: HeldReason | null;
  stoppedAt: Date | null;
  phoneHash: string;
  draw: {
    id: string;
    status: string;
    staleAt: Date | null;
    language: string | null;
    organizerFamilyId: string | null;
    organizerUserId: string | null;
  };
}

async function loadGiver(database: Database, participantId: string): Promise<LoadedGiver | null> {
  const p = schema.secretSantaParticipants;
  const d = schema.secretSantaDraws;
  const people = schema.linqSharedGroupPeople;
  const [row] = await database
    .select({
      id: p.id,
      drawId: p.drawId,
      called: p.called,
      deliveredAt: p.deliveredAt,
      claimedAt: p.claimedAt,
      attempts: p.attempts,
      heldReason: p.heldReason,
      stoppedAt: people.stoppedAt,
      phoneHash: people.phoneE164Hash,
      drawStatus: d.status,
      staleAt: d.staleAt,
      language: d.language,
      organizerFamilyId: d.organizerFamilyId,
      organizerUserId: d.organizerUserId,
    })
    .from(p)
    .innerJoin(d, eq(d.id, p.drawId))
    .innerJoin(people, eq(people.id, p.personId))
    .where(eq(p.id, participantId))
    .limit(1);
  if (!row) return null;
  return {
    id: row.id,
    drawId: row.drawId,
    called: row.called,
    deliveredAt: row.deliveredAt,
    claimedAt: row.claimedAt,
    attempts: row.attempts,
    heldReason: row.heldReason,
    stoppedAt: row.stoppedAt,
    phoneHash: row.phoneHash,
    draw: {
      id: row.drawId,
      status: row.drawStatus,
      staleAt: row.staleAt,
      language: row.language,
      organizerFamilyId: row.organizerFamilyId,
      organizerUserId: row.organizerUserId,
    },
  };
}

async function everyoneIn(database: Database, drawId: string): Promise<string[]> {
  const rows = await database
    .select({ called: schema.secretSantaParticipants.called })
    .from(schema.secretSantaParticipants)
    .where(eq(schema.secretSantaParticipants.drawId, drawId));
  return rows.flatMap((row) => (row.called ? [row.called] : []));
}

/**
 * Sends one giver their draw, or holds it with a named reason. `path` is `sweep` for the
 * cron (quiet hours apply) or `reply` when the giver just texted Hale 1:1 (a reply to their
 * own text goes now, outbound-gate.ts:300-304). `newChats` is the sweep's pacing budget.
 */
export async function sendDrawLine(
  database: Database,
  input: {
    participantId: string;
    recipient: DrawRecipient;
    path: 'sweep' | 'reply';
    now: Date;
    newChats?: { left: number };
  },
  ports: SantaSendPorts,
): Promise<DrawSendOutcome> {
  if (!santaLive()) return { outcome: 'flag_off' };
  const giver = await loadGiver(database, input.participantId);
  if (!giver) return { outcome: 'held', reason: 'draw_stale' };
  if (giver.deliveredAt) return { outcome: 'already_delivered' };
  if (giver.draw.status !== 'drawn' || giver.draw.staleAt) {
    await hold(database, giver.id, 'draw_stale');
    return { outcome: 'held', reason: 'draw_stale' };
  }
  if (giver.heldReason === 'stopped' || giver.stoppedAt) {
    await hold(database, giver.id, 'stopped');
    return { outcome: 'held', reason: 'stopped' };
  }
  if (giver.claimedAt) {
    if (input.now.getTime() - giver.claimedAt.getTime() < SANTA_CLAIM_STUCK_MS) {
      return { outcome: 'in_flight' };
    }
    await hold(database, giver.id, 'claim_stuck');
    return { outcome: 'held', reason: 'claim_stuck' };
  }
  const recipient = input.recipient;
  if (recipient.kind === 'customer') {
    if (await isParentHeld(database, recipient.userId)) {
      await hold(database, giver.id, 'opt_out_unread');
      return { outcome: 'held', reason: 'opt_out_unread' };
    }
  } else {
    if (await hasRevokedChannel(database, giver.phoneHash)) {
      await hold(database, giver.id, 'opted_out');
      return { outcome: 'held', reason: 'opted_out' };
    }
    if (await isSenderHeld(database, giver.phoneHash)) {
      await hold(database, giver.id, 'opt_out_unread');
      return { outcome: 'held', reason: 'opt_out_unread' };
    }
  }
  if (await readLineHold(database)) {
    await hold(database, giver.id, 'line_held');
    return { outcome: 'held', reason: 'line_held' };
  }
  if (input.path === 'sweep' && recipient.kind === 'customer') {
    if (await santaQuietNow(database, recipient, input.now)) {
      await hold(database, giver.id, 'quiet_hours');
      return { outcome: 'held', reason: 'quiet_hours' };
    }
  }
  const first = recipient.kind === 'reply' ? true : await firstOneToOne(database, recipient.userId);
  if (first && input.newChats && input.newChats.left <= 0) return { outcome: 'paced' };
  if (!giver.called) {
    await hold(database, giver.id, 'draw_stale');
    return { outcome: 'held', reason: 'draw_stale' };
  }

  const p = schema.secretSantaParticipants;
  const [claimed] = await database
    .update(p)
    .set({ claimedAt: input.now, attempts: sql`${p.attempts} + 1` })
    .where(and(eq(p.id, giver.id), isNull(p.deliveredAt), isNull(p.claimedAt)))
    .returning({ id: p.id });
  if (!claimed) return { outcome: 'in_flight' };
  if (first && input.newChats) input.newChats.left -= 1;

  const receiver = await receiverForGiver(database, {
    drawId: giver.drawId,
    giverParticipantId: giver.id,
  });
  if (receiver === 'unresolvable') {
    await database.update(p).set({ claimedAt: null }).where(eq(p.id, giver.id));
    await markStale(database, giver.drawId, input.now);
    return { outcome: 'held', reason: 'draw_stale' };
  }
  const body = ports.writer
    ? await ports.writer.write({
        purpose: 'giver_draw',
        language: giver.draw.language,
        facts: {
          giver: giver.called,
          receiver: receiver.called,
          firstOneToOne: first,
          mayNotBeHaleFamily: recipient.kind === 'reply',
        },
        verbatim: [receiver.called],
      })
    : null;
  if (
    !body ||
    !giverDraftUsable(body, {
      giver: giver.called,
      receiver: receiver.called,
      everyone: await everyoneIn(database, giver.drawId),
    })
  ) {
    await releaseClaim(database, giver.id, 'line_unwritten');
    await auditAttempt(database, { recipient, draw: giver.draw, outcome: 'line_unwritten' });
    console.warn(
      { outcome: 'secret_santa_line_unwritten', drawId: giver.drawId },
      'secret santa: draw not sent',
    );
    return { outcome: 'held', reason: 'line_unwritten' };
  }

  const sent = await sendTo(database, { recipient, body, giver, now: input.now }, ports);
  await auditAttempt(database, {
    recipient,
    draw: giver.draw,
    outcome: sent === 'delivered' ? 'delivered' : sent,
  });
  if (sent === 'delivered') {
    await clearPairing(database, giver.id, input.now);
    return { outcome: 'delivered' };
  }
  if (sent === 'claim_stuck') {
    await hold(database, giver.id, 'claim_stuck');
    return { outcome: 'held', reason: sent };
  }
  // VIL-683 · a garbled line is one the writer did not get right, so the sweep asks it
  // again, as for any unwritten line; the attempt's audit row above names it.
  const reason = sent === 'garbled_text' ? 'line_unwritten' : sent;
  await releaseClaim(database, giver.id, reason);
  return { outcome: 'held', reason };
}

async function sendTo(
  database: Database,
  input: { recipient: DrawRecipient; body: string; giver: LoadedGiver; now: Date },
  ports: SantaSendPorts,
): Promise<
  | 'delivered'
  | 'cannot_open_1to1'
  | 'send_failed'
  | 'claim_stuck'
  | 'not_texted_hale'
  | 'garbled_text'
> {
  const { recipient } = input;
  if (recipient.kind === 'reply') {
    try {
      await recipient.send(input.body);
      return 'delivered';
    } catch (err) {
      if (isGarbledRefusal(err)) return 'garbled_text';
      if (!(err instanceof LinqSendError)) throw err;
      return err.permanent && err.code !== 'not_configured' ? 'cannot_open_1to1' : 'send_failed';
    }
  }
  const to = await resolveSendablePhone(database, recipient.userId);
  if (!to) return 'not_texted_hale';
  const dedupeKey = `${SANTA_DRAW_TEMPLATE}:${input.giver.drawId}:${input.giver.id}`;
  const out = await sendOneToOne(database, {
    familyId: recipient.familyId,
    ledgerUserId: recipient.userId,
    to,
    body: input.body,
    recordBody: false,
    templateKey: SANTA_DRAW_TEMPLATE,
    dedupeKey,
    now: input.now,
    send: ports.oneToOne ?? defaultOneToOneSend(),
  });
  if (out.outcome === 'sent') return 'delivered';
  if (out.outcome === 'garbled_text') return 'garbled_text';
  if (out.outcome === 'already_sent') {
    const [row] = await database
      .select({ providerMessageId: schema.channelMessages.providerMessageId })
      .from(schema.channelMessages)
      .where(eq(schema.channelMessages.dedupeKey, dedupeKey))
      .limit(1);
    return row?.providerMessageId ? 'delivered' : 'claim_stuck';
  }
  return out.permanent && out.code !== 'not_configured' ? 'cannot_open_1to1' : 'send_failed';
}

// ---------------------------------------------------------------------------------------
// The organizer's notes.

type NoteKind = 'missing' | 'stale';

async function sendOrganizerNote(
  database: Database,
  input: {
    draw: schema.SecretSantaDraw;
    kind: NoteKind;
    waiting: { called: string; why: 'needs_to_text_hale' | 'cannot_reach' }[];
    now: Date;
  },
  ports: SantaSendPorts,
): Promise<string> {
  const { draw } = input;
  if (!draw.organizerPersonId) return 'organizer_gone';
  const [organizer] = await database
    .select({
      hash: schema.linqSharedGroupPeople.phoneE164Hash,
      stoppedAt: schema.linqSharedGroupPeople.stoppedAt,
    })
    .from(schema.linqSharedGroupPeople)
    .where(eq(schema.linqSharedGroupPeople.id, draw.organizerPersonId))
    .limit(1);
  if (!organizer || organizer.stoppedAt) return 'organizer_gone';
  const recipient = await resolveDrawRecipient(database, organizer.hash);
  if (recipient === 'opted_out' || recipient === 'not_texted_hale') return recipient;
  if (await isParentHeld(database, recipient.userId)) return 'opt_out_unread';
  if (await readLineHold(database)) return 'line_held';
  if (await santaQuietNow(database, recipient, input.now)) return 'quiet_hours';
  if (!ports.writer) return 'line_unwritten';
  const facts =
    input.kind === 'missing'
      ? { kind: 'missing', waiting: input.waiting }
      : { kind: 'stale' as const };
  const body = await ports.writer.write({
    purpose: 'organizer_note',
    language: draw.language,
    facts,
  });
  const [mine] = await database
    .select({ called: schema.secretSantaParticipants.called })
    .from(schema.secretSantaParticipants)
    .where(
      and(
        eq(schema.secretSantaParticipants.drawId, draw.id),
        eq(schema.secretSantaParticipants.personId, draw.organizerPersonId),
      ),
    )
    .limit(1);
  const allowed = new Set(
    [...input.waiting.map((w) => w.called), ...(mine?.called ? [mine.called] : [])].map(foldName),
  );
  const everyone = await everyoneIn(database, draw.id);
  if (
    !body ||
    acceptSpokenLine(body, []) === null ||
    everyone.some((name) => !allowed.has(foldName(name)) && nameAppears(body, name))
  ) {
    return 'line_unwritten';
  }
  const to = await resolveSendablePhone(database, recipient.userId);
  if (!to) return 'not_texted_hale';
  const out = await sendOneToOne(database, {
    familyId: recipient.familyId,
    ledgerUserId: recipient.userId,
    to,
    body,
    recordBody: false,
    templateKey: SANTA_NOTE_TEMPLATE,
    dedupeKey: `${SANTA_NOTE_TEMPLATE}:${draw.id}:${input.kind}`,
    now: input.now,
    send: ports.oneToOne ?? defaultOneToOneSend(),
  });
  const landed = out.outcome === 'sent' || out.outcome === 'already_sent';
  if (landed) {
    await database
      .update(schema.secretSantaDraws)
      .set(input.kind === 'missing' ? { missingNotedAt: input.now } : { staleNotedAt: input.now })
      .where(eq(schema.secretSantaDraws.id, draw.id));
  }
  await database.insert(schema.auditLog).values({
    familyId: recipient.familyId,
    actor: recipient.userId,
    actionTaken: 'linq_secret_santa_noted',
    targetTable: 'secret_santa_draws',
    targetId: draw.id,
    audience: recipient.userId,
    after: { kind: input.kind, count: input.waiting.length, outcome: out.outcome },
  });
  return out.outcome;
}

// ---------------------------------------------------------------------------------------
// The sweep.

/** Held reasons the sweep never retries on its own. */
const TERMINAL: readonly HeldReason[] = ['claim_stuck', 'stopped', 'draw_stale', 'cannot_open_1to1'];
const RETRIED: readonly HeldReason[] = ['send_failed', 'line_unwritten'];

export interface SantaSweepSummary {
  draws: number;
  delivered: number;
  held: Partial<Record<HeldReason, number>>;
  paced: number;
  doneLines: number;
  notes: number;
}

export interface SantaSweepPorts extends SantaSendPorts {
  /** The group door's claim-first send (multi-family's deliverShared). */
  deliverGroup: typeof deliverShared;
}

export async function runSecretSantaSweep(
  database: Database,
  now: Date,
  ports: SantaSweepPorts,
): Promise<SantaSweepSummary> {
  const summary: SantaSweepSummary = {
    draws: 0,
    delivered: 0,
    held: {},
    paced: 0,
    doneLines: 0,
    notes: 0,
  };
  if (!santaLive()) return summary;
  const d = schema.secretSantaDraws;
  const p = schema.secretSantaParticipants;
  const draws = await database.select().from(d).where(eq(d.status, 'drawn'));
  const newChats = { left: SANTA_NEW_CHATS_PER_SWEEP };
  for (const draw of draws) {
    summary.draws += 1;
    if (draw.staleAt) {
      if (!draw.staleNotedAt) {
        const noted = await guarded(draw.id, () =>
          sendOrganizerNote(database, { draw, kind: 'stale', waiting: [], now }, ports),
        );
        if (noted === 'sent') summary.notes += 1;
      }
      continue;
    }
    if (await guarded(draw.id, () => backstopDoneLine(database, draw, now, ports))) {
      summary.doneLines += 1;
    }

    const givers = await database
      .select({
        id: p.id,
        heldReason: p.heldReason,
        attempts: p.attempts,
        hash: schema.linqSharedGroupPeople.phoneE164Hash,
      })
      .from(p)
      .innerJoin(schema.linqSharedGroupPeople, eq(schema.linqSharedGroupPeople.id, p.personId))
      .where(and(eq(p.drawId, draw.id), isNull(p.deliveredAt)))
      .orderBy(p.joinedAt, p.id);
    for (const giver of givers) {
      if (giver.heldReason && TERMINAL.includes(giver.heldReason)) continue;
      if (
        giver.heldReason &&
        RETRIED.includes(giver.heldReason) &&
        giver.attempts >= SANTA_MAX_ATTEMPTS
      ) {
        continue;
      }
      const resolved = await resolveDrawRecipient(database, giver.hash);
      // A 1:1 STOP held this giver; only a channel they verified since lifts it.
      if (giver.heldReason === 'opted_out' && typeof resolved === 'string') continue;
      if (resolved === 'opted_out' || resolved === 'not_texted_hale') {
        await hold(database, giver.id, resolved);
        summary.held[resolved] = (summary.held[resolved] ?? 0) + 1;
        continue;
      }
      try {
        const out = await sendDrawLine(
          database,
          { participantId: giver.id, recipient: resolved, path: 'sweep', now, newChats },
          ports,
        );
        if (out.outcome === 'delivered') summary.delivered += 1;
        if (out.outcome === 'paced') summary.paced += 1;
        if (out.outcome === 'held') {
          summary.held[out.reason] = (summary.held[out.reason] ?? 0) + 1;
        }
      } catch (err) {
        // The claim stays: the next pass reads it as claim_stuck and never resends.
        console.error(
          { outcome: 'secret_santa_send_threw', drawId: draw.id, err: errorLabel(err) },
          'secret santa: draw send threw',
        );
      }
    }

    const [fresh] = await database.select().from(d).where(eq(d.id, draw.id)).limit(1);
    if (!fresh || fresh.staleAt || fresh.missingNotedAt) continue;
    const waiting = await waitingGivers(database, draw.id);
    if (waiting.length > 0) {
      const noted = await guarded(draw.id, () =>
        sendOrganizerNote(database, { draw: fresh, kind: 'missing', waiting, now }, ports),
      );
      if (noted === 'sent') summary.notes += 1;
    }
  }
  return summary;
}

/**
 * One draw's group line or note must not stop the sweep for every other draw. The claim a
 * send left behind stays (never resent); the log names the draw and the error's label only.
 */
async function guarded<T>(drawId: string, run: () => Promise<T>): Promise<T | 'threw'> {
  try {
    return await run();
  } catch (err) {
    console.error(
      { outcome: 'secret_santa_send_threw', drawId, err: errorLabel(err) },
      'secret santa: sweep step threw',
    );
    return 'threw';
  }
}

/**
 * Givers whose draw has not reached them and will not without help: they have not texted
 * Hale, or Hale could not reach them after every try. A giver who opted out or stopped is
 * left out entirely; quiet hours and a held line are not "missing".
 */
async function waitingGivers(
  database: Database,
  drawId: string,
): Promise<{ called: string; why: 'needs_to_text_hale' | 'cannot_reach' }[]> {
  const p = schema.secretSantaParticipants;
  const rows = await database
    .select({ called: p.called, heldReason: p.heldReason, attempts: p.attempts })
    .from(p)
    .where(and(eq(p.drawId, drawId), isNull(p.deliveredAt)));
  type Waiting = { called: string; why: 'needs_to_text_hale' | 'cannot_reach' };
  return rows.flatMap((row): Waiting[] => {
    if (!row.called) return [];
    if (row.heldReason === 'not_texted_hale') {
      return [{ called: row.called, why: 'needs_to_text_hale' as const }];
    }
    if (
      row.heldReason === 'cannot_open_1to1' ||
      (row.heldReason &&
        RETRIED.includes(row.heldReason) &&
        row.attempts >= SANTA_MAX_ATTEMPTS)
    ) {
      return [{ called: row.called, why: 'cannot_reach' as const }];
    }
    return [];
  });
}

/** The webhook died after the draw committed: the done line goes once, from the sweep. */
async function backstopDoneLine(
  database: Database,
  draw: schema.SecretSantaDraw,
  now: Date,
  ports: SantaSweepPorts,
): Promise<boolean> {
  if (!draw.drawnAt || now.getTime() - draw.drawnAt.getTime() > DONE_BACKSTOP_MS) return false;
  const dedupeKey = `${SANTA_DONE_TEMPLATE}:${draw.id}`;
  const [prior] = await database
    .select({ id: schema.channelMessages.id })
    .from(schema.channelMessages)
    .where(eq(schema.channelMessages.dedupeKey, dedupeKey))
    .limit(1);
  if (prior) return false;
  if (!draw.organizerFamilyId || !draw.organizerUserId) return false;
  const counted = await database
    .select({ id: schema.secretSantaParticipants.id, held: schema.secretSantaParticipants.heldReason })
    .from(schema.secretSantaParticipants)
    .where(eq(schema.secretSantaParticipants.drawId, draw.id));
  const inDraw = counted.filter((row) => row.held !== 'stopped');
  const composed = await composeSantaDoneLine(
    database,
    {
      drawId: draw.id,
      language: draw.language,
      participants: inDraw.length,
      waiting: inDraw.filter((row) => row.held === 'not_texted_hale').length,
    },
    ports.writer,
  );
  if (!('line' in composed)) return false;
  const notice = await ports.deliverGroup(database, {
    chatId: draw.chatId,
    familyId: draw.organizerFamilyId,
    parentUserId: draw.organizerUserId,
    text: composed.line.text,
    templateKey: composed.line.templateKey,
    dedupeKey: composed.line.dedupeKey,
    now,
  });
  return notice === 'sent';
}

// ---------------------------------------------------------------------------------------
// Releases on the giver's own 1:1 text.

const RELEASABLE: readonly HeldReason[] = [
  'not_texted_hale',
  'cannot_open_1to1',
  'quiet_hours',
  'send_failed',
  'line_unwritten',
];

/** Whether this number is in any shared chat at all: one indexed read before any join. */
async function inAnySharedChat(database: Database, phoneHash: string): Promise<boolean> {
  const [row] = await database
    .select({ id: schema.linqSharedGroupPeople.id })
    .from(schema.linqSharedGroupPeople)
    .where(eq(schema.linqSharedGroupPeople.phoneE164Hash, phoneHash))
    .limit(1);
  return Boolean(row);
}

async function owedTo(database: Database, phoneHash: string): Promise<string[]> {
  const p = schema.secretSantaParticipants;
  const d = schema.secretSantaDraws;
  const people = schema.linqSharedGroupPeople;
  const rows = await database
    .select({ id: p.id })
    .from(p)
    .innerJoin(d, eq(d.id, p.drawId))
    .innerJoin(people, eq(people.id, p.personId))
    .where(
      and(
        eq(people.phoneE164Hash, phoneHash),
        isNull(people.stoppedAt),
        eq(d.status, 'drawn'),
        isNull(d.staleAt),
        isNull(p.deliveredAt),
        isNull(p.claimedAt),
        or(isNull(p.heldReason), inArray(p.heldReason, [...RELEASABLE])),
      ),
    );
  return rows.map((row) => row.id);
}

/**
 * Draws waiting on a guest (no Hale channel of their own) whose number just texted Hale.
 * Empty when the flag is off, when the number is a customer (their draws go on the
 * customer path), or when nothing is owed.
 */
export async function owedGuestDraws(database: Database, phoneHash: string): Promise<string[]> {
  if (!santaLive() || !(await inAnySharedChat(database, phoneHash))) return [];
  if (await resolveVerifiedChannelByHash(database, phoneHash)) return [];
  return owedTo(database, phoneHash);
}

/**
 * Intake's turn for a guest who owes nothing but their first text: their draw is the reply,
 * in the chat they just opened, and intake's own greeting does not run on this turn.
 */
export async function answerGuestDraws(
  database: Database,
  input: {
    participantIds: readonly string[];
    reply: (body: string) => Promise<{ providerMessageId: string }>;
    now: Date;
  },
  ports: SantaSendPorts,
): Promise<{ delivered: number; outcomes: string[] }> {
  const outcomes: string[] = [];
  let delivered = 0;
  for (const participantId of input.participantIds) {
    try {
      const out = await sendDrawLine(
        database,
        { participantId, recipient: { kind: 'reply', send: input.reply }, path: 'reply', now: input.now },
        ports,
      );
      if (out.outcome === 'delivered') delivered += 1;
      outcomes.push(out.outcome === 'held' ? out.reason : out.outcome);
    } catch (err) {
      console.error(
        { outcome: 'secret_santa_send_threw', err: errorLabel(err) },
        'secret santa: guest draw send threw',
      );
      outcomes.push('threw');
    }
  }
  return { delivered, outcomes };
}

/**
 * After a customer's own 1:1 turn: anything held for them goes now, as a reply to their
 * text (no quiet-hours wait). Their STOP was processed first: a revoked channel resolves
 * to nobody, so nothing is sent.
 */
export async function releaseHeldDrawsForCustomer(
  database: Database,
  input: { phone: string; now: Date },
  ports: SantaSendPorts,
): Promise<{ delivered: number; outcomes: string[] }> {
  const outcomes: string[] = [];
  if (!santaLive()) return { delivered: 0, outcomes };
  const phone = normalizePhoneE164(input.phone);
  if (!phone) return { delivered: 0, outcomes };
  const hash = phoneBlindIndex(phone);
  if (!(await inAnySharedChat(database, hash))) return { delivered: 0, outcomes };
  const channel = await resolveVerifiedChannelByHash(database, hash);
  if (!channel) return { delivered: 0, outcomes };
  let delivered = 0;
  for (const participantId of await owedTo(database, hash)) {
    try {
      const out = await sendDrawLine(
        database,
        {
          participantId,
          recipient: { kind: 'customer', userId: channel.userId, familyId: channel.familyId },
          path: 'reply',
          now: input.now,
        },
        ports,
      );
      if (out.outcome === 'delivered') delivered += 1;
      outcomes.push(out.outcome === 'held' ? out.reason : out.outcome);
    } catch (err) {
      console.error(
        { outcome: 'secret_santa_send_threw', err: errorLabel(err) },
        'secret santa: released draw send threw',
      );
      outcomes.push('threw');
    }
  }
  return { delivered, outcomes };
}

