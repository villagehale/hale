import { type Database, schema } from '@hale/db';
import { and, eq, inArray } from 'drizzle-orm';
import { resolveReplyClient } from '~/lib/channel/reply-copy/client';
import { composePassportLine } from './copy';
import { interestPassportEnabled } from './flag';
import { appendPassportLine, decideCalendar, decideGmail, progressLabel } from './signals';
import {
  calendarSourceRef,
  commitInferredStamp,
  gmailSourceRef,
  integrationOwner,
  listFamilyChildren,
} from './store';

export interface EmailPassportInput {
  body: string;
  /** False on the quiet backfill path: a stamp may be written, a text may not. */
  sending: boolean;
  familyId: string;
  parentUserId: string;
  integrationId: string;
  messageId: string;
  subject: string;
  title: string;
  kind: string;
  teenAttributed: boolean;
  childRef: string | null;
  now: Date;
}

/**
 * Flag off does not read the database. The subject and title are the signal.
 * This function has no parameter for a body, a snippet, or quote evidence.
 */
export async function attachPassportToEmailAlert(
  database: Database,
  input: EmailPassportInput,
): Promise<{ body: string; afterSend: () => Promise<void> }> {
  const untouched = { body: input.body, afterSend: async () => {} };
  if (!interestPassportEnabled()) return untouched;
  try {
    const [owner, children] = await Promise.all([
      integrationOwner(database, input.integrationId),
      listFamilyChildren(database, input.familyId, input.now),
    ]);
    const decision = decideGmail({
      subject: input.subject,
      title: input.title,
      kind: input.kind === 'booking_confirmation' ? 'booking_confirmation' : 'other',
      connectedByUserId: owner,
      actorUserId: input.parentUserId,
      teenAttributed: input.teenAttributed,
      childRef: input.childRef,
      children,
      now: input.now,
    });
    if (!decision.stamp) return untouched;
    let sentence: string | null = null;
    if (input.sending) {
      const child = children.find((item) => item.id === decision.draft.childId);
      const line = await composePassportLine(await resolveReplyClient(undefined), {
        job: 'confirm',
        acknowledgment: null,
        language: 'en',
        childName: child?.name ?? null,
        activity: decision.draft.activity,
        seasonLabel: progressLabel({
          kind: decision.draft.kind,
          seasonLabel: decision.draft.seasonLabel,
          weeksTotal: decision.draft.weeksTotal,
          weeksElapsed: decision.draft.weeksElapsed,
          sessionStart: decision.draft.sessionStart,
          completed: decision.draft.completed,
          now: input.now,
        }),
        sourceLabel: 'Seen in your Gmail receipt',
        nextStep: null,
      });
      sentence = line.ok ? line.text : null;
    }
    const appended = appendPassportLine(input.body, sentence, input.sending);
    return {
      body: appended.body,
      afterSend: async () => {
        try {
          await commitInferredStamp(database, {
            familyId: input.familyId,
            actor: 'system',
            sourceType: 'gmail',
            sourceRef: gmailSourceRef(input.integrationId, input.messageId),
            sourceOwnerUserId: owner,
            subject: input.subject,
            seenOn: input.now.toISOString().slice(0, 10),
            draft: decision.draft,
            asked: appended.included,
            now: input.now,
          });
        } catch (err) {
          console.error(
            {
              familyId: input.familyId,
              err: err instanceof Error ? err.constructor.name : 'unknown',
            },
            'passport: email stamp skipped',
          );
        }
      },
    };
  } catch (err) {
    console.error(
      {
        familyId: input.familyId,
        err: err instanceof Error ? err.constructor.name : 'unknown',
      },
      'passport: email stamp skipped',
    );
    return untouched;
  }
}

export async function syncPassportFromCalendarChanges(
  database: Database,
  input: {
    familyId: string;
    integrationId: string;
    parentUserId: string | null;
    changes: readonly { recurringEventId?: string; title?: string; status: string }[];
    now: Date;
  },
): Promise<void> {
  if (!interestPassportEnabled()) return;
  if (!input.parentUserId) return;
  try {
    const titles = new Map<string, string>();
    for (const change of input.changes) {
      if (!change.recurringEventId || change.status === 'cancelled' || !change.title) continue;
      if (!titles.has(change.recurringEventId)) titles.set(change.recurringEventId, change.title);
    }
    const ids = [...titles.keys()];
    if (ids.length === 0) return;
    const owner = await integrationOwner(database, input.integrationId);
    if (owner !== input.parentUserId) return;
    const [snapshots, children] = await Promise.all([
      database
        .select({
          recurringEventId: schema.calendarEventSnapshots.recurringEventId,
          startAt: schema.calendarEventSnapshots.startAt,
          status: schema.calendarEventSnapshots.status,
        })
        .from(schema.calendarEventSnapshots)
        .where(
          and(
            eq(schema.calendarEventSnapshots.integrationId, input.integrationId),
            inArray(schema.calendarEventSnapshots.recurringEventId, ids),
          ),
        ),
      listFamilyChildren(database, input.familyId, input.now),
    ]);
    for (const [seriesId, title] of titles) {
      const occurrences = snapshots
        .filter(
          (row) =>
            row.recurringEventId === seriesId && row.status !== 'cancelled' && row.startAt !== null,
        )
        .map((row) => row.startAt as Date);
      const decision = decideCalendar({
        title,
        occurrences,
        childRef: null,
        teenAttributed: false,
        children,
        now: input.now,
      });
      if (!decision.stamp) continue;
      await commitInferredStamp(database, {
        familyId: input.familyId,
        actor: 'system',
        sourceType: 'calendar',
        sourceRef: calendarSourceRef(input.integrationId, seriesId, decision.draft.seasonKey),
        sourceOwnerUserId: owner,
        subject: null,
        seenOn: input.now.toISOString().slice(0, 10),
        draft: decision.draft,
        asked: false,
        now: input.now,
      });
    }
  } catch (err) {
    console.error(
      {
        familyId: input.familyId,
        err: err instanceof Error ? err.constructor.name : 'unknown',
      },
      'passport: calendar stamp skipped',
    );
  }
}
