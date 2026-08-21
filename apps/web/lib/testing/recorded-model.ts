import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import type { AgentClient } from '@hale/agent';

/**
 * REAL CLAUDE, RECORDED ONCE — the apps/worker eval cache, made available to a journey
 * test (hard rule #8).
 *
 * WHY THIS EXISTS. A journey test that scripts the model's WORDS cannot fail on anything
 * upstream of the words. The activity follow-up journey did exactly that: it stubbed the
 * composer with a canned "Sept 9" sentence, and so it passed for weeks while the payload
 * handed to the real composer was quietly missing the registration fact the deep pass had
 * opened a page to get. An injected fake of X can never fail on a bug inside X, and the
 * bug was in the projection X reads.
 *
 * So the model call is REAL, made once, and committed. On replay the response is looked up
 * by a CONTENT-ADDRESSED key over the model, the system prompt and the user message — the
 * eval harness's own rule, and the whole point of it here: change the projection, change
 * the skill, change the model tier, and the key moves, the lookup MISSES, and the test
 * fails telling you to re-record. A recording can never drift into answering a question it
 * was not asked.
 *
 * RECORDING. Run the test with `HALE_RECORD=1` and a live key:
 *
 *   HALE_RECORD=1 npx vitest run lib/__journey__/activity-answered.test.ts
 *
 * then commit the JSON. Without the flag a miss is a hard failure and no request is ever
 * made, so CI can neither spend nor silently pass.
 */

/** One recorded turn. `request` is kept beside the response so a stale entry can be read
 * and diffed by a human rather than being an opaque hash. */
interface Recording {
  key: string;
  recordedAt: string;
  request: { model: string; userMessage: string };
  response: { content: unknown[]; stop_reason: string; usage: Record<string, number> };
}

type Recordings = Record<string, Recording>;

function keyFor(model: string, system: string, userMessage: string): string {
  return createHash('sha256').update(`${model}\n${system}\n${userMessage}`).digest('hex');
}

function read(path: string): Recordings {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, 'utf8')) as Recordings;
}

function write(path: string, recordings: Recordings): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(recordings, null, 2)}\n`, 'utf8');
}

function firstText(params: Anthropic.MessageCreateParams): string {
  const [message] = params.messages;
  return typeof message?.content === 'string' ? message.content : JSON.stringify(message?.content);
}

export interface RecordedModel {
  /** Drop-in for any `() => AgentClient` resolver the production code takes. */
  client: () => AgentClient;
  /** Every user message that reached the wire — the real projections, in order. */
  requests: string[];
}

/**
 * A client that replays recordings from `path`, and records against a live client when
 * `HALE_RECORD=1`.
 *
 * `live` is a resolver rather than a client so no key is required to replay: it is called
 * only on a recording miss in record mode.
 */
export function recordedModel(path: string, live: () => AgentClient): RecordedModel {
  const requests: string[] = [];
  const recordings = read(path);

  const client = {
    messages: {
      async create(params: Anthropic.MessageCreateParams) {
        const userMessage = firstText(params);
        requests.push(userMessage);
        const key = keyFor(params.model, String(params.system ?? ''), userMessage);

        const hit = recordings[key];
        if (hit) return hit.response as unknown as Anthropic.Message;

        if (process.env.HALE_RECORD !== '1') {
          throw new Error(
            [
              `recorded-model: no recording for key ${key} in ${path}.`,
              'The request changed (a projection, a skill, or a model tier), so the old',
              'answer is an answer to a different question and will not be replayed.',
              'Re-record with HALE_RECORD=1 and a live ANTHROPIC_API_KEY, then commit it.',
              `--- request ---\n${userMessage}`,
            ].join('\n'),
          );
        }

        const response = await live().messages.create(params);
        recordings[key] = {
          key,
          recordedAt: new Date().toISOString(),
          request: { model: params.model, userMessage },
          response: response as unknown as Recording['response'],
        };
        write(path, recordings);
        return response;
      },
    },
  } as unknown as AgentClient;

  return { client: () => client, requests };
}
