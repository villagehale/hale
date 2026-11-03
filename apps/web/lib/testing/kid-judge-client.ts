import type { AgentClient } from '@hale/agent';
import {
  KID_VERDICT_TOOL,
  type KidSkillInput,
} from '~/lib/integrations/kid-relevance/skill-contract';
import { structuredReply } from './structured-reply';

/**
 * A scripted AgentClient for the kid-relevance judge port (the judge.pglite.test.ts
 * helpers, shared). Request MECHANICS only: what the skill decides is the cached eval's
 * job (rule #8). Every title a test answers by is invented.
 */

type Verdict = 'kid' | 'adult' | 'unsure';
export type KidRule = { verdict: Verdict; childName?: string };

/** Answers every item by a substring of its text; anything unmatched is unsure. A rule set
 * of `'throw'` makes every call fail, as a model outage would. */
export function scriptedKidClient(rules: Record<string, KidRule> | 'throw') {
  const calls: KidSkillInput[] = [];
  const respond = async (request: Record<string, unknown>) => {
    const messages = request.messages as { content: string }[];
    const input = JSON.parse(messages[0]?.content ?? '{}') as KidSkillInput;
    calls.push(input);
    if (rules === 'throw') throw new Error('scripted kid judge outage');
    return structuredReply(
      request,
      KID_VERDICT_TOOL,
      {
        verdicts: input.items.map((item) => {
          const hit = Object.entries(rules).find(([needle]) => item.text.includes(needle));
          return {
            ref: item.ref,
            reason: hit ? `about ${hit[0]}` : 'unclear',
            verdict: hit ? hit[1].verdict : 'unsure',
            childName: hit?.[1].childName ?? null,
          };
        }),
      },
      { input_tokens: 1, output_tokens: 1 },
    );
  };
  const client = {
    messages: {
      create: respond,
      stream: (request: Record<string, unknown>) => ({ finalMessage: () => respond(request) }),
    },
  } as unknown as AgentClient;
  return { client, calls };
}

/** Says kid for every item: keeps a suite that is not about the kid gate meaning what it
 * meant before the gate. */
export function kidForAllClient(): AgentClient {
  return scriptedKidClient({ '': { verdict: 'kid' } }).client;
}
