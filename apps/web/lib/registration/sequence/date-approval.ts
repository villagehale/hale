import { type Database, schema } from '@hale/db';
import { and, eq, sql } from 'drizzle-orm';
import {
  createRegistrationReader,
  registrationAnchor,
  registrationDate,
  type RegistrationReader,
} from '../read';
import { resolveFamilyOpen } from '../match-registration-windows';
import { refreshRegistrationWatch } from './refresh';
import { loadLiveSequences, registrationTargetFor } from './run';

/** Shared by web taps and SMS approvals. Re-read BEFORE accepting the new date. */
export async function verifyRegistrationDateApproval(
  database: Database,
  input: {
    familyId: string;
    actionId: string;
    now: Date;
  },
  reader: RegistrationReader = createRegistrationReader(),
): Promise<'verified' | 'changed' | 'unverified'> {
  const [link] = await database
    .select({ id: schema.registrationSequences.id })
    .from(schema.registrationSequences)
    .where(
      and(
        eq(schema.registrationSequences.familyId, input.familyId),
        eq(schema.registrationSequences.dateReviewActionId, input.actionId),
      ),
    );
  if (!link) return 'changed';
  const watch = (await loadLiveSequences(database, link.id, input.familyId))[0];
  const candidate =
    watch?.pendingChange?.kind === 'later'
      ? watch.pendingChange
      : watch?.pendingChange?.reviewCandidate;
  if (!watch || !candidate) return 'changed';
  const resident = watch.window
    ? resolveFamilyOpen(watch.window, watch.areaCoarse).isResidentWindow
    : false;
  const reading = await reader(registrationTargetFor(watch), input.now);
  const date = registrationDate(reading, resident);
  let at: string | null = null;
  if (date) {
    try {
      at = registrationAnchor(reading, date).toISOString();
    } catch {
      /* Invalid local time is not confirmable. */
    }
  }
  await refreshRegistrationWatch(database, {
    sequenceId: watch.sequenceId,
    reading,
    resident,
    now: input.now,
    parentTimeZone: watch.timeZone,
  });
  if (!at) return 'unverified';
  if (
    at !== candidate.candidateAt ||
    date?.time !== candidate.date?.time ||
    reading.timeZone !== candidate.timeZone
  )
    return 'changed';
  const [updated] = await database
    .update(schema.registrationSequences)
    .set({ nextCheckAt: input.now })
    .where(
      and(
        eq(schema.registrationSequences.id, watch.sequenceId),
        eq(schema.registrationSequences.dateReviewActionId, input.actionId),
        sql`${schema.registrationSequences.pendingChange}->>'key' = ${candidate.key}`,
      ),
    )
    .returning({ id: schema.registrationSequences.id });
  return updated ? 'verified' : 'changed';
}
