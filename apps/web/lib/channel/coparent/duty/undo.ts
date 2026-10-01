import { type Database, schema } from '@hale/db';
import { and, eq, isNull } from 'drizzle-orm';
import { writeFact } from '~/lib/memory/facts';
import { noteDutyBurden } from './burden';
import { projectDutyOnFamilyEvent } from './calendar';
import { spokenFirstName } from './copy';
import { coparentDutyMemoryEnabled } from './flag';
import { recordDutyUndone } from './metrics';
import { type DutyState, commitDutyUpdate, dutyStateFromFact } from './model';

/**
 * Undo overwrites. The previous fact stays, closed by `valid_until` and
 * `superseded_by`. Nothing is deleted.
 */

export type DutyUndo =
  | { kind: 'clear' }
  | { kind: 'reassign'; name: string };

export function readDutyUndo(text: string): DutyUndo | null {
  if (text.includes('?')) return null;
  const line = text
    .trim()
    .replace(/[’]/g, "'")
    .replace(/\s+/g, ' ')
    .replace(/[.!]+$/, '')
    .toLowerCase();
  if (!line) return null;
  if (/^(undo|nvm|nm|never mind|nevermind|scratch that)$/.test(line)) return { kind: 'clear' };
  const match = /^actually,? ([a-z][a-z'.-]*)(?:'s| is) (?:doing|taking) it$/.exec(line);
  const name = match?.[1];
  if (!name) return null;
  return { kind: 'reassign', name: name.charAt(0).toUpperCase() + name.slice(1) };
}

export interface DutyUndoResult {
  status: 'undone' | 'reassigned' | 'skipped';
  reason: string | null;
  factKey: string | null;
  deleted: false;
  spoken: null;
}

function cleared(prior: DutyState): DutyState {
  return {
    ...prior,
    status: 'open',
    attendance: 'unspecified',
    owner: null,
    proposedForUserId: null,
    proposedByUserId: null,
    claims: [],
    namedOwner: null,
  };
}

export async function applyDutyUndo(
  database: Database,
  input: {
    familyId: string;
    actorUserId: string;
    parentCount: number;
    parents: ReadonlyArray<{ userId: string; name: string }>;
    childNames: readonly string[];
    text: string;
    now: Date;
    childId: string | null;
  },
): Promise<DutyUndoResult> {
  const skipped = (reason: string): DutyUndoResult => ({
    status: 'skipped',
    reason,
    factKey: null,
    deleted: false,
    spoken: null,
  });
  if (!coparentDutyMemoryEnabled()) return skipped('flag_off');
  const parsed = readDutyUndo(input.text);
  if (!parsed) return skipped('not_undo');
  if (input.parentCount < 2) return skipped('single_parent');

  const rows = await database
    .select({
      id: schema.familyMemoryFacts.id,
      factKey: schema.familyMemoryFacts.factKey,
      factValue: schema.familyMemoryFacts.factValue,
      validFrom: schema.familyMemoryFacts.validFrom,
      familyId: schema.familyMemoryFacts.familyId,
      validUntil: schema.familyMemoryFacts.validUntil,
    })
    .from(schema.familyMemoryFacts)
    .where(
      and(
        eq(schema.familyMemoryFacts.familyId, input.familyId),
        eq(schema.familyMemoryFacts.factType, 'logistic'),
        isNull(schema.familyMemoryFacts.validUntil),
      ),
    );
  const live = rows.filter(
    (row) =>
      row.familyId === input.familyId &&
      !row.validUntil &&
      row.factKey.startsWith('duty/') &&
      dutyStateFromFact(row.factKey, row.factValue)?.status === 'confirmed',
  );
  if (live.length !== 1) return skipped(live.length === 0 ? 'no_duty' : 'ambiguous');
  const current = live[0];
  if (!current) return skipped('no_duty');
  const prior = dutyStateFromFact(current.factKey, current.factValue);
  if (!prior) return skipped('no_duty');

  if (parsed.kind === 'reassign') {
    const named = spokenFirstName(parsed.name) ?? parsed.name;
    const other = input.parents.find(
      (parent) =>
        parent.userId !== input.actorUserId &&
        spokenFirstName(parent.name)?.toLowerCase() === named.toLowerCase(),
    );
    const self = input.parents.find((parent) => parent.userId === input.actorUserId);
    const selfName = spokenFirstName(self?.name ?? null);
    const slot =
      selfName && selfName.toLowerCase() === named.toLowerCase()
        ? {
            role: prior.role,
            claim: 'self' as const,
            name: null,
            userId: input.actorUserId,
            confidence: 1,
          }
        : other
          ? {
              role: prior.role,
              claim: 'other_parent' as const,
              name: spokenFirstName(other.name),
              userId: other.userId,
              confidence: 1,
            }
          : {
              role: prior.role,
              claim: 'named' as const,
              name: named,
              userId: null,
              confidence: 1,
            };
    const committed = await commitDutyUpdate(database, {
      mode: 'write',
      familyId: input.familyId,
      actorUserId: input.actorUserId,
      parentCount: input.parentCount,
      subjectKey: prior.eventKey,
      eventTitle: prior.kidTitle,
      childNames: input.childNames,
      slot,
      prior,
      source: 'text',
      now: input.now,
      childId: input.childId,
      question: false,
      askWhichKid: false,
    });
    if (committed.written) {
      await recordDutyUndone(database, {
        familyId: input.familyId,
        actorUserId: input.actorUserId,
        factKey: current.factKey,
        recordedAt: current.validFrom,
        now: input.now,
      });
    }
    return {
      status: committed.written ? 'reassigned' : 'skipped',
      reason: committed.written ? null : committed.reason,
      factKey: committed.factKey,
      deleted: false,
      spoken: null,
    };
  }

  const next = cleared(prior);
  const value = {
    schemaVersion: 1 as const,
    kind: 'duty' as const,
    role: prior.role,
    eventKey: prior.eventKey,
    kidTitle: prior.kidTitle,
    status: next.status,
    attendance: next.attendance,
    owner: null,
    proposedForUserId: null,
    proposedByUserId: null,
    claims: [],
    namedByUserId: null,
    source: 'text' as const,
    undoOf: { status: prior.status, owner: prior.owner, at: input.now.toISOString() },
  };
  const write = {
    familyId: input.familyId,
    childId: input.childId,
    factType: 'logistic' as const,
    factKey: current.factKey,
    factValue: value,
    confidence: 1,
    inferredBy: 'coparent_duty_undo',
    validFrom: input.now,
  };
  const audit = {
    familyId: input.familyId,
    actor: input.actorUserId,
    actionTaken: 'duty_memory_undone',
    targetTable: 'family_memory_facts' as const,
    targetId: current.id,
    before: { status: prior.status, owner: prior.owner },
    after: { status: 'open' as const, owner: null, deleted: false as const },
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
  await projectDutyOnFamilyEvent(database, {
    familyId: input.familyId,
    actorUserId: input.actorUserId,
    factKey: current.factKey,
    subjectKey: prior.eventKey,
    state: next,
    now: input.now,
  });
  await noteDutyBurden(database, { familyId: input.familyId, now: input.now });
  await recordDutyUndone(database, {
    familyId: input.familyId,
    actorUserId: input.actorUserId,
    factKey: current.factKey,
    recordedAt: current.validFrom,
    now: input.now,
  });
  return {
    status: 'undone',
    reason: null,
    factKey: current.factKey,
    deleted: false,
    spoken: null,
  };
}
