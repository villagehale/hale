import type { AgentClient } from '@hale/agent';
import { pickLane } from '@hale/agent';
import { type Database, schema } from '@hale/db';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { normalizePhoneE164 } from '~/lib/channels/phone';
import { loadCronSkill } from '~/lib/cron/skill';
import { decryptString } from '~/lib/crypto/string-cipher';
import { HOT_SMS_CLIENT_OPTIONS, budgetedAnthropic } from '~/lib/pipeline/client';
import { forceToolJson } from '~/lib/pipeline/structured';
import { linqFromE164, linqGroupMentionsEnabled } from './config';
import type { LinqInboundMention } from './payload';

/**
 * VIL-475 — the model names who a group reply is addressing, when it is
 * addressing one seated person.
 *
 * Code owns the seats and the handle. The `group-mention-read` skill sees first
 * names and roles, never phones. Off unless `LINQ_GROUP_MENTIONS_ENABLED` is
 * exactly `true`. A failed read sends the reply without a mention and logs.
 */

export interface MentionableMember {
  id: string;
  name: string;
  role: string;
  /** Seated handle. Never logged. Never handed to the model. */
  handle: string;
}

export interface GroupMentionFacts {
  haleMentioned: boolean;
  mentionedMembers: { name: string | null }[];
}

export interface GroupMentionReadInput {
  text: string;
  members: readonly { id: string; name: string; role: string }[];
  inbound: GroupMentionFacts;
}

export interface GroupMentionReader {
  /** Null: nobody to mention, or the read failed after its retry. */
  read(input: GroupMentionReadInput): Promise<string | null>;
}

const outputSchema = z.object({ mentionId: z.string().nullable() });
const outputJsonSchema = {
  type: 'object',
  properties: { mentionId: { type: ['string', 'null'] } },
  required: ['mentionId'],
} as const;

/** The user-turn payload. Shared with the eval, which replays this request shape. */
export function groupMentionUserMessage(input: GroupMentionReadInput): string {
  return JSON.stringify({
    text: input.text,
    members: input.members.map((member) => ({
      id: member.id,
      name: member.name,
      role: member.role,
    })),
    inbound: input.inbound,
  });
}

export function inboundMentionFacts(
  mentions: readonly LinqInboundMention[],
  members: readonly MentionableMember[],
): GroupMentionFacts {
  const haleMentioned = mentions.some((mention) => mention.isMe);
  const mentionedMembers: { name: string | null }[] = [];
  for (const mention of mentions) {
    if (mention.isMe) continue;
    const key = mentionKey(mention.handle);
    const member = members.find((row) => mentionKey(row.handle) === key);
    mentionedMembers.push({ name: member?.name ?? null });
  }
  return { haleMentioned, mentionedMembers };
}

function mentionKey(handle: string): string {
  return normalizePhoneE164(handle) ?? handle.trim().toLowerCase();
}

function haleLine(phone: string): boolean {
  const from = linqFromE164();
  if (!from) return false;
  return normalizePhoneE164(from) === phone;
}

export async function listMentionableMembers(
  database: Database,
  chatId: string,
): Promise<MentionableMember[]> {
  const rows = await database
    .select({
      id: schema.linqGroupMembers.id,
      role: schema.linqGroupMembers.role,
      phoneE164Encrypted: schema.linqGroupMembers.phoneE164Encrypted,
      name: schema.users.name,
    })
    .from(schema.linqGroupMembers)
    .innerJoin(schema.users, eq(schema.linqGroupMembers.userId, schema.users.id))
    .where(
      and(eq(schema.linqGroupMembers.chatId, chatId), isNull(schema.linqGroupMembers.removedAt)),
    );

  const out: MentionableMember[] = [];
  for (const row of rows) {
    const first = row.name?.trim().split(/\s+/)[0];
    if (!first) continue;
    let phone: string;
    try {
      phone = decryptString(row.phoneE164Encrypted);
    } catch {
      console.warn(
        { outcome: 'mention_handle_unread' },
        'linq mention: a seat handle was not readable',
      );
      continue;
    }
    const handle = normalizePhoneE164(phone);
    if (!handle || haleLine(handle)) continue;
    out.push({ id: row.id, name: first, role: row.role, handle });
  }
  return out;
}

export async function groupMentionFactsFor(
  database: Database,
  input: { chatId: string; mentions: readonly LinqInboundMention[] },
): Promise<GroupMentionFacts | null> {
  if (!linqGroupMentionsEnabled()) return null;
  let members: MentionableMember[] = [];
  try {
    members = await listMentionableMembers(database, input.chatId);
  } catch {
    console.warn({ outcome: 'mention_members_unread' }, 'linq mention: members were not listed');
  }
  return inboundMentionFacts(input.mentions, members);
}

export function createGroupMentionReader(
  clientOrResolver: AgentClient | (() => AgentClient),
): GroupMentionReader {
  const once = async (input: GroupMentionReadInput): Promise<string | null> => {
    const client = typeof clientOrResolver === 'function' ? clientOrResolver() : clientOrResolver;
    const skill = await loadCronSkill('group-mention-read');
    const { value } = await forceToolJson({
      client,
      lane: pickLane(skill.meta.task),
      system: skill.instructions,
      userMessage: groupMentionUserMessage(input),
      toolName: 'group_mention',
      toolDescription: 'Return who this group reply is addressing, if anyone.',
      inputJsonSchema: outputJsonSchema,
      schema: outputSchema,
      maxTokens: 200,
    });
    return value.mentionId;
  };
  return {
    async read(input) {
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          return await once(input);
        } catch (err) {
          console.warn(
            { attempt, err: err instanceof Error ? err.name : 'unknown' },
            'group mention reader: read failed',
          );
        }
      }
      console.error(
        { outcome: 'group_mention_unread' },
        'group mention reader: sending without a mention',
      );
      return null;
    },
  };
}

let shared: GroupMentionReader | null = null;

export function sharedGroupMentionReader(): GroupMentionReader {
  shared ??= createGroupMentionReader(() => budgetedAnthropic(HOT_SMS_CLIENT_OPTIONS));
  return shared;
}

/**
 * One seated handle for this group reply, or undefined. Flag off, an empty
 * roster, a failed read, or a name that is not in this chat: no mention.
 * The handle is never logged.
 */
export async function resolveGroupMention(input: {
  database: Database;
  chatId: string;
  text: string;
  inbound?: GroupMentionFacts;
  reader?: GroupMentionReader;
  members?: MentionableMember[];
}): Promise<string | undefined> {
  if (!linqGroupMentionsEnabled()) return undefined;
  const members = input.members ?? (await listMentionableMembers(input.database, input.chatId));
  if (members.length === 0) return undefined;
  const reader = input.reader ?? sharedGroupMentionReader();
  let mentionId: string | null;
  try {
    mentionId = await reader.read({
      text: input.text,
      members: members.map(({ id, name, role }) => ({ id, name, role })),
      inbound: input.inbound ?? { haleMentioned: false, mentionedMembers: [] },
    });
  } catch (err) {
    console.warn(
      { outcome: 'group_mention_unread', err: err instanceof Error ? err.name : 'unknown' },
      'linq mention: reader failed — sending without a mention',
    );
    return undefined;
  }
  if (!mentionId) return undefined;
  const picked = members.find((member) => member.id === mentionId);
  if (!picked) {
    console.warn(
      { outcome: 'mention_not_in_chat' },
      'linq mention: reader named nobody in this chat',
    );
    return undefined;
  }
  return picked.handle;
}
