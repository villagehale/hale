import { type Database, schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';

/**
 * VIL-689 · LINQ_GROUP_SCENES_ENABLED lets a chat hold several open plans, which the
 * one-open-plan unique index forbids. The migration that replaces that index ships when the
 * flag is lit; a test of the scenes runs against the schema as it will be then.
 */
export const DROP_SINGLE_OPEN_PLAN_INDEX =
  'DROP INDEX IF EXISTS "linq_group_plans_live_chat_uniq"';

/** This parent has texted Hale 1:1 before: the only person Hale may open a 1:1 with. */
export async function seedTextedHale(
  database: Database,
  input: { familyId: string; userId: string; at: Date },
): Promise<void> {
  await database.insert(schema.channelMessages).values({
    familyId: input.familyId,
    parentUserId: input.userId,
    channel: 'imessage',
    direction: 'in',
    category: 'reply',
    providerChatId: `dm-${input.userId}`,
    inGroup: false,
    status: 'delivered',
    sentAt: input.at,
    createdAt: input.at,
  });
}

/** This family's join in a shared chat carries its own consent, as `joinConsent` reads it. */
export async function seedJoinConsent(
  database: Database,
  input: { chatId: string; familyId: string; userId: string },
): Promise<void> {
  const [consent] = await database
    .insert(schema.consentRecords)
    .values({
      userId: input.userId,
      familyId: input.familyId,
      consentType: 'multi_family_group',
      granted: true,
      consentScope: input.chatId,
      policyVersion: 'test',
    })
    .returning({ id: schema.consentRecords.id });
  await database
    .update(schema.linqMultiFamilyJoins)
    .set({ consentRecordId: consent?.id })
    .where(
      and(
        eq(schema.linqMultiFamilyJoins.chatId, input.chatId),
        eq(schema.linqMultiFamilyJoins.familyId, input.familyId),
      ),
    );
}
