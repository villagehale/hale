import { type Database, schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { CONNECTOR_PROVIDERS, type ConnectorProvider } from '~/lib/integrations/google-oauth';
import { threadOnboardingV2Enabled } from './thread-onboarding-v2';

/**
 * VIL-721 · a text in the open walk that is not an answer to it: the parent wants Google
 * access ended, or wants a new connect link. The onboarding model says so in `handOff`; no
 * pattern reads their words. The read rides an audit row on the hand-off's inbound row, so a
 * reconciler re-drive of that row reaches the same handler.
 */
export const WALK_HAND_OFFS = [
  'disconnect_gmail',
  'disconnect_calendar',
  'disconnect_google',
  'fresh_link',
] as const;

export type WalkHandOff = (typeof WALK_HAND_OFFS)[number];

export function acceptWalkHandOff(value: unknown): WalkHandOff | null {
  return WALK_HAND_OFFS.find((read) => read === value) ?? null;
}

/** The model's read of this turn. A new-link read counts only once a link has gone out. */
export function walkHandOffFrom(
  capture: { handOff?: WalkHandOff | null },
  linkIsOut: boolean,
): WalkHandOff | null {
  const read = capture.handOff ?? null;
  return read === 'fresh_link' && !linkIsOut ? null : read;
}

/** The read stored for this inbound row. Dark, nothing is read and nothing is claimed. */
export async function walkHandOffOf(
  database: Database,
  turn: { familyId: string; inboundChannelMessageId: string | null },
): Promise<WalkHandOff | null> {
  if (!threadOnboardingV2Enabled() || !turn.inboundChannelMessageId) return null;
  const [row] = await database
    .select({ after: schema.auditLog.after })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.familyId, turn.familyId),
        eq(schema.auditLog.actionTaken, 'onboarding_walk_handed_off'),
        eq(schema.auditLog.targetId, turn.inboundChannelMessageId),
      ),
    )
    .limit(1);
  return acceptWalkHandOff((row?.after as { read?: unknown } | null | undefined)?.read);
}

/**
 * Whether an earlier delivery of this text already left the walk. Its hand-off row is the
 * proof, so a redelivery is not read by the model a second time.
 */
export async function walkTurnHandedOff(
  database: Database,
  providerMessageId: string,
): Promise<boolean> {
  const [inbound] = await database
    .select({ id: schema.channelMessages.id })
    .from(schema.channelMessages)
    .where(
      and(
        eq(schema.channelMessages.providerMessageId, providerMessageId),
        eq(schema.channelMessages.direction, 'in'),
      ),
    )
    .limit(1);
  if (!inbound) return false;
  const [handedOff] = await database
    .select({ id: schema.auditLog.id })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.actionTaken, 'onboarding_walk_handed_off'),
        eq(schema.auditLog.targetId, inbound.id),
      ),
    )
    .limit(1);
  return handedOff !== undefined;
}

/**
 * Which connector a disconnect read names, in the order to try. A named one is the only one
 * tried, so a Calendar-only parent who asks to remove Gmail keeps their Calendar.
 */
export function walkDisconnectProviders(read: WalkHandOff): readonly ConnectorProvider[] {
  if (read === 'disconnect_gmail') return ['gmail'];
  if (read === 'disconnect_calendar') return ['gcal'];
  return read === 'disconnect_google' ? CONNECTOR_PROVIDERS : [];
}
