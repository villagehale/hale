import { type Database, schema } from '@hale/db';
import { and, asc, eq, isNull } from 'drizzle-orm';
import {
  type GroupPollExpectedRow,
  type GroupPollOption,
  type GroupPollTally,
  optionKeyAt,
  tallyGroupPoll,
} from './poll-tally';

export type GroupPollOrigin = 'parent' | 'hale_offer';
export type GroupPollVoteSource = 'text' | 'native';

export interface GroupPollRecord {
  id: string;
  chatId: string;
  familyId: string;
  question: string | null;
  options: GroupPollOption[];
  expected: GroupPollExpectedRow[];
  providerMessageId: string | null;
  origin: GroupPollOrigin;
}

export interface CreatePollInput {
  chatId: string;
  familyId: string;
  question: string | null;
  /** Choice texts in order, or native card options when adopting a card. */
  options: readonly { text: string; providerOptionId: string | null }[];
  expected: readonly GroupPollExpectedRow[];
  origin: GroupPollOrigin;
  providerMessageId: string | null;
  now: Date;
}

export interface RecordPollVoteInput {
  pollId: string;
  memberKey: string;
  displayName: string;
  userId: string | null;
  haleCustomer: boolean;
  optionKey: string;
  source: GroupPollVoteSource;
  now: Date;
}

export interface NativeCardOption {
  optionId: string;
  text: string;
  /** The poll's option key when Hale wrote the card for a group poll; null on other cards. */
  choiceValue: string | null;
}

export interface GroupPollStore {
  loadLivePoll(chatId: string): Promise<GroupPollRecord | null>;
  /** The live poll whose native card is `providerMessageId`, if any. */
  pollForCard(chatId: string, providerMessageId: string): Promise<GroupPollRecord | null>;
  /** Closes the chat's live poll, if any, then opens this one. */
  createPoll(input: CreatePollInput): Promise<GroupPollRecord>;
  attachCard(
    pollId: string,
    card: { providerMessageId: string; options: readonly NativeCardOption[] },
  ): Promise<void>;
  /** The options of a native card Hale sent, in the order Linq returned them. */
  cardOptions(providerMessageId: string): Promise<NativeCardOption[]>;
  loadPollTally(pollId: string): Promise<GroupPollTally>;
  recordPollVote(input: RecordPollVoteInput): Promise<{ changed: boolean }>;
  /** Clears the pick only while it is still `optionKey` (a stale removal is a no-op). */
  clearPollVote(input: {
    pollId: string;
    memberKey: string;
    optionKey: string;
    now: Date;
  }): Promise<{ cleared: boolean }>;
}

function flag(value: boolean): 'true' | 'false' {
  return value ? 'true' : 'false';
}

export function pollOptionsFrom(
  options: readonly { text: string; providerOptionId: string | null }[],
): GroupPollOption[] {
  return options.map((option, index) => ({
    key: optionKeyAt(index),
    text: option.text,
    providerOptionId: option.providerOptionId,
  }));
}

/** Linq option ids onto the poll's keys. Hale wrote each key onto its own card option. */
export function withCardIds(
  options: readonly GroupPollOption[],
  card: readonly NativeCardOption[],
): GroupPollOption[] {
  return options.map((option) => ({
    ...option,
    providerOptionId:
      card.find((cardOption) => cardOption.choiceValue === option.key)?.optionId ??
      option.providerOptionId,
  }));
}

function recordOf(row: typeof schema.linqGroupPolls.$inferSelect): GroupPollRecord {
  return {
    id: row.id,
    chatId: row.chatId,
    familyId: row.familyId,
    question: row.question,
    options: [...row.options],
    expected: [...row.expected],
    providerMessageId: row.providerMessageId,
    origin: row.origin as GroupPollOrigin,
  };
}

export function createPostgresGroupPollStore(database: Database): GroupPollStore {
  return {
    async loadLivePoll(chatId) {
      const [row] = await database
        .select()
        .from(schema.linqGroupPolls)
        .where(
          and(eq(schema.linqGroupPolls.chatId, chatId), isNull(schema.linqGroupPolls.closedAt)),
        )
        .limit(1);
      return row && row.chatId === chatId ? recordOf(row) : null;
    },

    async pollForCard(chatId, providerMessageId) {
      const [row] = await database
        .select()
        .from(schema.linqGroupPolls)
        .where(
          and(
            eq(schema.linqGroupPolls.chatId, chatId),
            eq(schema.linqGroupPolls.providerMessageId, providerMessageId),
            isNull(schema.linqGroupPolls.closedAt),
          ),
        )
        .limit(1);
      return row ? recordOf(row) : null;
    },

    async createPoll(input) {
      return database.transaction(async (tx) => {
        await tx
          .update(schema.linqGroupPolls)
          .set({ closedAt: input.now, updatedAt: input.now })
          .where(
            and(
              eq(schema.linqGroupPolls.chatId, input.chatId),
              isNull(schema.linqGroupPolls.closedAt),
            ),
          );
        const [row] = await tx
          .insert(schema.linqGroupPolls)
          .values({
            chatId: input.chatId,
            familyId: input.familyId,
            question: input.question,
            options: pollOptionsFrom(input.options),
            expected: [...input.expected],
            providerMessageId: input.providerMessageId,
            origin: input.origin,
            createdAt: input.now,
            updatedAt: input.now,
          })
          .returning();
        if (!row) throw new Error('createPoll: linq_group_polls insert returned no row');
        await tx.insert(schema.auditLog).values({
          familyId: input.familyId,
          actor: 'system',
          actionTaken: 'linq_group_poll_started',
          targetTable: 'linq_group_polls',
          targetId: row.id,
          after: {
            origin: input.origin,
            options: input.options.length,
            expected: input.expected.length,
          },
        });
        return recordOf(row);
      });
    },

    async attachCard(pollId, card) {
      const [row] = await database
        .select({ options: schema.linqGroupPolls.options })
        .from(schema.linqGroupPolls)
        .where(eq(schema.linqGroupPolls.id, pollId))
        .limit(1);
      if (!row) return;
      await database
        .update(schema.linqGroupPolls)
        .set({
          providerMessageId: card.providerMessageId,
          options: withCardIds(row.options, card.options),
        })
        .where(eq(schema.linqGroupPolls.id, pollId));
    },

    async cardOptions(providerMessageId) {
      const rows = await database
        .select({
          optionId: schema.linqPollOptions.optionId,
          text: schema.linqPollOptions.optionText,
          choiceValue: schema.linqPollOptions.choiceValue,
          providerMessageId: schema.linqPollOptions.providerMessageId,
        })
        .from(schema.linqPollOptions)
        .where(eq(schema.linqPollOptions.providerMessageId, providerMessageId))
        .orderBy(asc(schema.linqPollOptions.createdAt), asc(schema.linqPollOptions.id));
      return rows
        .filter((row) => row.providerMessageId === providerMessageId)
        .map((row) => ({ optionId: row.optionId, text: row.text, choiceValue: row.choiceValue }));
    },

    async loadPollTally(pollId) {
      const [poll] = await database
        .select()
        .from(schema.linqGroupPolls)
        .where(eq(schema.linqGroupPolls.id, pollId))
        .limit(1);
      if (!poll) return tallyGroupPoll([], [], []);
      const votes = await database
        .select({
          memberKey: schema.linqGroupPollVotes.memberKey,
          displayName: schema.linqGroupPollVotes.displayName,
          optionKey: schema.linqGroupPollVotes.optionKey,
        })
        .from(schema.linqGroupPollVotes)
        .where(eq(schema.linqGroupPollVotes.pollId, pollId));
      return tallyGroupPoll(poll.options, votes, poll.expected);
    },

    async recordPollVote(input) {
      return database.transaction(async (tx) => {
        const [poll] = await tx
          .select({ familyId: schema.linqGroupPolls.familyId })
          .from(schema.linqGroupPolls)
          .where(eq(schema.linqGroupPolls.id, input.pollId))
          .limit(1);
        if (!poll) throw new Error('recordPollVote: poll missing');
        const [prior] = await tx
          .select({ optionKey: schema.linqGroupPollVotes.optionKey })
          .from(schema.linqGroupPollVotes)
          .where(
            and(
              eq(schema.linqGroupPollVotes.pollId, input.pollId),
              eq(schema.linqGroupPollVotes.memberKey, input.memberKey),
            ),
          )
          .limit(1);
        if (prior?.optionKey === input.optionKey) return { changed: false };
        await tx
          .insert(schema.linqGroupPollVotes)
          .values({
            pollId: input.pollId,
            memberKey: input.memberKey,
            displayName: input.displayName,
            userId: input.userId,
            haleCustomer: flag(input.haleCustomer),
            optionKey: input.optionKey,
            source: input.source,
            createdAt: input.now,
            updatedAt: input.now,
          })
          .onConflictDoUpdate({
            target: [schema.linqGroupPollVotes.pollId, schema.linqGroupPollVotes.memberKey],
            set: {
              displayName: input.displayName,
              optionKey: input.optionKey,
              source: input.source,
              updatedAt: input.now,
            },
          });
        await tx.insert(schema.auditLog).values({
          familyId: poll.familyId,
          actor: input.userId ?? 'system',
          actionTaken: 'linq_group_poll_vote_recorded',
          targetTable: 'linq_group_poll_votes',
          targetId: input.pollId,
          after: { source: input.source, changed: Boolean(prior) },
        });
        return { changed: true };
      });
    },

    async clearPollVote(input) {
      return database.transaction(async (tx) => {
        const [poll] = await tx
          .select({ familyId: schema.linqGroupPolls.familyId })
          .from(schema.linqGroupPolls)
          .where(eq(schema.linqGroupPolls.id, input.pollId))
          .limit(1);
        if (!poll) return { cleared: false };
        const removed = await tx
          .delete(schema.linqGroupPollVotes)
          .where(
            and(
              eq(schema.linqGroupPollVotes.pollId, input.pollId),
              eq(schema.linqGroupPollVotes.memberKey, input.memberKey),
              eq(schema.linqGroupPollVotes.optionKey, input.optionKey),
            ),
          )
          .returning({ id: schema.linqGroupPollVotes.id });
        if (removed.length === 0) return { cleared: false };
        await tx.insert(schema.auditLog).values({
          familyId: poll.familyId,
          actor: 'system',
          actionTaken: 'linq_group_poll_vote_removed',
          targetTable: 'linq_group_poll_votes',
          targetId: input.pollId,
          after: { source: 'native' },
        });
        return { cleared: true };
      });
    },
  };
}
