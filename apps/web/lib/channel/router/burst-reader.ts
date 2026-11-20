import { type AgentClient, pickLane } from '@hale/agent';
import { z } from 'zod';
import type { InboundMediaPart } from '~/lib/channel/inbound-media';
import { loadCronSkill } from '~/lib/cron/skill';
import { forceToolJson } from '~/lib/pipeline/structured';

/**
 * WHICH OF THESE BACK-TO-BACK TEXTS ARE ONE ASK (inbound-burst-read).
 *
 * A parent who sends "$600 budget for a fall program" and then "$900" a second later
 * meant one thing; one who sends "is swim on thursday?" and then "find a saturday art
 * class" meant two. Telling those apart is reading, so the model does it, in any
 * language, from the texts alone. Code checks only that the answer is a partition —
 * every text placed exactly once — and re-asks once with what was wrong.
 *
 * It sees the parent's own texts and Hale's last line in that thread, and nothing else
 * about the family (rule #1). It writes nothing a parent sees. A reader that cannot run
 * says why by name; the planner then reads everything as one turn, so nothing is dropped.
 */

export interface BurstReaderInput {
  messages: ReadonlyArray<{
    ref: string;
    text: string;
    attachments: readonly InboundMediaPart['kind'][];
  }>;
  previousHaleLine: string | null;
}

export type PartitionProblem = 'ref_missing' | 'ref_repeated' | 'ref_unknown' | 'empty_group';

export type BurstReaderFallback =
  | 'client_unavailable'
  | 'skill_unavailable'
  | 'model_failed'
  | 'invalid_partition'
  | 'timeout';

export type BurstReading =
  | { status: 'read'; groups: ReadonlyArray<readonly string[]> }
  | { status: 'unavailable'; reason: BurstReaderFallback };

export interface InboundBurstReader {
  read(input: BurstReaderInput): Promise<BurstReading>;
}

export interface RejectedGrouping {
  groups: string[][];
  problems: PartitionProblem[];
}

/** Two asks. A second refused grouping means the texts are read as one turn. */
const MAX_READ_ATTEMPTS = 2;

/** Reasoning first, then the groups, for up to six short texts. */
const MAX_TOKENS = 512;

/** Every way `groups` fails to place each ref exactly once, in a fixed order. */
export function partitionProblems(
  refs: readonly string[],
  groups: ReadonlyArray<readonly string[]>,
): PartitionProblem[] {
  const known = new Set(refs);
  const seen = new Set<string>();
  let repeated = false;
  let unknown = false;
  for (const group of groups) {
    for (const ref of group) {
      if (!known.has(ref)) unknown = true;
      else if (seen.has(ref)) repeated = true;
      seen.add(ref);
    }
  }
  const problems: PartitionProblem[] = [];
  if (refs.some((ref) => !seen.has(ref))) problems.push('ref_missing');
  if (repeated) problems.push('ref_repeated');
  if (unknown) problems.push('ref_unknown');
  if (groups.some((group) => group.length === 0)) problems.push('empty_group');
  return problems;
}

/** The user-turn payload. Shared with the eval, which replicates this request shape. */
export function burstReaderUserMessage(
  input: BurstReaderInput,
  rejected: readonly RejectedGrouping[] = [],
): string {
  const base = { previousHaleLine: input.previousHaleLine, messages: input.messages };
  return JSON.stringify(rejected.length === 0 ? base : { ...base, rejected });
}

const readingSchema = z.object({
  reasoning: z.string(),
  groups: z.array(z.array(z.string())),
});

const readingJsonSchema = {
  type: 'object',
  properties: {
    reasoning: { type: 'string' },
    groups: {
      type: 'array',
      items: { type: 'array', items: { type: 'string' } },
    },
  },
  required: ['reasoning', 'groups'],
} as const;

function unavailable(reason: BurstReaderFallback): BurstReading {
  console.warn({ reason }, 'inbound burst: reader unavailable');
  return { status: 'unavailable', reason };
}

/** The production reader, on a lazily resolved client like the holding line's. */
export function createBurstReader(client: () => AgentClient): InboundBurstReader {
  return {
    async read(input) {
      let resolved: AgentClient;
      try {
        resolved = client();
      } catch {
        // No detail on purpose: a provider error can carry the request back (rule #1).
        return unavailable('client_unavailable');
      }
      let skill: Awaited<ReturnType<typeof loadCronSkill>>;
      try {
        skill = await loadCronSkill('inbound-burst-read');
      } catch {
        return unavailable('skill_unavailable');
      }
      const refs = input.messages.map((message) => message.ref);
      const rejected: RejectedGrouping[] = [];
      for (let attempt = 0; attempt < MAX_READ_ATTEMPTS; attempt += 1) {
        let groups: string[][];
        try {
          const { value } = await forceToolJson({
            client: resolved,
            lane: pickLane(skill.meta.task),
            system: skill.instructions,
            userMessage: burstReaderUserMessage(input, rejected),
            toolName: 'group_texts',
            toolDescription: 'Group the texts the parent sent back to back by what they ask.',
            inputJsonSchema: readingJsonSchema,
            schema: readingSchema,
            maxTokens: MAX_TOKENS,
          });
          groups = value.groups;
        } catch {
          return unavailable('model_failed');
        }
        const problems = partitionProblems(refs, groups);
        if (problems.length === 0) return { status: 'read', groups };
        rejected.push({ groups, problems });
      }
      return unavailable('invalid_partition');
    },
  };
}
