import type { Database } from '@hale/db';
import { HALE_RECORD, writeFact } from '~/lib/memory/facts';
import { coparentSplitDutyActive } from './flag';
import { commitDutyUpdate } from './model';
import type { SplitDutyAssignment, SplitDutyEvent, SplitDutyRead } from './split-read';

const OPEN_FACT_KEY = 'duty-ask/open';

/**
 * VIL-661 · record a split-duty answer on each event. One parent's reply can
 * name both drivers. Hale does not invent a driver when the read does not write.
 * The open split question is stepped down so a later change of mind can still
 * land on the same pair.
 */

export async function commitSplitDutyRead(
  database: Database,
  input: {
    familyId: string;
    actorUserId: string;
    parentCount: number;
    childNames: readonly string[];
    events: readonly SplitDutyEvent[];
    read: SplitDutyRead;
    now: Date;
  },
): Promise<{ written: boolean; assignments: SplitDutyAssignment[] }> {
  if (!coparentSplitDutyActive(input.familyId)) {
    return { written: false, assignments: [] };
  }
  if (!input.read.write || input.read.assignments.length === 0) {
    return { written: false, assignments: [] };
  }
  for (const row of input.read.assignments) {
    const event = input.events.find((item) => item.eventKey === row.eventKey);
    const ownerUserId =
      row.claim === 'named' ? input.actorUserId : (row.userId ?? input.actorUserId);
    const committed = await commitDutyUpdate(database, {
      mode: 'write',
      familyId: input.familyId,
      actorUserId: ownerUserId,
      parentCount: input.parentCount,
      subjectKey: row.eventKey,
      eventTitle: event?.label ? `${event.kid ?? ''} ${event.label}`.trim() : (event?.kid ?? null),
      childNames: input.childNames,
      slot: {
        role: row.role,
        claim: row.claim === 'named' ? 'named' : 'self',
        name: row.name,
        userId: row.userId,
        confidence: row.confidence,
      },
      prior: null,
      source: 'llm',
      now: input.now,
      childId: event?.childId ?? null,
      question: false,
      askWhichKid: false,
    });
    if (!committed.written) {
      return { written: false, assignments: [] };
    }
  }
  await writeFact(database, {
    familyId: input.familyId,
    childId: null,
    factType: 'logistic',
    factKey: OPEN_FACT_KEY,
    factValue: {
      schemaVersion: 1,
      kind: 'duty_open_question',
      eventKey: input.read.assignments[0]?.eventKey,
      role: input.read.assignments[0]?.role,
      unanswered: 0,
      silentNamed: false,
      status: 'stepped_down',
      split: true,
      peerEventKey: input.read.assignments[1]?.eventKey ?? null,
    },
    confidence: 1,
    inferredBy: 'coparent_split_duty',
    heard: HALE_RECORD,
    validFrom: input.now,
  });
  return { written: true, assignments: input.read.assignments };
}
