import { type AgentClient, pickLane } from '@hale/agent';
import { z } from 'zod';
import { plainText } from '~/lib/channel/coach/reply';
import type { ReplyLanguage } from '~/lib/channel/language';
import { loadCronSkill } from '~/lib/cron/skill';
import { forceToolJson } from '~/lib/pipeline/structured';

/**
 * THE HOLDING LINE — what a parent reads while a slow answer is still being composed.
 *
 * On the 5.5 lanes a searched or carefully written answer can run well past the few
 * seconds a text usually takes. The typing bubble covers that wait on iMessage; past
 * {@link HOLDING_LINE_AFTER_MS}, one short line also goes out so the wait reads as someone
 * working on it, on SMS as much as on iMessage. The real answer follows it.
 *
 * Composed, never recited (no preset message bodies): a skill writes it from the one fact
 * there is, that the answer is still coming, in the parent's language. It sees nothing the
 * parent wrote, so it cannot leak it and cannot pretend to have understood it (rule #1).
 * When no sendable line can be written, NOTHING is sent and the outcome says why — there
 * is no canned line underneath.
 */

/** The ledger's name for this line, so a read-back can tell it from the turn's answer. */
export const HOLDING_LINE_TEMPLATE_KEY = 'holding_line';

/** Past this, a parent is waiting on an answer that has not come, and gets one line. */
export const HOLDING_LINE_AFTER_MS = 8_000;

/** Two attempts. The line only matters while the answer is still coming; a third try
 * would land after it. */
export const MAX_COMPOSE_ATTEMPTS = 2;

const MAX_TOKENS = 96;

const LINK_SHAPE = /https?:\/\/|www\./i;
/** A time nobody scheduled: nobody knows when the answer lands. */
const PROMISED_TIME =
  /\b(shortly|momentarily|in a (minute|moment|sec|second|bit|jiffy)|any (minute|moment) now|right back)\b/i;
const APP_POINTER = /\b(the app|in-app|your dashboard|the website|villagehale)\b/i;

export type HoldingLineRefusal =
  | 'empty'
  | 'carries_link'
  | 'carries_number'
  | 'promised_a_time'
  | 'points_at_the_app';

/**
 * Every reason this line cannot go out, all at once, fed back on the next attempt. These
 * guard facts only — a time, a number, a link or an app nobody gave it. How the line is
 * worded is the model's.
 */
export function refusals(body: string): HoldingLineRefusal[] {
  if (body === '') return ['empty'];
  const found: HoldingLineRefusal[] = [];
  if (LINK_SHAPE.test(body)) found.push('carries_link');
  if (/\d/.test(body)) found.push('carries_number');
  if (PROMISED_TIME.test(body)) found.push('promised_a_time');
  if (APP_POINTER.test(body)) found.push('points_at_the_app');
  return found;
}

export interface RejectedHoldingLine {
  line: string;
  problems: HoldingLineRefusal[];
}

/** The user-turn payload. Shared with the eval, which replicates this request shape. */
export function holdingLineUserMessage(
  language: ReplyLanguage,
  rejected: readonly RejectedHoldingLine[] = [],
): string {
  const base = { situation: 'answer_still_coming', language };
  return JSON.stringify(rejected.length === 0 ? base : { ...base, rejected });
}

export type HoldingLineFallback =
  | 'client_unavailable'
  | 'skill_unavailable'
  | 'model_failed'
  | 'gate_exhausted';

export type HoldingLineCompose =
  | { status: 'composed'; line: string }
  | { status: 'unavailable'; reason: HoldingLineFallback };

export interface HoldingLineComposer {
  compose(language: ReplyLanguage): Promise<HoldingLineCompose>;
}

const lineSchema = z.object({ line: z.string() });
const lineJsonSchema = {
  type: 'object',
  properties: { line: { type: 'string' } },
  required: ['line'],
} as const;

/** A provider error can carry the request back; only its message is logged (rule #1). */
function message(err: unknown): string {
  return err instanceof Error ? err.message : 'unknown';
}

function unavailable(reason: HoldingLineFallback, detail?: string): HoldingLineCompose {
  console.error({ reason, detail }, 'holding line: no line composed');
  return { status: 'unavailable', reason };
}

/** The production composer, on a lazily resolved client like the apology's. */
export function createHoldingLine(client: () => AgentClient): HoldingLineComposer {
  return {
    async compose(language) {
      let resolved: AgentClient;
      try {
        resolved = client();
      } catch (err) {
        return unavailable('client_unavailable', message(err));
      }
      let skill: Awaited<ReturnType<typeof loadCronSkill>>;
      try {
        skill = await loadCronSkill('holding-line');
      } catch (err) {
        return unavailable('skill_unavailable', message(err));
      }

      const rejected: RejectedHoldingLine[] = [];
      for (let attempt = 0; attempt < MAX_COMPOSE_ATTEMPTS; attempt += 1) {
        let raw: string;
        try {
          const { value } = await forceToolJson({
            client: resolved,
            lane: pickLane(skill.meta.task),
            system: skill.instructions,
            userMessage: holdingLineUserMessage(language, rejected),
            toolName: 'holding_line',
            toolDescription: 'Return the one line the parent sees while the answer is coming.',
            inputJsonSchema: lineJsonSchema,
            schema: lineSchema,
            maxTokens: MAX_TOKENS,
          });
          raw = value.line;
        } catch (err) {
          return unavailable('model_failed', message(err));
        }
        const line = plainText(raw);
        const problems = refusals(line);
        if (problems.length === 0) return { status: 'composed', line };
        rejected.push({ line, problems });
      }
      return unavailable('gate_exhausted', rejected.map((r) => r.problems.join('+')).join(' | '));
    },
  };
}

/**
 * What became of the holding line on one turn (rule #11): sent, not needed because the
 * answer came first, or not sent and why.
 */
export type HoldingLineOutcome = 'sent' | 'answered_first' | 'compose_failed' | 'send_failed';

export interface HoldingLine {
  /**
   * Called before the turn's answer goes out, and when the turn ends: cancels a line not
   * yet started, waits for one already being SENT so it never lands after the answer, and
   * drops one still being composed. Idempotent.
   */
  settle(): Promise<HoldingLineOutcome>;
}

/** Arm the one holding line for one turn. It fires at most once. */
export function armHoldingLine(input: {
  afterMs: number;
  language: ReplyLanguage;
  composer: HoldingLineComposer;
  send: (line: string) => Promise<void>;
  log: Pick<Console, 'info' | 'warn'>;
}): HoldingLine {
  let settled = false;
  let outcome: HoldingLineOutcome | null = null;
  let sending: Promise<void> | null = null;

  const fire = async () => {
    const composed = await input.composer.compose(input.language);
    if (settled) return;
    if (composed.status !== 'composed') {
      outcome = 'compose_failed';
      input.log.warn(
        { outcome, reason: composed.reason },
        'holding line: none sent, the answer is still coming',
      );
      return;
    }
    sending = input.send(composed.line).then(
      () => {
        outcome = 'sent';
        input.log.info({ outcome }, 'holding line: sent while the answer is composed');
      },
      (err: unknown) => {
        outcome = 'send_failed';
        input.log.warn(
          { outcome, err: err instanceof Error ? err.name : 'unknown' },
          'holding line: the send failed, the answer is still coming',
        );
      },
    );
  };

  const timer = setTimeout(() => {
    void fire();
  }, input.afterMs);
  if (typeof timer.unref === 'function') timer.unref();

  return {
    async settle() {
      settled = true;
      clearTimeout(timer);
      if (sending) await sending;
      return outcome ?? 'answered_first';
    },
  };
}
