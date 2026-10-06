import { pickLane } from '@hale/agent';
import { z } from 'zod';
import { loadCronSkill } from '~/lib/cron/skill';
import { voiceClient } from '~/lib/loop/voice/compose';
import { postOpsSlack } from '~/lib/monitoring/ops-slack';
import { forceToolJson } from '~/lib/pipeline/structured';

/**
 * Group onboarding v2 — what a member said they are, read by the model.
 *
 * The model returns one object. Code accepts it only when it matches the enum below.
 * A word list never overrides that reading. Aunt, uncle, and cousin are `extended`
 * (family), never `not_family`. On a failed call: one retry, then `unclear` and a
 * page to Slack #ops. Nothing is seated from a guess.
 */

export const ROSTER_ROLES = [
  'parent',
  'grandparent',
  'nanny',
  'babysitter',
  'extended',
  'not_family',
  'decline',
  'unclear',
] as const;
export type RosterRole = (typeof ROSTER_ROLES)[number];

export type RosterParentRole = 'mother' | 'father' | null;
export type RosterRelation = 'aunt' | 'uncle' | 'cousin' | null;

export type RosterReading =
  | {
      kind: 'role';
      role: Exclude<RosterRole, 'unclear'>;
      parentRole: RosterParentRole;
      relation: RosterRelation;
    }
  | { kind: 'unclear' };

const readingSchema = z
  .object({
    role: z.enum(ROSTER_ROLES),
    parentRole: z.enum(['mother', 'father']).nullable(),
    relation: z.enum(['aunt', 'uncle', 'cousin']).nullable(),
  })
  .strict();

const readingJsonSchema = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    role: { type: 'string', enum: [...ROSTER_ROLES] },
    parentRole: { type: ['string', 'null'], enum: ['mother', 'father', null] },
    relation: { type: ['string', 'null'], enum: ['aunt', 'uncle', 'cousin', null] },
  },
  required: ['role', 'parentRole', 'relation'],
};

/** Validate a model object. Anything outside the enum is `unclear`, including a bare "aunt". */
export function parseRosterReading(value: unknown): RosterReading {
  const parsed = readingSchema.safeParse(value);
  if (!parsed.success) return { kind: 'unclear' };
  const { role, parentRole, relation } = parsed.data;
  if (role === 'unclear') return { kind: 'unclear' };
  if (role !== 'parent' && parentRole) return { kind: 'unclear' };
  if (role !== 'extended' && relation) return { kind: 'unclear' };
  return {
    kind: 'role',
    role,
    parentRole: role === 'parent' ? parentRole : null,
    relation: role === 'extended' ? relation : null,
  };
}

async function pageReadingFailed(): Promise<void> {
  const outcome = await postOpsSlack(
    'Hale group onboarding: could not read a group reply after one retry. Nothing was seated. Check #ops.',
  );
  console.warn({ outcome }, 'linq roster reading: model failed, nothing seated');
}

/**
 * Read one reply. Two attempts, then unclear. Does not throw.
 * Tests of seating pass their own reader; this is the production reader.
 */
export async function readRosterReply(text: string): Promise<RosterReading> {
  const client = voiceClient();
  if (!client) {
    await pageReadingFailed();
    return { kind: 'unclear' };
  }
  let skill: Awaited<ReturnType<typeof loadCronSkill>>;
  try {
    skill = await loadCronSkill('group-roster-reading');
  } catch (err) {
    console.error({ err }, 'linq roster reading: skill missing');
    await pageReadingFailed();
    return { kind: 'unclear' };
  }
  const lane = pickLane(skill.meta.task);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const result = await forceToolJson({
        client,
        lane,
        system: skill.instructions,
        userMessage: JSON.stringify({ text, attempt }),
        toolName: 'record_roster_reading',
        toolDescription: 'The role this person claimed for themselves.',
        inputJsonSchema: readingJsonSchema,
        schema: readingSchema,
        maxTokens: 200,
      });
      return parseRosterReading(result.value);
    } catch (err) {
      console.warn(
        { attempt, err: err instanceof Error ? err.name : 'unknown' },
        'linq roster reading: attempt failed',
      );
    }
  }
  await pageReadingFailed();
  return { kind: 'unclear' };
}
