import { type Database, schema } from '@hale/db';
import { eq, inArray } from 'drizzle-orm';
import { dutyAssigneeIds } from '~/lib/channel/linq/group-members';
import { loadRememberedLogistics } from '~/lib/channel/linq/logistics-poll';
import { coparentDutyAsksActive, coparentDutyAsksArmed } from './flag';
import type { DutyExtractor } from './interpret';
import { interpretDutyReply } from './interpret';
import {
  type DutyFactValue,
  type DutyState,
  commitDutyRemoval,
  commitDutyUpdate,
  loadDutyState,
  priorFromLegacyWhoTakes,
  titleFromWhoTakesKey,
} from './model';
import { type DutyParent, type DutySlot, slotFromPollChoice } from './parse';

/**
 * VIL-381 shadow mode. Parse and log. No duty-fact write, no send.
 *
 * The legacy who-takes writer is not called from here. Flag off returns
 * before any read, so the inbound door does no extra work.
 */

export interface DutyShadowInput {
  familyId: string;
  actorUserId: string;
  source: DutyFactValue['source'] | 'poll_vote_removed';
  text: string;
  tapback: string | null;
  choiceKind: string | null;
  choiceValue: string | null;
  subjectKey: string | null;
  now: Date;
  extract?: DutyExtractor;
}

export interface DutyShadowLog {
  shadow: 'coparent_duty';
  familyId: string;
  source: DutyShadowInput['source'];
  mode: 'shadow';
  wrote: false;
  sent: false;
  skipped: 'single_parent' | null;
  llm: 'rules' | 'used' | 'not_configured';
  question: boolean;
  askWhichKid: boolean;
  conflict: boolean;
  proposal: boolean;
  voteChanged: boolean;
  voteRemoved: boolean;
  writable: boolean;
  reason: string | null;
  slots: Array<{ role: string; claim: string; confidence: number }>;
}

type Log = Pick<Console, 'info' | 'warn'>;

async function household(
  database: Database,
  familyId: string,
): Promise<{ parents: DutyParent[]; childNames: string[]; parentCount: number }> {
  const parentIds = await dutyAssigneeIds(database, familyId);
  const people =
    parentIds.length === 0
      ? []
      : await database
          .select({ id: schema.users.id, name: schema.users.name })
          .from(schema.users)
          .where(inArray(schema.users.id, parentIds));
  const parents = parentIds.map((userId) => ({
    userId,
    name: people.find((row) => row.id === userId)?.name ?? '',
  }));
  const children = await database
    .select({ name: schema.children.name, familyId: schema.children.familyId })
    .from(schema.children)
    .where(eq(schema.children.familyId, familyId));
  const childNames = children
    .filter((row) => row.familyId === familyId && row.name)
    .map((row) => row.name);
  return { parents, childNames, parentCount: parentIds.length };
}

function slotLog(slots: readonly DutySlot[]): DutyShadowLog['slots'] {
  return slots.map((row) => ({ role: row.role, claim: row.claim, confidence: row.confidence }));
}

function logShadow(log: Log, fields: DutyShadowLog): void {
  log.info(fields, 'coparent duty shadow');
}

async function priorFor(
  database: Database,
  familyId: string,
  subjectKey: string | null,
  role: DutySlot['role'],
  factKey: string | null,
): Promise<{ prior: DutyState | null; legacyTaker: string | null }> {
  const stored = factKey ? await loadDutyState(database, familyId, factKey) : null;
  if (stored) return { prior: stored, legacyTaker: null };
  if (!subjectKey || role !== 'attend') return { prior: null, legacyTaker: null };
  const remembered = await loadRememberedLogistics(database, familyId);
  const legacy = remembered.find((row) => row.factKey === subjectKey && row.kind === 'who_takes');
  return {
    prior: priorFromLegacyWhoTakes(
      legacy
        ? {
            factKey: legacy.factKey,
            status: legacy.status,
            takerUserId: legacy.takerUserId,
            kid: legacy.kid,
            event: legacy.event,
          }
        : null,
      role,
    ),
    legacyTaker: legacy?.takerUserId ?? null,
  };
}

export async function shadowCoparentDuty(
  database: Database,
  log: Log,
  input: DutyShadowInput,
): Promise<DutyShadowLog | null> {
  if (!coparentDutyAsksArmed() || !coparentDutyAsksActive(input.familyId)) return null;
  const home = await household(database, input.familyId);
  if (home.parentCount < 2) {
    const fields: DutyShadowLog = {
      shadow: 'coparent_duty',
      familyId: input.familyId,
      source: input.source,
      mode: 'shadow',
      wrote: false,
      sent: false,
      skipped: 'single_parent',
      llm: 'not_configured',
      question: false,
      askWhichKid: false,
      conflict: false,
      proposal: false,
      voteChanged: false,
      voteRemoved: input.source === 'poll_vote_removed',
      writable: false,
      reason: 'single_parent',
      slots: [],
    };
    logShadow(log, fields);
    return fields;
  }

  let subjectKey = input.subjectKey;
  if (!subjectKey && (input.source === 'text' || input.source === 'tapback')) {
    const remembered = await loadRememberedLogistics(database, input.familyId);
    const who = remembered.filter((row) => row.kind === 'who_takes');
    if (who.length === 1) subjectKey = who[0]?.factKey ?? null;
  }
  const title = subjectKey ? titleFromWhoTakesKey(subjectKey) : null;
  const removed = input.source === 'poll_vote_removed';

  if (removed) {
    const removalSlot = input.choiceKind
      ? slotFromPollChoice({
          voterUserId: input.actorUserId,
          choiceKind: input.choiceKind,
          choiceValue: input.choiceValue,
          parents: home.parents,
        })
      : null;
    const dutyPrior = subjectKey ? await loadDutyState(database, input.familyId, subjectKey) : null;
    const removedState = dutyPrior
      ? (
          await commitDutyRemoval(database, {
            mode: 'shadow',
            familyId: input.familyId,
            actorUserId: input.actorUserId,
            parentCount: home.parentCount,
            prior: dutyPrior,
            factKey: subjectKey ?? '',
            now: input.now,
            childId: null,
          })
        ).state
      : null;
    const fields: DutyShadowLog = {
      shadow: 'coparent_duty',
      familyId: input.familyId,
      source: input.source,
      mode: 'shadow',
      wrote: false,
      sent: false,
      skipped: null,
      llm: 'rules',
      question: false,
      askWhichKid: false,
      conflict: removedState?.status === 'conflict',
      proposal: removalSlot?.claim === 'other_parent' || removedState?.status === 'proposed',
      voteChanged: false,
      voteRemoved: true,
      writable: false,
      reason: 'shadow',
      slots: removalSlot ? slotLog([removalSlot]) : [],
    };
    logShadow(log, fields);
    return fields;
  }

  const pollSlot =
    input.choiceKind && !input.tapback
      ? slotFromPollChoice({
          voterUserId: input.actorUserId,
          choiceKind: input.choiceKind,
          choiceValue: input.choiceValue,
          parents: home.parents,
        })
      : null;

  const interpreted = pollSlot
    ? null
    : await interpretDutyReply(
        {
          text: input.text,
          tapback: input.tapback,
          speakerUserId: input.actorUserId,
          parents: home.parents,
          askedRole: subjectKey ? 'attend' : null,
          childNames: home.childNames,
          eventTitle: title,
        },
        input.extract,
      );
  const slots = pollSlot ? [pollSlot] : (interpreted?.slots ?? []);
  const question = interpreted?.question ?? false;
  const askWhichKid = interpreted?.askWhichKid ?? false;
  const llm = pollSlot ? 'rules' : (interpreted?.llm ?? 'not_configured');

  let conflict = false;
  let proposal = slots.some((row) => row.claim === 'other_parent');
  let voteChanged = false;
  let reason: string | null =
    interpreted && !pollSlot && !interpreted.write ? interpreted.method : null;
  const first = slots[0];
  if (first && subjectKey) {
    const { prior, legacyTaker } = await priorFor(
      database,
      input.familyId,
      subjectKey,
      first.role,
      null,
    );
    const committed = await commitDutyUpdate(database, {
      mode: 'shadow',
      familyId: input.familyId,
      actorUserId: input.actorUserId,
      parentCount: home.parentCount,
      subjectKey,
      eventTitle: title,
      childNames: home.childNames,
      slot: first,
      prior,
      source: input.source === 'poll_vote_removed' ? 'poll' : input.source,
      now: input.now,
      childId: null,
      question,
      askWhichKid,
    });
    conflict = committed.state?.status === 'conflict';
    proposal = committed.state?.status === 'proposed' || proposal;
    reason = committed.reason;
    const nextOwner = committed.state?.owner;
    const sameTaker =
      committed.state?.status === 'confirmed' &&
      nextOwner?.kind === 'parent' &&
      nextOwner.userId === legacyTaker;
    voteChanged = Boolean(legacyTaker && !sameTaker);
    if (slots.length > 1) {
      const second = slots[1];
      if (second) {
        const extra = await commitDutyUpdate(database, {
          mode: 'shadow',
          familyId: input.familyId,
          actorUserId: input.actorUserId,
          parentCount: home.parentCount,
          subjectKey,
          eventTitle: title,
          childNames: home.childNames,
          slot: second,
          prior: null,
          source: input.source === 'poll_vote_removed' ? 'poll' : input.source,
          now: input.now,
          childId: null,
          question,
          askWhichKid,
        });
        if (extra.state?.status === 'conflict') conflict = true;
      }
    }
  }

  const fields: DutyShadowLog = {
    shadow: 'coparent_duty',
    familyId: input.familyId,
    source: input.source,
    mode: 'shadow',
    wrote: false,
    sent: false,
    skipped: null,
    llm: llm === 'rules' || llm === 'used' || llm === 'not_configured' ? llm : 'not_configured',
    question,
    askWhichKid,
    conflict,
    proposal,
    voteChanged,
    voteRemoved: false,
    writable: reason === 'shadow',
    reason,
    slots: slotLog(slots),
  };
  logShadow(log, fields);
  return fields;
}

/** A tapback counts only when it lands on a who-takes poll. Other reactions stay acks. */
export async function shadowTapbackIfDuty(
  database: Database,
  log: Log,
  input: {
    familyId: string;
    actorUserId: string;
    messageId: string;
    reactionType: string | null;
    now: Date;
  },
): Promise<void> {
  if (!coparentDutyAsksArmed() || !input.reactionType) return;
  const rows = await database
    .select({
      familyId: schema.linqPollOptions.familyId,
      providerMessageId: schema.linqPollOptions.providerMessageId,
      pollKind: schema.linqPollOptions.pollKind,
      subjectKey: schema.linqPollOptions.subjectKey,
    })
    .from(schema.linqPollOptions)
    .where(eq(schema.linqPollOptions.providerMessageId, input.messageId));
  const match = rows.find(
    (row) =>
      row.familyId === input.familyId &&
      row.providerMessageId === input.messageId &&
      row.pollKind === 'who_takes' &&
      row.subjectKey,
  );
  if (!match?.subjectKey) return;
  await shadowWhenArmed(database, log, {
    familyId: input.familyId,
    actorUserId: input.actorUserId,
    source: 'tapback',
    text: '',
    tapback: input.reactionType,
    choiceKind: null,
    choiceValue: null,
    subjectKey: match.subjectKey,
    now: input.now,
  });
}

export async function shadowWhenArmed(
  database: Database,
  log: Log,
  input: DutyShadowInput,
): Promise<void> {
  if (!coparentDutyAsksArmed()) return;
  try {
    await shadowCoparentDuty(database, log, input);
  } catch (err) {
    log.warn(
      { code: err instanceof Error ? err.name : 'unknown', shadow: 'coparent_duty' },
      'coparent duty shadow failed',
    );
  }
}
