import type { Database } from '@hale/db';
import { projectDutyOnFamilyEvent } from './calendar';
import { noteDutyBurden } from './burden';
import { coparentDutyMemoryEnabled } from './flag';
import { recordDutyAnswered } from './metrics';
import type { DutyState } from './model';

/**
 * After a duty fact is written: project it onto family_events, refresh the
 * internal burden counts, and record the answer metric. Flag off returns
 * before any of that. A calendar miss is logged with a reason and does not
 * throw — the fact write already landed.
 */
export async function rememberDutyEffects(
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
  if (!coparentDutyMemoryEnabled()) return;
  const projected = await projectDutyOnFamilyEvent(database, input);
  if (projected.status === 'skipped') {
    console.info({ reason: projected.reason }, 'duty memory: calendar not updated');
  }
  try {
    await noteDutyBurden(database, { familyId: input.familyId, now: input.now });
  } catch (err) {
    console.warn(
      { code: err instanceof Error ? err.name : 'unknown' },
      'duty memory: burden was not counted',
    );
  }
  try {
    await recordDutyAnswered(database, {
      familyId: input.familyId,
      actorUserId: input.actorUserId,
      factKey: input.factKey,
      now: input.now,
      source: input.source,
      confirmed: input.state.status === 'confirmed' && input.state.owner !== null,
    });
  } catch (err) {
    console.warn(
      { code: err instanceof Error ? err.name : 'unknown' },
      'duty memory: metric was not recorded',
    );
  }
}
