/**
 * The moment reply's REQUEST, shared with the eval.
 *
 * This file imports nothing from the web app at runtime. The general-answer eval
 * loads it the same way it loads answer-request.ts, so a recording is the request
 * production sends.
 */

/** Which moment the ordinary answer stopped for. */
export const MOMENTS = ['could_not_answer', 'child_health', 'mental_crisis', 'emergency'] as const;

export type Moment = (typeof MOMENTS)[number];

export const momentJsonSchema = {
  type: 'object',
  properties: {
    reply: { type: 'string' },
  },
  required: ['reply'],
} as const;

/** The parent's words ride along so the reply can be written in their language. */
export function momentUserMessage(moment: Moment, text: string): string {
  return JSON.stringify({ moment, text });
}
