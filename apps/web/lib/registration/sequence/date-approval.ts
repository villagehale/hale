import { type Database, schema } from '@hale/db';
import { and, eq, sql } from 'drizzle-orm';
import { pipelineClient } from '~/lib/pipeline/client';
import { registrationAnchor } from '../live-reading';
import { resolveFamilyOpen } from '../match-registration-windows';
import {
  type RegistrationReader,
  createLiveRegistrationReader,
  registrationDate,
} from '../read';
import { refreshRegistrationWatch, registrationChange } from './refresh';

/** Shared by web taps and SMS approvals. Re-read BEFORE accepting the new date. */
export async function verifyRegistrationDateApproval(
  database: Database,
  input: {
    familyId: string;
    actionId: string;
    now: Date;
  },
  reader: RegistrationReader = createLiveRegistrationReader(pipelineClient()),
): Promise<'verified' | 'changed' | 'unverified'> {
  const [watch] = await database
    .select({
      id: schema.registrationSequences.id,
      courseUrl: schema.registrationSequences.courseUrl,
      pendingChange: schema.registrationSequences.pendingChange,
      window: schema.registrationWindows,
      areaCoarse: schema.families.areaCoarse,
      timeZone: schema.users.timezone,
    })
    .from(schema.registrationSequences)
    .innerJoin(schema.families, eq(schema.families.id, schema.registrationSequences.familyId))
    .innerJoin(schema.users, eq(schema.users.id, schema.registrationSequences.parentUserId))
    .leftJoin(
      schema.registrationWindows,
      eq(schema.registrationWindows.id, schema.registrationSequences.windowId),
    )
    .where(
      and(
        eq(schema.registrationSequences.familyId, input.familyId),
        eq(schema.registrationSequences.dateReviewActionId, input.actionId),
      ),
    );
  if (!watch?.courseUrl) return 'changed';
  const pending = registrationChange(watch.pendingChange);
  const candidate = pending?.kind === 'later' ? pending : pending?.reviewCandidate;
  if (!candidate) return 'changed';
  const resident = watch.window
    ? resolveFamilyOpen(watch.window, watch.areaCoarse).isResidentWindow
    : false;
  const reading = await reader(
    {
      sourceUrl: watch.courseUrl,
      municipality: watch.window?.municipality ?? 'toronto',
      programDomain: watch.window?.programDomain ?? 'rec_program',
      cycleLabel: watch.window?.cycleLabel ?? 'the single course shown on this page',
    },
    input.now,
  );
  const date = registrationDate(reading, resident);
  let at: string | null = null;
  if (date && reading.status === 'verified') {
    try {
      at = registrationAnchor(reading, date).toISOString();
    } catch {
      /* Invalid local time is not confirmable. */
    }
  }
  await refreshRegistrationWatch(database, {
    sequenceId: watch.id,
    reading,
    resident,
    now: input.now,
    parentTimeZone: watch.timeZone,
  });
  if (!at) return 'unverified';
  if (
    at !== candidate.candidateAt ||
    date?.time !== candidate.date?.time ||
    (reading.status === 'verified' ? reading.timeZone : null) !== candidate.timeZone
  )
    return 'changed';
  const [updated] = await database
    .update(schema.registrationSequences)
    .set({ nextCheckAt: input.now })
    .where(
      and(
        eq(schema.registrationSequences.id, watch.id),
        eq(schema.registrationSequences.dateReviewActionId, input.actionId),
        sql`${schema.registrationSequences.pendingChange}->>'key' = ${candidate.key}`,
      ),
    )
    .returning({ id: schema.registrationSequences.id });
  return updated ? 'verified' : 'changed';
}
