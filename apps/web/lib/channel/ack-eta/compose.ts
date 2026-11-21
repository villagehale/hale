import { type AgentClient, pickLane } from '@hale/agent';
import { z } from 'zod';
import { plainText } from '~/lib/channel/coach/reply';
import type { ReplyLanguage } from '~/lib/channel/language';
import { loadCronSkill } from '~/lib/cron/skill';
import { hasLinkShape, linkAttemptKind, noteLinkGate } from '~/lib/format/link-shape';
import { forceToolJson } from '~/lib/pipeline/structured';
import { type AckJudgeWindow, type AckMeaningProblem, judgeAckLine } from './judge';
import type { AckTask } from './read';

/**
 * VIL-717 · THE TWO LINES: the ack a slow ask gets right away, and the one note that goes
 * when the time it stated has passed with no answer.
 *
 * Composed from facts, never recited. Each writer sees a task category, a window in
 * minutes and a language, and nothing the parent wrote, so neither can repeat a child's
 * name back or pre-empt the answer. The times are computed (window.ts), so a line that
 * keeps to them is a promise Hale can keep.
 *
 * Every line passes the same gate before it can go out: mechanical facts first (empty, a
 * link by `hasLinkShape`, a question mark in Hale's own line), then the meaning judge
 * (judge.ts). A refused line is redrafted once with the reasons. When no sendable line
 * comes back, NOTHING is sent and the outcome says why; there is no fixed line and no
 * fallback copy underneath.
 */

/** Two attempts: the line is only worth anything while the parent is still waiting. */
export const MAX_COMPOSE_ATTEMPTS = 2;

/** A runaway ceiling, never a length rule: the writer decides how long the line is. */
export const ACK_LINE_MAX_TOKENS = 256;

export type AckLineProblem = 'empty' | 'carries_link' | 'asks_a_question' | AckMeaningProblem;

export interface RejectedAckLine {
  line: string;
  problems: AckLineProblem[];
}

export type AckComposeFallback =
  | 'client_unavailable'
  | 'skill_unavailable'
  | 'model_failed'
  | 'judge_unavailable'
  | 'judge_failed'
  | 'gate_exhausted';

export type AckCompose =
  | { status: 'composed'; line: string }
  | { status: 'unavailable'; reason: AckComposeFallback };

/** What the late note is written from. Every field is a fact code holds. */
export interface LateNoteFacts {
  task: AckTask;
  promisedMinutes: number;
  minutesSinceAsk: number;
  /** `still_working`: the text is still being retried. `stopped`: its turn ended unanswered. */
  status: 'still_working' | 'stopped';
  /** How much longer Hale keeps trying, for `still_working`. A limit on trying, never a time
   * the answer will come. Null for `stopped`, which may promise nothing. */
  newWithinMinutes: number | null;
  language: ReplyLanguage | null;
}

export interface AckLineWriter {
  ack(input: {
    task: AckTask;
    withinMinutes: number;
    language: ReplyLanguage | null;
  }): Promise<AckCompose>;
  lateNote(facts: LateNoteFacts): Promise<AckCompose>;
}

/**
 * Mechanical reasons a line cannot go out, fed back on the next attempt. A link and a
 * question mark are facts about Hale's own line in any language: an ack asks nothing, and a
 * question in it would invite a bare yes that another lane could claim. Everything about
 * meaning is the judge's.
 */
export function mechanicalProblems(line: string, attempt: number): AckLineProblem[] {
  if (line === '') return ['empty'];
  const found: AckLineProblem[] = [];
  if (hasLinkShape(line)) {
    noteLinkGate('ack-eta', linkAttemptKind(attempt + 1, MAX_COMPOSE_ATTEMPTS));
    found.push('carries_link');
  }
  if (line.includes('?') || line.includes('？')) found.push('asks_a_question');
  return found;
}

/** The ack writer's user turn. Shared with the eval, which replicates this request. */
export function ackUserMessage(
  input: { task: AckTask; withinMinutes: number; language: ReplyLanguage | null },
  rejected: readonly RejectedAckLine[] = [],
): string {
  const base = {
    situation: 'slow_ask',
    task: input.task,
    hear_back_within_minutes: input.withinMinutes,
    language: input.language,
  };
  return JSON.stringify(rejected.length === 0 ? base : { ...base, rejected });
}

/** The late note's user turn. Shared with the eval, which replicates this request. */
export function lateNoteUserMessage(
  facts: LateNoteFacts,
  rejected: readonly RejectedAckLine[] = [],
): string {
  const base = {
    situation: 'later_than_promised',
    task: facts.task,
    promised_within_minutes: facts.promisedMinutes,
    minutes_since_ask: facts.minutesSinceAsk,
    status: facts.status,
    new_within_minutes: facts.newWithinMinutes,
    language: facts.language,
  };
  return JSON.stringify(rejected.length === 0 ? base : { ...base, rejected });
}

const lineSchema = z.object({ line: z.string() });
export const ACK_LINE_SCHEMA = {
  type: 'object',
  properties: { line: { type: 'string' } },
  required: ['line'],
} as const;

export const ACK_LINE_TOOL = 'ack_eta_line';
export const LATE_NOTE_TOOL = 'ack_eta_late_note';

/** One writer's draft, as facts. The eval replays exactly these. */
export type AckDraft =
  | { kind: 'ack'; input: { task: AckTask; withinMinutes: number; language: ReplyLanguage | null } }
  | { kind: 'late_note'; facts: LateNoteFacts };

/** The window the judge holds a draft to, from the same facts the writer was given. */
export function draftWindow(draft: AckDraft): AckJudgeWindow {
  if (draft.kind === 'ack') {
    return {
      latestMinutes: draft.input.withinMinutes,
      requireTime: true,
      answerMayNotCome: false,
    };
  }
  return draft.facts.status === 'still_working'
    ? { latestMinutes: draft.facts.newWithinMinutes, requireTime: true, answerMayNotCome: true }
    : { latestMinutes: null, requireTime: false, answerMayNotCome: false };
}

/** The request one draft sends. Loading it calls no model; the eval prices and replays it. */
export async function ackDraftRequest(draft: AckDraft, rejected: readonly RejectedAckLine[] = []) {
  const skill = await loadCronSkill(draft.kind === 'ack' ? 'ack-eta' : 'ack-eta-miss');
  return {
    lane: pickLane(skill.meta.task),
    system: skill.instructions,
    userMessage:
      draft.kind === 'ack'
        ? ackUserMessage(draft.input, rejected)
        : lateNoteUserMessage(draft.facts, rejected),
    toolName: draft.kind === 'ack' ? ACK_LINE_TOOL : LATE_NOTE_TOOL,
    toolDescription:
      draft.kind === 'ack'
        ? 'Return the one line the parent gets while the slow answer is coming.'
        : 'Return the one note the parent gets when Hale is later than it said.',
    toolSchema: ACK_LINE_SCHEMA,
    maxTokens: ACK_LINE_MAX_TOKENS,
  };
}

function unavailable(
  kind: 'ack' | 'late_note',
  reason: AckComposeFallback,
  detail?: string,
): AckCompose {
  // Reasons only, never a draft: a refused line may carry what the judge refused.
  console.error({ kind, reason, detail }, 'ack eta: no line composed');
  return { status: 'unavailable', reason };
}

/** One writer's draft-and-gate loop, shared by the ack and the late note. */
async function composeGated(client: () => AgentClient, draft: AckDraft): Promise<AckCompose> {
  let resolved: AgentClient;
  try {
    resolved = client();
  } catch {
    return unavailable(draft.kind, 'client_unavailable');
  }
  const window = draftWindow(draft);
  const rejected: RejectedAckLine[] = [];
  for (let attempt = 0; attempt < MAX_COMPOSE_ATTEMPTS; attempt += 1) {
    let request: Awaited<ReturnType<typeof ackDraftRequest>>;
    try {
      request = await ackDraftRequest(draft, rejected);
    } catch {
      return unavailable(draft.kind, 'skill_unavailable');
    }
    let raw: string;
    try {
      const { value } = await forceToolJson({
        client: resolved,
        lane: request.lane,
        system: request.system,
        userMessage: request.userMessage,
        toolName: request.toolName,
        toolDescription: request.toolDescription,
        inputJsonSchema: request.toolSchema,
        schema: lineSchema,
        maxTokens: request.maxTokens,
      });
      raw = value.line;
    } catch {
      return unavailable(draft.kind, 'model_failed');
    }
    const line = plainText(raw);
    const problems: AckLineProblem[] = mechanicalProblems(line, attempt);
    // A line the mechanical facts already block is not judged: the writer can fix a link
    // or a question mark without a second model. A verdict that does not arrive sends
    // nothing, and nothing is substituted for the unchecked line.
    if (problems.length === 0) {
      const judged = await judgeAckLine(resolved, line, window);
      if (judged.verdict === 'unjudged') {
        return unavailable(
          draft.kind,
          judged.reason === 'skill_unavailable' ? 'judge_unavailable' : 'judge_failed',
        );
      }
      if (judged.verdict === 'refuse') problems.push(...judged.problems);
    }
    if (problems.length === 0) return { status: 'composed', line };
    rejected.push({ line, problems });
  }
  return unavailable(
    draft.kind,
    'gate_exhausted',
    rejected.map((entry) => entry.problems.join('+')).join(' | '),
  );
}

/** The production writers, on a lazily resolved client like the holding line's. */
export function createAckLineWriter(client: () => AgentClient): AckLineWriter {
  return {
    ack: (input) => composeGated(client, { kind: 'ack', input }),
    lateNote: (facts) => composeGated(client, { kind: 'late_note', facts }),
  };
}
