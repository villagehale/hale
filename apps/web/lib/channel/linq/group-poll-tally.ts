import type { AgentClient } from '@hale/agent';
import { pickLane } from '@hale/agent';
import { type Database, schema } from '@hale/db';
import { inArray } from 'drizzle-orm';
import { z } from 'zod';
import { loadCronSkill } from '~/lib/cron/skill';
import { forceToolJson } from '~/lib/pipeline/structured';

/**
 * VIL-458 slice 1 — the live tally of a Hale-started group poll.
 *
 * Members answer however they like: a native iMessage poll vote, free text in any
 * language, an emoji, "whatever works". The model reads every answer in order and
 * returns, per voter, which option (if any) they now stand on. Code does no keyword or
 * text matching. It only:
 *   - hands the model opaque keys (o1.., f1.., v1..) so it never sees an id,
 *   - maps the answer back and rejects a missing or invented key (null = no tally),
 *   - counts: one vote per family when the question is per family, else per person.
 *
 * A changed mind is the model's read of the latest word, so re-reading the whole
 * thread after each answer keeps the tally right; nothing is stored here yet.
 * Offering a poll, posting the result, and follow-ups come in later slices.
 * If the read fails, there is no tally and nothing is posted (no fallback).
 */

export interface GroupPollOption {
  optionId: string;
  text: string;
}

export interface GroupPoll {
  question: string;
  options: readonly GroupPollOption[];
  /** True when the question is asked of each family (one vote per family). */
  perFamily: boolean;
}

export interface GroupPollVoter {
  voterId: string;
  familyId: string;
  firstName: string;
}

/** One answer in chat order: a native vote (added/removed) or any free-text message. */
export type GroupPollAnswer =
  | { kind: 'vote'; voterId: string; optionId: string; removed: boolean }
  | { kind: 'text'; voterId: string; text: string };

export interface GroupPollReadInput {
  poll: GroupPoll;
  voters: readonly GroupPollVoter[];
  answers: readonly GroupPollAnswer[];
}

/** Per voter: an option id, or null when they have not (or no longer) picked one. */
export type GroupPollReading = Map<string, string | null>;

export interface GroupPollReader {
  /** Null: the read failed after its retry. */
  read(input: GroupPollReadInput): Promise<GroupPollReading | null>;
}

const optionKey = (i: number) => `o${i + 1}`;
const voterKey = (i: number) => `v${i + 1}`;

export const POLL_TALLY_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    voters: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          choice: { type: ['string', 'null'] },
        },
        required: ['key', 'choice'],
      },
    },
  },
  required: ['voters'],
} as const;

const tallySchema = z.object({
  voters: z.array(z.object({ key: z.string(), choice: z.string().nullable() })),
});
export type PollTallyAnswer = z.infer<typeof tallySchema>;

/** The user-turn payload. Shared with the eval so it replays the same request. */
export function pollTallyUserMessage(input: GroupPollReadInput): string {
  const famKey = new Map<string, string>();
  for (const v of input.voters) {
    if (!famKey.has(v.familyId)) famKey.set(v.familyId, `f${famKey.size + 1}`);
  }
  const vKey = new Map(input.voters.map((v, i) => [v.voterId, voterKey(i)]));
  const oKey = new Map(input.poll.options.map((o, i) => [o.optionId, optionKey(i)]));
  return JSON.stringify({
    poll: {
      question: input.poll.question,
      perFamily: input.poll.perFamily,
      options: input.poll.options.map((o, i) => ({ key: optionKey(i), text: o.text })),
    },
    voters: input.voters.map((v, i) => ({
      key: voterKey(i),
      family: famKey.get(v.familyId),
      name: v.firstName,
    })),
    answers: input.answers.map((a) =>
      a.kind === 'vote'
        ? {
            from: vKey.get(a.voterId) ?? null,
            nativeVote: oKey.get(a.optionId) ?? null,
            removed: a.removed,
          }
        : { from: vKey.get(a.voterId) ?? null, text: a.text },
    ),
  });
}

/** Map keys back. Null when a voter is missing, doubled, or a key is invented. */
export function pollReadingFromAnswer(
  input: Pick<GroupPollReadInput, 'poll' | 'voters'>,
  answer: PollTallyAnswer,
): GroupPollReading | null {
  const byKey = new Map<string, string | null>();
  for (const v of answer.voters) {
    if (byKey.has(v.key)) return null;
    byKey.set(v.key, v.choice);
  }
  if (byKey.size !== input.voters.length) return null;
  const optionByKey = new Map(input.poll.options.map((o, i) => [optionKey(i), o.optionId]));
  const out: GroupPollReading = new Map();
  for (const [i, v] of input.voters.entries()) {
    const k = voterKey(i);
    if (!byKey.has(k)) return null;
    const choice = byKey.get(k) ?? null;
    if (choice === null) {
      out.set(v.voterId, null);
      continue;
    }
    const optionId = optionByKey.get(choice);
    if (!optionId) return null;
    out.set(v.voterId, optionId);
  }
  return out;
}

export interface GroupPollTally {
  /** Option id -> count of ballots (families when perFamily, else people). */
  counts: Map<string, number>;
  /** Ballot ids (family or voter) that have not landed on one option. */
  waitingOn: string[];
  /** Families whose members are split across options (perFamily only): not counted. */
  splitFamilies: string[];
  everyoneAnswered: boolean;
}

/**
 * Pure counting. Per family: the family's ballot is the option its members agree on;
 * members with no pick don't block one who picked; members on different options leave
 * the family split (not counted, still waited on).
 */
export function tallyPoll(
  input: Pick<GroupPollReadInput, 'poll' | 'voters'>,
  reading: GroupPollReading,
): GroupPollTally {
  const counts = new Map(input.poll.options.map((o) => [o.optionId, 0]));
  const waitingOn: string[] = [];
  const splitFamilies: string[] = [];
  const bump = (id: string) => counts.set(id, (counts.get(id) ?? 0) + 1);
  if (!input.poll.perFamily) {
    for (const v of input.voters) {
      const c = reading.get(v.voterId) ?? null;
      if (c) bump(c);
      else waitingOn.push(v.voterId);
    }
  } else {
    const picks = new Map<string, Set<string>>();
    for (const v of input.voters) {
      const set = picks.get(v.familyId) ?? new Set<string>();
      const c = reading.get(v.voterId) ?? null;
      if (c) set.add(c);
      picks.set(v.familyId, set);
    }
    for (const [familyId, set] of picks) {
      if (set.size === 1) bump([...set][0] as string);
      else {
        waitingOn.push(familyId);
        if (set.size > 1) splitFamilies.push(familyId);
      }
    }
  }
  return { counts, waitingOn, splitFamilies, everyoneAnswered: waitingOn.length === 0 };
}

/**
 * Voters are only people in families that exist. A voter whose family row is gone
 * (left, deleted) is dropped before the read so they never count.
 */
export async function liveVoters(
  database: Database,
  voters: readonly GroupPollVoter[],
): Promise<GroupPollVoter[]> {
  const ids = [...new Set(voters.map((v) => v.familyId))];
  if (ids.length === 0) return [];
  const rows = await database
    .select({ id: schema.families.id })
    .from(schema.families)
    .where(inArray(schema.families.id, ids));
  const live = new Set(rows.map((r) => r.id));
  return voters.filter((v) => live.has(v.familyId));
}

export function createGroupPollReader(
  clientOrResolver: AgentClient | (() => AgentClient),
): GroupPollReader {
  const once = async (input: GroupPollReadInput) => {
    const client = typeof clientOrResolver === 'function' ? clientOrResolver() : clientOrResolver;
    const skill = await loadCronSkill('group-poll-tally-read');
    const { value } = await forceToolJson({
      client,
      lane: pickLane(skill.meta.task),
      system: skill.instructions,
      userMessage: pollTallyUserMessage(input),
      toolName: 'group_poll_tally',
      toolDescription: 'Return, for each voter key, the option key they now stand on, or null.',
      inputJsonSchema: POLL_TALLY_TOOL_SCHEMA,
      schema: tallySchema,
      maxTokens: 400,
    });
    return pollReadingFromAnswer(input, value);
  };
  return {
    async read(input) {
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          const reading = await once(input);
          if (reading) return reading;
        } catch (err) {
          console.warn(
            { attempt, err: err instanceof Error ? err.name : 'unknown' },
            'group poll tally: read failed',
          );
        }
      }
      console.error(
        { outcome: 'group_poll_unread' },
        'group poll tally: no tally, posting nothing',
      );
      return null;
    },
  };
}

/** Read then count. Null when the read failed: the caller posts nothing. */
export async function readGroupPollTally(
  database: Database,
  reader: GroupPollReader,
  input: GroupPollReadInput,
): Promise<{ reading: GroupPollReading; tally: GroupPollTally } | null> {
  const voters = await liveVoters(database, input.voters);
  const known = new Set(voters.map((v) => v.voterId));
  const scoped = { ...input, voters, answers: input.answers.filter((a) => known.has(a.voterId)) };
  if (voters.length === 0) return null;
  const reading = await reader.read(scoped);
  if (!reading) return null;
  return { reading, tally: tallyPoll(scoped, reading) };
}
