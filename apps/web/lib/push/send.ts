import { type Database, schema } from '@hale/db';
import { eq, inArray } from 'drizzle-orm';
import { db as defaultDb } from '~/lib/db';
import { type ExpoPushClient, createExpoPushClient } from './expo-client';

/**
 * Fan a single notification out to every device a user has registered. The Expo
 * client is injected so a send is testable without the network. Gated by
 * PUSH_SEND_ENABLED (off by default, mirroring DIGEST_SEND_ENABLED): nothing is
 * addressed to real devices until the flag is flipped on purpose.
 *
 * A ticket that comes back DeviceNotRegistered means that device's token is dead
 * (uninstalled / logged out); its row is pruned so we stop addressing it.
 *
 * This is the reusable primitive only — it is NOT wired into any cron yet. Privacy
 * (rule #1): the token is a device address and is never logged; the caller is
 * responsible for the copy being safe (never a child's raw content).
 */

export interface PushMessage {
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

export interface PushSendDeps {
  client: ExpoPushClient;
}

export type PushSendResult =
  | { status: 'disabled' }
  | { status: 'no_tokens' }
  | { status: 'sent'; delivered: number; pruned: number };

function pushSendEnabled(): boolean {
  return process.env.PUSH_SEND_ENABLED === 'true';
}

export function defaultPushSendDeps(): PushSendDeps {
  return { client: createExpoPushClient() };
}

export async function sendPushToUser(
  userId: string,
  message: PushMessage,
  database: Database = defaultDb(),
  deps: PushSendDeps = defaultPushSendDeps(),
): Promise<PushSendResult> {
  if (!pushSendEnabled()) {
    return { status: 'disabled' };
  }

  const tokens = await database
    .select({ id: schema.pushTokens.id, expoPushToken: schema.pushTokens.expoPushToken })
    .from(schema.pushTokens)
    .where(eq(schema.pushTokens.userId, userId));

  if (tokens.length === 0) {
    console.info('push send: no tokens for user (0 devices)');
    return { status: 'no_tokens' };
  }

  const tickets = await deps.client.send(
    tokens.map((t) => ({
      to: t.expoPushToken,
      title: message.title,
      body: message.body,
      ...(message.data ? { data: message.data } : {}),
    })),
  );

  const deadTokenIds = tokens
    .filter((_, i) => tickets[i]?.details?.error === 'DeviceNotRegistered')
    .map((t) => t.id);

  if (deadTokenIds.length > 0) {
    await database.delete(schema.pushTokens).where(inArray(schema.pushTokens.id, deadTokenIds));
  }

  const delivered = tickets.filter((t) => t.status === 'ok').length;
  return { status: 'sent', delivered, pruned: deadTokenIds.length };
}
