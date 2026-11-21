import { type Database, schema } from '@hale/db';
import { and, eq, gte, isNull, lte, ne, or } from 'drizzle-orm';
import { resolveMessagingDoor } from '~/lib/channel/messaging-door';
import { isUuid } from '~/lib/channel/mid-activity/claim';
import { isParentRole } from '~/lib/channel/role-scope';

/**
 * `billing_checkout_started` is written right after Stripe returns the session, so its
 * time binds the row to this session. A parent who opens checkout an hour later is not
 * this session's payer.
 */
const CHECKOUT_ROW_SECONDS_BEFORE_SESSION = 10;
const CHECKOUT_ROW_SECONDS_AFTER_SESSION = 60;

/**
 * The one parent who opened this Checkout Session, or null when no row names exactly
 * one parent still in this family. Never falls back to the primary parent: that could
 * thank the wrong adult for someone else's payment.
 */
export async function resolveCheckoutPayer(
  database: Database,
  familyId: string,
  sessionCreatedSeconds: number,
): Promise<string | null> {
  const actors = await database
    .selectDistinct({ actor: schema.auditLog.actor })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.familyId, familyId),
        eq(schema.auditLog.actionTaken, 'billing_checkout_started'),
        gte(
          schema.auditLog.occurredAt,
          new Date((sessionCreatedSeconds - CHECKOUT_ROW_SECONDS_BEFORE_SESSION) * 1000),
        ),
        lte(
          schema.auditLog.occurredAt,
          new Date((sessionCreatedSeconds + CHECKOUT_ROW_SECONDS_AFTER_SESSION) * 1000),
        ),
      ),
    );
  const actor = actors.length === 1 ? actors[0]?.actor : undefined;
  if (!actor || !isUuid(actor)) return null;
  const [member] = await database
    .select({ role: schema.familyMembers.role })
    .from(schema.familyMembers)
    .where(and(eq(schema.familyMembers.familyId, familyId), eq(schema.familyMembers.userId, actor)))
    .limit(1);
  return member && isParentRole(member.role) ? actor : null;
}

/**
 * Whether this parent has their own 1:1 thread with Hale. A verified channel is not one:
 * a co-parent seated from a group reply has that with no 1:1 text.
 */
export async function hasOneToOneThread(
  database: Database,
  parentUserId: string,
  groupChatId: string | null,
): Promise<boolean> {
  const door = await resolveMessagingDoor(database, parentUserId, { excludeChatId: groupChatId });
  if (door.channel === 'imessage') return door.chatId !== null;
  // 'sms' is also the door's answer for someone Hale has never heard from.
  const [row] = await database
    .select({ id: schema.channelMessages.id })
    .from(schema.channelMessages)
    .where(
      and(
        eq(schema.channelMessages.parentUserId, parentUserId),
        eq(schema.channelMessages.direction, 'in'),
        eq(schema.channelMessages.channel, 'sms'),
        groupChatId
          ? or(
              isNull(schema.channelMessages.providerChatId),
              ne(schema.channelMessages.providerChatId, groupChatId),
            )
          : undefined,
      ),
    )
    .limit(1);
  return row !== undefined;
}
