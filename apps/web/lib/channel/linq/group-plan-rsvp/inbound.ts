import { type Database, schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { linqGroupPlanRsvpEnabled } from '../config';
import { type LinqTapback, sendLinqChatMessage } from '../transport';
import type { GroupPlanRsvpReader } from './reading';
import { createPostgresGroupPlanRsvpStore } from './store';
import { type GroupPlanRsvpTurnOutcome, takeGroupPlanRsvpTurn } from './turn';
import type { GroupPlanRsvpComposer } from './voice';

export interface GroupPlanRsvpInboundPorts {
  database: Database;
  now: Date;
  send?: (input: { chatId: string; text: string }) => Promise<{ providerMessageId: string }>;
  reader?: GroupPlanRsvpReader;
  composer?: GroupPlanRsvpComposer;
}

async function senderNameOf(database: Database, userId: string | null): Promise<string | null> {
  if (!userId) return null;
  const [row] = await database
    .select({ name: schema.users.name })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  return row?.name?.trim().split(/\s+/)[0] || null;
}

export async function considerGroupPlanRsvp(
  ports: GroupPlanRsvpInboundPorts,
  input: {
    chatId: string;
    senderHandle: string;
    senderUserId?: string | null;
    text: string;
    tapback: LinqTapback | null;
  },
): Promise<GroupPlanRsvpTurnOutcome> {
  if (!linqGroupPlanRsvpEnabled()) return { handled: false };
  const store = createPostgresGroupPlanRsvpStore(ports.database);
  const live = await store.loadLivePlan(input.chatId);
  const cover = await store.coveringFamily(input.chatId);
  if (!live && !cover) return { handled: false };

  return takeGroupPlanRsvpTurn(
    {
      chatId: input.chatId,
      senderHandle: input.senderHandle,
      senderName: await senderNameOf(ports.database, input.senderUserId ?? null),
      text: input.text,
      tapback: input.tapback,
      language: 'en',
      now: ports.now,
    },
    {
      store,
      reader: ports.reader,
      composer: ports.composer,
      send: ports.send ?? ((notice) => sendLinqChatMessage(notice)),
    },
  );
}
