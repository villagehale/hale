import { type Database, householdFamilyEvent, schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import type { SourceChange } from '~/lib/loop/reminders/change';
import { isPrivateEvent } from '~/lib/loop/templates/reminder/core';
import { groupMailNoticeEnabled } from '../config';
import { deliverLinqGroupNotice } from '../group';
import { primaryParentId } from '../roster-ask';
import { createPostgresGroupExperienceStore } from './store';
import {
  type GroupExperienceComposer,
  composeGroupExperienceLine,
  productionGroupExperienceComposer,
} from './voice';

/**
 * VIL-399 scene 07 — a provider time-change is posted into this household's
 * group, never a login. Off unless GROUP_MAIL_NOTICE_ENABLED is on. A line the
 * model cannot write is not sent.
 */
export async function postMailNoticeToHouseholdGroup(
  database: Database,
  input: {
    familyId: string;
    eventId: string;
    change: SourceChange;
    now: Date;
    composer?: GroupExperienceComposer;
    send?: (notice: { chatId: string; text: string }) => Promise<{ providerMessageId: string }>;
  },
): Promise<'sent' | 'skipped'> {
  if (!groupMailNoticeEnabled()) return 'skipped';
  if (input.change.field !== 'time' && input.change.field !== 'date') return 'skipped';
  const [family] = await database
    .select({ chatId: schema.families.linqGroupChatId })
    .from(schema.families)
    .where(eq(schema.families.id, input.familyId))
    .limit(1);
  const parentUserId = await primaryParentId(database, input.familyId);
  if (!family?.chatId || !parentUserId) return 'skipped';

  const [event] = await database
    .select({
      title: schema.familyEvents.title,
      startsAt: schema.familyEvents.startsAt,
      childId: schema.familyEvents.childId,
      sensitive: schema.familyEvents.sensitive,
    })
    .from(schema.familyEvents)
    .where(and(eq(schema.familyEvents.id, input.eventId), householdFamilyEvent()))
    .limit(1);
  if (!event) return 'skipped';
  const kids = await database
    .select({ id: schema.children.id, dateOfBirth: schema.children.dateOfBirth })
    .from(schema.children)
    .where(eq(schema.children.familyId, input.familyId));
  if (isPrivateEvent(event, kids, input.now)) return 'skipped';

  const spoken = await composeGroupExperienceLine(
    {
      skill: 'group-experience-voice',
      kind: 'mail_notice',
      language: 'en',
      audience: 'group',
      questions: 0,
      facts: {
        title: event.title,
        field: input.change.field,
        previousStartsAt: input.change.previousStartsAt.toISOString(),
        startsAt: event.startsAt.toISOString(),
      },
    },
    input.composer ?? productionGroupExperienceComposer(),
    [],
  );
  if (spoken.status !== 'composed') return 'skipped';

  const delivered = await deliverLinqGroupNotice(database, {
    familyId: input.familyId,
    parentUserId,
    chatId: family.chatId,
    text: spoken.line,
    templateKey: 'linq:group_experience',
    now: input.now,
    send: input.send,
    lineClass: 'event_logistics',
  });
  if (delivered !== 'sent') return 'skipped';

  const store = createPostgresGroupExperienceStore(database);
  await store.upsertLive({
    chatId: family.chatId,
    familyId: input.familyId,
    kind: 'mail_notice',
    subjectKey: input.eventId,
    payload: { field: input.change.field, eventId: input.eventId },
    now: input.now,
  });
  return 'sent';
}
