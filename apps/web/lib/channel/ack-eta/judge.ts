import type Anthropic from '@anthropic-ai/sdk';
import { type AgentClient, pickLane } from '@hale/agent';
import { z } from 'zod';
import { loadCronSkill } from '~/lib/cron/skill';
import { forceToolJson } from '~/lib/pipeline/structured';

/**
 * VIL-717 · the meaning gate on an ack and on a late note: does its timing keep to the
 * window it was given, does it claim the work is done, does it point at an app or a
 * website, does it promise an answer that may not come. In whatever language the line is
 * written, read by a model (skill `ack-eta-judge`), never by a word list. The judge does
 * not rewrite and supplies no line.
 *
 * `unjudged` is a named fault (rule #11): no verdict, so nothing is sent.
 */

/** What the gate needs from the facts. `latestMinutes` null means no time may be promised;
 * `requireTime` means a line that gives no timing is refused (an ack must say when);
 * `answerMayNotCome` means the line may say how long Hale keeps trying but never that the
 * answer will arrive (a still-working note: past the retry ceiling no answer comes). */
export interface AckJudgeWindow {
  latestMinutes: number | null;
  requireTime: boolean;
  answerMayNotCome: boolean;
}

export type AckMeaningProblem =
  | 'no_time'
  | 'time_outside_window'
  | 'claims_done'
  | 'points_at_the_app'
  | 'promises_the_answer';

export type AckJudge =
  | { verdict: 'clear' }
  | { verdict: 'refuse'; problems: AckMeaningProblem[] }
  | { verdict: 'unjudged'; reason: 'skill_unavailable' | 'judge_failed' };

export const ACK_JUDGE_TOOL = 'ack_eta_judge';
export const ACK_JUDGE_DESCRIPTION =
  'Decide whether this line keeps to its time window, claims the work is done, or points at an app. Do not rewrite it.';
export const ACK_JUDGE_MAX_TOKENS = 256;

const YES_NO = { type: 'string', enum: ['yes', 'no'] } as const;

export const ACK_JUDGE_SCHEMA: Anthropic.Tool.InputSchema = {
  type: 'object',
  properties: {
    reason: {
      type: 'string',
      description: 'One short clause for the decision. Not a sentence for the parent.',
    },
    says_when: {
      ...YES_NO,
      description:
        'yes when the line says when, or how soon, the parent will hear back, or how long Hale will keep trying.',
    },
    breaks_window: {
      ...YES_NO,
      description:
        'yes when the timing promises the result sooner than latest_minutes, or names a clock time or date; with latest_minutes null, yes when it says more is coming.',
    },
    claims_done: {
      ...YES_NO,
      description: 'yes when the line says the work is done or gives any of its result.',
    },
    points_at_an_app: {
      ...YES_NO,
      description: 'yes when the line sends the parent to an app, a website, or another screen.',
    },
    promises_answer: {
      ...YES_NO,
      description:
        'yes when the line tells the parent, as a certainty, that they will get the result or hear back with it by some point.',
    },
  },
  required: [
    'reason',
    'says_when',
    'breaks_window',
    'claims_done',
    'points_at_an_app',
    'promises_answer',
  ],
  additionalProperties: false,
};

const verdictSchema = z.object({
  reason: z.string(),
  says_when: z.enum(['yes', 'no']),
  breaks_window: z.enum(['yes', 'no']),
  claims_done: z.enum(['yes', 'no']),
  points_at_an_app: z.enum(['yes', 'no']),
  promises_answer: z.enum(['yes', 'no']),
});

export type AckJudgeVerdict = z.infer<typeof verdictSchema>;

/** The judge's user turn. Shared with the eval, which replays this request. */
export function ackJudgeUserMessage(line: string, latestMinutes: number | null): string {
  return JSON.stringify({ line, latest_minutes: latestMinutes });
}

/** The request the judge sends. Loading it calls no model. */
export async function ackJudgeRequest(line: string, latestMinutes: number | null) {
  const skill = await loadCronSkill('ack-eta-judge');
  return {
    lane: pickLane(skill.meta.task),
    system: skill.instructions,
    userMessage: ackJudgeUserMessage(line, latestMinutes),
    toolName: ACK_JUDGE_TOOL,
    toolDescription: ACK_JUDGE_DESCRIPTION,
    toolSchema: ACK_JUDGE_SCHEMA,
    maxTokens: ACK_JUDGE_MAX_TOKENS,
  };
}

/** The problems a verdict names, for the window the line was written against. Pure. */
export function ackMeaningProblems(
  verdict: AckJudgeVerdict,
  window: AckJudgeWindow,
): AckMeaningProblem[] {
  const problems: AckMeaningProblem[] = [];
  if (window.requireTime && verdict.says_when === 'no') problems.push('no_time');
  if (verdict.breaks_window === 'yes') problems.push('time_outside_window');
  if (verdict.claims_done === 'yes') problems.push('claims_done');
  if (verdict.points_at_an_app === 'yes') problems.push('points_at_the_app');
  if (window.answerMayNotCome && verdict.promises_answer === 'yes') {
    problems.push('promises_the_answer');
  }
  return problems;
}

/** Hard gate for one line. A missing verdict sends nothing: this never returns text. */
export async function judgeAckLine(
  client: AgentClient,
  line: string,
  window: AckJudgeWindow,
): Promise<AckJudge> {
  let request: Awaited<ReturnType<typeof ackJudgeRequest>>;
  try {
    request = await ackJudgeRequest(line, window.latestMinutes);
  } catch {
    return { verdict: 'unjudged', reason: 'skill_unavailable' };
  }
  try {
    const { value } = await forceToolJson({
      client,
      lane: request.lane,
      system: request.system,
      userMessage: request.userMessage,
      toolName: request.toolName,
      toolDescription: request.toolDescription,
      inputJsonSchema: request.toolSchema,
      schema: verdictSchema,
      maxTokens: request.maxTokens,
    });
    const problems = ackMeaningProblems(value, window);
    return problems.length === 0 ? { verdict: 'clear' } : { verdict: 'refuse', problems };
  } catch {
    return { verdict: 'unjudged', reason: 'judge_failed' };
  }
}
