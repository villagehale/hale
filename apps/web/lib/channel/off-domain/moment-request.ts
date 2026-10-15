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

/**
 * The coarse place the moment writer may name help for. Country and province or
 * state only: never a city, a street, or a postal code. Both null when the place
 * is not known, and the fields are always present so the request has one shape.
 */
export interface MomentPlace {
  country: string | null;
  provinceOrState: string | null;
}

export const UNKNOWN_MOMENT_PLACE: MomentPlace = { country: null, provinceOrState: null };

/** The parent's words and the coarse place, so the reply can match their language and their help. */
export function momentUserMessage(
  moment: Moment,
  text: string,
  place: MomentPlace = UNKNOWN_MOMENT_PLACE,
): string {
  return JSON.stringify({
    moment,
    text,
    country: place.country,
    provinceOrState: place.provinceOrState,
  });
}
