import { type Database, schema } from '@hale/db';
import { and, eq, gte, inArray, isNull, lte, ne, or } from 'drizzle-orm';
import { isUuid } from '~/lib/channel/mid-activity/claim';
import { isParentRole } from '~/lib/channel/role-scope';
import { checkoutSuccessStatesEnabled } from './flags';

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
 * Whether this parent already texts Hale outside a group. A verified channel is not that:
 * a co-parent seated from a group reply has one with no 1:1 text. Rows written before
 * `in_group` existed hold null there, so only a row marked as a group, or one in the
 * family's own group chat, is ruled out.
 */
export async function hasOneToOneThread(
  database: Database,
  parentUserId: string,
  groupChatId: string | null,
): Promise<boolean> {
  const { channelMessages } = schema;
  const [row] = await database
    .select({ id: channelMessages.id })
    .from(channelMessages)
    .where(
      and(
        eq(channelMessages.parentUserId, parentUserId),
        eq(channelMessages.direction, 'in'),
        inArray(channelMessages.channel, ['sms', 'imessage']),
        or(isNull(channelMessages.inGroup), eq(channelMessages.inGroup, false)),
        groupChatId
          ? or(
              isNull(channelMessages.providerChatId),
              ne(channelMessages.providerChatId, groupChatId),
            )
          : undefined,
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * For the /founding "already on a paid plan" screen, behind the page-state flag. The code
 * is already spent by the time this runs, so a failed read answers null instead of costing
 * the parent a 500, and the screen then claims neither "keep texting" nor "start".
 */
export async function alreadyPaidParentHasThread(
  database: Database,
  familyId: string,
  parentUserId: string,
  env: Record<string, string | undefined> = process.env,
): Promise<boolean | null> {
  if (!checkoutSuccessStatesEnabled(env)) return false;
  try {
    const [family] = await database
      .select({ linqGroupChatId: schema.families.linqGroupChatId })
      .from(schema.families)
      .where(eq(schema.families.id, familyId))
      .limit(1);
    if (!family) return false;
    return await hasOneToOneThread(database, parentUserId, family.linqGroupChatId);
  } catch (err) {
    console.warn('founding paid screen: thread read failed', {
      err: err instanceof Error ? err.name : 'unknown',
    });
    return null;
  }
}
