import { createHash } from 'node:crypto';
import { type Database, schema } from '@hale/db';
import { and, eq, isNull } from 'drizzle-orm';
import {
  classifyKidCalendarItem,
  splitKidEvent,
  titleForStorage,
} from '~/lib/channel/linq/kid-event';
import { CONFIDENCE_FLOOR, writeFact } from '~/lib/memory/facts';
import type { DutyLineKind } from './line-input';
import { rememberDutyEffects } from './memory';

/**
 * VIL-381 — one live duty per (event, role).
 *
 * Legacy `who-takes/…` rows stay readable and are not rewritten. A new duty
 * fact uses a `duty/…` key. A non-kid title is never copied into the key or
 * the value; the key is a hash of the subject instead.
 *
 * A vote that names the other parent is a proposal until that parent confirms.
 * Two parents each saying they will do it is a conflict: the fact records that
 * and does not pick a winner. Undo overwrites; it does not delete.
 */

export type DutyRole = 'dropoff' | 'pickup' | 'attend';

export type DutyClaimName =
  | 'self'
  | 'other_parent'
  | 'named'
  | 'both'
  | 'neither'
  | 'maybe'
  | 'not_me';

export interface DutySlotInput {
  role: DutyRole;
  claim: DutyClaimName;
  name: string | null;
  userId: string | null;
  confidence: number;
}

export type DutyStatus = 'open' | 'proposed' | 'confirmed' | 'conflict' | 'declined';
export type DutyAttendance = 'going' | 'not_going' | 'maybe' | 'unspecified';

export type DutyOwner =
  | { kind: 'parent'; userId: string }
  | { kind: 'named'; name: string }
  | { kind: 'both_parents' };

export interface DutyClaimRecord {
  userId: string;
  claim: 'yes' | 'no' | 'maybe' | 'neither' | 'propose' | 'both';
  targetUserId: string | null;
}

export interface NamedOwner {
  name: string;
  byUserId: string;
}

export interface DutyState {
  role: DutyRole;
  eventKey: string;
  status: DutyStatus;
  attendance: DutyAttendance;
  owner: DutyOwner | null;
  proposedForUserId: string | null;
  proposedByUserId: string | null;
  claims: DutyClaimRecord[];
  namedOwner: NamedOwner | null;
  confidence: number;
  kidTitle: string | null;
}

export interface DutyFactValue {
  schemaVersion: 1;
  kind: 'duty';
  role: DutyRole;
  eventKey: string;
  kidTitle: string | null;
  status: DutyStatus;
  attendance: DutyAttendance;
  owner: DutyOwner | null;
  proposedForUserId: string | null;
  proposedByUserId: string | null;
  claims: DutyClaimRecord[];
  namedByUserId: string | null;
  source: 'poll' | 'text' | 'tapback' | 'llm';
}

export interface ReadableDuty {
  factKey: string;
  legacy: boolean;
  role: DutyRole | 'who_takes';
  status: string;
  ownerUserId: string | null;
  ownerName: string | null;
  attendance: string | null;
  kidTitle: string | null;
}

const ROLES = new Set<DutyRole>(['dropoff', 'pickup', 'attend']);

export function needsWhichKid(
  title: string | null | undefined,
  childNames: readonly string[],
): boolean {
  const names = childNames.map((name) => name.trim()).filter((name) => name.length >= 2);
  if (names.length < 2) return false;
  const trimmed = title?.trim() ?? '';
  if (!trimmed) return true;
  return splitKidEvent(trimmed, names) === null;
}

/** Null unless the title is a kid event. Non-kid titles are dropped. */
export function kidTitleForDuty(
  title: string | null | undefined,
  childNames: readonly string[],
): string | null {
  const trimmed = title?.trim() ?? '';
  if (!trimmed) return null;
  if (!classifyKidCalendarItem({ title: trimmed, childNames })) return null;
  return titleForStorage(true, trimmed);
}

export function titleFromWhoTakesKey(factKey: string): string | null {
  const match = /^who-takes\/([^/]+)\/(.+)$/.exec(factKey);
  const title = match?.[2];
  if (!title) return null;
  try {
    return decodeURIComponent(title);
  } catch {
    return null;
  }
}

export function dutyStorage(input: {
  subjectKey: string;
  role: DutyRole;
  title: string | null;
  childNames: readonly string[];
}): { factKey: string; storageEventId: string; kidTitle: string | null } {
  const embedded = titleFromWhoTakesKey(input.subjectKey);
  const embeddedKid = embedded ? kidTitleForDuty(embedded, input.childNames) : null;
  const leaks = embedded !== null && embeddedKid === null;
  const storageEventId = leaks
    ? `h:${createHash('sha256').update(input.subjectKey).digest('hex').slice(0, 16)}`
    : input.subjectKey;
  const kidTitle = kidTitleForDuty(input.title, input.childNames) ?? embeddedKid;
  return {
    factKey: `duty/${encodeURIComponent(storageEventId)}/${input.role}`,
    storageEventId,
    kidTitle,
  };
}

function emptyState(input: {
  slot: DutySlotInput;
  eventKey: string;
  kidTitle: string | null;
}): DutyState {
  return {
    role: input.slot.role,
    eventKey: input.eventKey,
    status: 'open',
    attendance: 'unspecified',
    owner: null,
    proposedForUserId: null,
    proposedByUserId: null,
    claims: [],
    namedOwner: null,
    confidence: input.slot.confidence,
    kidTitle: input.kidTitle,
  };
}

function recompute(state: DutyState): DutyState {
  const yes = state.claims.filter((row) => row.claim === 'yes');
  const both = state.claims.some((row) => row.claim === 'both');
  const neither = state.claims.some((row) => row.claim === 'neither');
  const proposal = [...state.claims]
    .reverse()
    .find((row) => row.claim === 'propose' && row.targetUserId);
  const maybe = state.claims.some((row) => row.claim === 'maybe');
  const cleared: DutyState = {
    ...state,
    owner: null,
    proposedForUserId: null,
    proposedByUserId: null,
    status: 'open',
    attendance: 'unspecified',
  };

  if (state.namedOwner && (yes.length > 0 || both || neither)) {
    return { ...cleared, status: 'conflict' };
  }
  if (state.namedOwner) {
    return {
      ...cleared,
      status: 'confirmed',
      attendance: 'going',
      owner: { kind: 'named', name: state.namedOwner.name },
    };
  }
  if (both && neither) return { ...cleared, status: 'conflict' };
  if (both) {
    return {
      ...cleared,
      status: 'confirmed',
      attendance: 'going',
      owner: { kind: 'both_parents' },
    };
  }
  if (yes.length >= 2) return { ...cleared, status: 'conflict', attendance: 'going' };
  if (yes.length === 1 && neither) return { ...cleared, status: 'conflict' };
  const winner = yes[0];
  if (yes.length === 1 && winner) {
    return {
      ...cleared,
      status: 'confirmed',
      attendance: 'going',
      owner: { kind: 'parent', userId: winner.userId },
    };
  }
  if (neither) return { ...cleared, status: 'declined', attendance: 'not_going' };
  if (proposal?.targetUserId) {
    return {
      ...cleared,
      status: 'proposed',
      proposedForUserId: proposal.targetUserId,
      proposedByUserId: proposal.userId,
    };
  }
  if (maybe) return { ...cleared, attendance: 'maybe' };
  return cleared;
}

export function planDutyUpdate(
  prior: DutyState | null,
  input: {
    actorUserId: string;
    slot: DutySlotInput;
    eventKey: string;
    kidTitle: string | null;
  },
): DutyState {
  const base = prior ?? emptyState(input);
  const claims = base.claims.filter((row) => row.userId !== input.actorUserId);
  let namedOwner = base.namedOwner;
  const nextClaim = (claim: DutyClaimRecord['claim'], targetUserId: string | null) => {
    claims.push({ userId: input.actorUserId, claim, targetUserId });
  };

  switch (input.slot.claim) {
    case 'self':
      nextClaim('yes', null);
      break;
    case 'not_me':
      nextClaim('no', null);
      break;
    case 'maybe':
      nextClaim('maybe', null);
      break;
    case 'neither':
      nextClaim('neither', null);
      namedOwner = null;
      break;
    case 'other_parent': {
      const target = input.slot.userId;
      if (!target || target === input.actorUserId) nextClaim('yes', null);
      else nextClaim('propose', target);
      break;
    }
    case 'both':
      nextClaim('both', null);
      break;
    case 'named':
      if (input.slot.name) namedOwner = { name: input.slot.name, byUserId: input.actorUserId };
      break;
    default:
      break;
  }

  return recompute({
    ...base,
    role: input.slot.role,
    eventKey: input.eventKey,
    kidTitle: input.kidTitle ?? base.kidTitle,
    claims,
    namedOwner,
    confidence: input.slot.confidence,
  });
}

export function planDutyRemoval(prior: DutyState, voterUserId: string): DutyState {
  return recompute({
    ...prior,
    claims: prior.claims.filter((row) => row.userId !== voterUserId),
    namedOwner: prior.namedOwner?.byUserId === voterUserId ? null : prior.namedOwner,
  });
}

/** A remembered who-takes decision is one attend claim, so a second "I'll do it" conflicts. */
export function priorFromLegacyWhoTakes(
  row: {
    factKey: string;
    status: string;
    takerUserId: string | null;
    kid: string | null;
    event: string | null;
  } | null,
  role: DutyRole,
): DutyState | null {
  if (!row || role !== 'attend' || row.status !== 'decided' || !row.takerUserId) return null;
  const kidTitle = row.kid && row.event ? `${row.kid} ${row.event}` : null;
  return planDutyUpdate(null, {
    actorUserId: row.takerUserId,
    slot: {
      role: 'attend',
      claim: 'self',
      name: null,
      userId: row.takerUserId,
      confidence: 1,
    },
    eventKey: row.factKey,
    kidTitle,
  });
}

function asClaims(value: unknown): DutyClaimRecord[] {
  if (!Array.isArray(value)) return [];
  const claims: DutyClaimRecord[] = [];
  for (const row of value) {
    if (!row || typeof row !== 'object') continue;
    const claim = row as Partial<DutyClaimRecord>;
    if (typeof claim.userId !== 'string') continue;
    if (
      claim.claim !== 'yes' &&
      claim.claim !== 'no' &&
      claim.claim !== 'maybe' &&
      claim.claim !== 'neither' &&
      claim.claim !== 'propose' &&
      claim.claim !== 'both'
    ) {
      continue;
    }
    claims.push({
      userId: claim.userId,
      claim: claim.claim,
      targetUserId: typeof claim.targetUserId === 'string' ? claim.targetUserId : null,
    });
  }
  return claims;
}

function asOwner(value: unknown): DutyOwner | null {
  if (!value || typeof value !== 'object') return null;
  const owner = value as Partial<DutyOwner> & { userId?: string; name?: string };
  if (owner.kind === 'both_parents') return { kind: 'both_parents' };
  if (owner.kind === 'parent' && typeof owner.userId === 'string') {
    return { kind: 'parent', userId: owner.userId };
  }
  if (owner.kind === 'named' && typeof owner.name === 'string') {
    return { kind: 'named', name: owner.name };
  }
  return null;
}

export function dutyStateFromFact(factKey: string, value: unknown): DutyState | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Partial<DutyFactValue>;
  if (row.kind !== 'duty' || !row.role || !ROLES.has(row.role)) return null;
  const status = row.status;
  if (
    status !== 'open' &&
    status !== 'proposed' &&
    status !== 'confirmed' &&
    status !== 'conflict' &&
    status !== 'declined'
  ) {
    return null;
  }
  const attendance =
    row.attendance === 'going' ||
    row.attendance === 'not_going' ||
    row.attendance === 'maybe' ||
    row.attendance === 'unspecified'
      ? row.attendance
      : 'unspecified';
  const owner = asOwner(row.owner);
  return {
    role: row.role,
    eventKey: typeof row.eventKey === 'string' ? row.eventKey : factKey,
    status,
    attendance,
    owner,
    proposedForUserId: typeof row.proposedForUserId === 'string' ? row.proposedForUserId : null,
    proposedByUserId: typeof row.proposedByUserId === 'string' ? row.proposedByUserId : null,
    claims: asClaims(row.claims),
    namedOwner:
      owner?.kind === 'named' && typeof row.namedByUserId === 'string'
        ? { name: owner.name, byUserId: row.namedByUserId }
        : null,
    confidence: 1,
    kidTitle: typeof row.kidTitle === 'string' ? row.kidTitle : null,
  };
}

export function readDutyFact(factKey: string, value: unknown): ReadableDuty | null {
  const duty = dutyStateFromFact(factKey, value);
  if (duty) {
    return {
      factKey,
      legacy: false,
      role: duty.role,
      status: duty.status,
      ownerUserId: duty.owner?.kind === 'parent' ? duty.owner.userId : null,
      ownerName: duty.owner?.kind === 'named' ? duty.owner.name : null,
      attendance: duty.attendance,
      kidTitle: duty.kidTitle,
    };
  }
  if (!factKey.startsWith('who-takes/') || !value || typeof value !== 'object') return null;
  const row = value as {
    kind?: string;
    status?: string;
    takerUserId?: string | null;
    kid?: string | null;
    event?: string | null;
  };
  if (row.kind !== 'who_takes') return null;
  if (row.status !== 'open' && row.status !== 'decided' && row.status !== 'declined') return null;
  const kidTitle = row.kid && row.event ? `${row.kid} ${row.event}` : null;
  return {
    factKey,
    legacy: true,
    role: 'who_takes',
    status: row.status,
    ownerUserId: typeof row.takerUserId === 'string' ? row.takerUserId : null,
    ownerName: null,
    attendance: row.status === 'decided' ? 'going' : null,
    kidTitle,
  };
}

export type DutySkipReason =
  | 'single_parent'
  | 'question'
  | 'low_confidence'
  | 'which_kid'
  | 'shadow'
  | 'no_event';

export interface DutyCommitResult {
  written: boolean;
  sent: false;
  reason: DutySkipReason | 'recorded';
  state: DutyState | null;
  /**
   * The question the lane owes the group after this write, as the duty-voice kind the
   * cadence will speak (VIL-413 / VIL-417) — never a sentence. Null when nothing is owed.
   */
  ask: Extract<DutyLineKind, 'which_kid' | 'both_claimed'> | null;
  factKey: string | null;
}

function toFactValue(state: DutyState, source: DutyFactValue['source']): DutyFactValue {
  return {
    schemaVersion: 1,
    kind: 'duty',
    role: state.role,
    eventKey: state.eventKey,
    kidTitle: state.kidTitle,
    status: state.status,
    attendance: state.attendance,
    owner: state.owner,
    proposedForUserId: state.proposedForUserId,
    proposedByUserId: state.proposedByUserId,
    claims: state.claims,
    namedByUserId: state.namedOwner?.byUserId ?? null,
    source,
  };
}

export async function commitDutyUpdate(
  database: Database,
  input: {
    mode: 'shadow' | 'write';
    familyId: string;
    actorUserId: string;
    parentCount: number;
    subjectKey: string;
    eventTitle: string | null;
    childNames: readonly string[];
    slot: DutySlotInput;
    prior: DutyState | null;
    source: DutyFactValue['source'];
    now: Date;
    childId: string | null;
    question: boolean;
    askWhichKid: boolean;
  },
): Promise<DutyCommitResult> {
  const sent = false as const;
  if (input.parentCount < 2) {
    return { written: false, sent, reason: 'single_parent', state: null, ask: null, factKey: null };
  }
  if (input.question) {
    return { written: false, sent, reason: 'question', state: null, ask: null, factKey: null };
  }
  if (input.slot.confidence < CONFIDENCE_FLOOR) {
    return {
      written: false,
      sent,
      reason: 'low_confidence',
      state: null,
      ask: null,
      factKey: null,
    };
  }
  if (!input.subjectKey) {
    return { written: false, sent, reason: 'no_event', state: null, ask: null, factKey: null };
  }
  const stored = dutyStorage({
    subjectKey: input.subjectKey,
    role: input.slot.role,
    title: input.eventTitle,
    childNames: input.childNames,
  });
  if (input.askWhichKid) {
    return {
      written: false,
      sent,
      reason: 'which_kid',
      state: null,
      ask: 'which_kid',
      factKey: null,
    };
  }
  const state = planDutyUpdate(input.prior, {
    actorUserId: input.actorUserId,
    slot: input.slot,
    eventKey: stored.storageEventId,
    kidTitle: stored.kidTitle,
  });
  const ask = state.status === 'conflict' ? ('both_claimed' as const) : null;
  if (input.mode === 'shadow') {
    return { written: false, sent, reason: 'shadow', state, ask, factKey: stored.factKey };
  }

  const value = toFactValue(state, input.source);
  const audit = {
    familyId: input.familyId,
    actor: input.actorUserId,
    actionTaken: 'logistics_decision_recorded',
    targetTable: 'family_memory_facts' as const,
    targetId: input.familyId,
    after: { kind: 'duty' as const, role: state.role, status: state.status, source: input.source },
  };
  const write = {
    familyId: input.familyId,
    childId: input.childId,
    factType: 'logistic' as const,
    factKey: stored.factKey,
    factValue: value,
    confidence: input.slot.confidence,
    inferredBy: 'coparent_duty',
    validFrom: input.now,
  };
  if (typeof database.transaction === 'function') {
    await database.transaction(async (tx) => {
      await tx.insert(schema.auditLog).values(audit);
      await writeFact(tx, write);
    });
  } else {
    await database.insert(schema.auditLog).values(audit);
    await writeFact(database, write);
  }
  await afterDutyWrite(database, {
    familyId: input.familyId,
    actorUserId: input.actorUserId,
    factKey: stored.factKey,
    subjectKey: input.subjectKey,
    state,
    source: input.source,
    now: input.now,
  });
  return { written: true, sent, reason: 'recorded', state, ask, factKey: stored.factKey };
}

export async function commitDutyRemoval(
  database: Database,
  input: {
    mode: 'shadow' | 'write';
    familyId: string;
    actorUserId: string;
    parentCount: number;
    prior: DutyState;
    factKey: string;
    now: Date;
    childId: string | null;
  },
): Promise<DutyCommitResult> {
  const sent = false as const;
  if (input.parentCount < 2) {
    return { written: false, sent, reason: 'single_parent', state: null, ask: null, factKey: null };
  }
  const state = planDutyRemoval(input.prior, input.actorUserId);
  if (input.mode === 'shadow') {
    return { written: false, sent, reason: 'shadow', state, ask: null, factKey: input.factKey };
  }
  const value = toFactValue(state, 'poll');
  const audit = {
    familyId: input.familyId,
    actor: input.actorUserId,
    actionTaken: 'logistics_decision_recorded',
    targetTable: 'family_memory_facts' as const,
    targetId: input.familyId,
    after: {
      kind: 'duty' as const,
      role: state.role,
      status: state.status,
      source: 'poll' as const,
      vote: 'removed' as const,
    },
  };
  const write = {
    familyId: input.familyId,
    childId: input.childId,
    factType: 'logistic' as const,
    factKey: input.factKey,
    factValue: value,
    confidence: 1,
    inferredBy: 'coparent_duty',
    validFrom: input.now,
  };
  if (typeof database.transaction === 'function') {
    await database.transaction(async (tx) => {
      await tx.insert(schema.auditLog).values(audit);
      await writeFact(tx, write);
    });
  } else {
    await database.insert(schema.auditLog).values(audit);
    await writeFact(database, write);
  }
  await afterDutyWrite(database, {
    familyId: input.familyId,
    actorUserId: input.actorUserId,
    factKey: input.factKey,
    subjectKey: input.factKey,
    state,
    source: 'poll',
    now: input.now,
  });
  return { written: true, sent, reason: 'recorded', state, ask: null, factKey: input.factKey };
}

async function afterDutyWrite(
  database: Database,
  input: {
    familyId: string;
    actorUserId: string;
    factKey: string;
    subjectKey: string;
    state: DutyState;
    source: string;
    now: Date;
  },
): Promise<void> {
  try {
    await rememberDutyEffects(database, input);
  } catch (err) {
    console.warn(
      { code: err instanceof Error ? err.name : 'unknown' },
      'duty memory: effects did not land',
    );
  }
}

export async function loadLiveDutyFacts(
  database: Database,
  familyId: string,
): Promise<Array<{ factKey: string; factValue: unknown }>> {
  if (typeof database.select !== 'function') return [];
  const rows = await database
    .select({
      factKey: schema.familyMemoryFacts.factKey,
      factValue: schema.familyMemoryFacts.factValue,
      familyId: schema.familyMemoryFacts.familyId,
      factType: schema.familyMemoryFacts.factType,
      validUntil: schema.familyMemoryFacts.validUntil,
    })
    .from(schema.familyMemoryFacts)
    .where(
      and(
        eq(schema.familyMemoryFacts.familyId, familyId),
        eq(schema.familyMemoryFacts.factType, 'logistic'),
        isNull(schema.familyMemoryFacts.validUntil),
      ),
    );
  return rows
    .filter(
      (row) =>
        row.familyId === familyId &&
        row.factType === 'logistic' &&
        !row.validUntil &&
        (row.factKey.startsWith('duty/') || row.factKey.startsWith('who-takes/')),
    )
    .map((row) => ({ factKey: row.factKey, factValue: row.factValue }));
}

export async function loadReadableDuties(
  database: Database,
  familyId: string,
): Promise<ReadableDuty[]> {
  const rows = await loadLiveDutyFacts(database, familyId);
  return rows
    .map((row) => readDutyFact(row.factKey, row.factValue))
    .filter((row): row is ReadableDuty => row !== null);
}

export async function loadDutyState(
  database: Database,
  familyId: string,
  factKey: string,
): Promise<DutyState | null> {
  const rows = await loadLiveDutyFacts(database, familyId);
  const match = rows.find((row) => row.factKey === factKey);
  if (!match) return null;
  return dutyStateFromFact(match.factKey, match.factValue);
}
