import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { StructuredRequestArgs } from '@hale/agent';
import { describe, expect, it, vi } from 'vitest';
import { loadCronSkill } from '~/lib/cron/skill';
import { composeSpotOpen } from './compose';
import {
  SPOT_OPEN_MAX_ATTEMPTS,
  SPOT_OPEN_SKILL,
  SPOT_OPEN_TOOL,
  type SpotOpenFacts,
  spotOpenRefusals,
  spotOpenUserMessage,
} from './copy';

/**
 * The composer's MECHANICS, driven by drafts the real model wrote (rule #8: no LLM mock).
 *
 * Each draft is a recording from apps/worker/evals/run-spot-open-voice-eval.mjs, read
 * from the eval cache by the key that suite computes, so a skill or request change that
 * re-keys the suite leaves these files to be re-recorded rather than silently replayed.
 * Whether a draft is a good text is the eval's job; what is proven here is that a draft
 * the refusals reject is never returned, and that running out of attempts is null.
 */

const EVAL_CACHE = join(__dirname, '..', '..', '..', '..', 'worker', 'evals', 'cache');

/** spot-open-voice:seat-two-with-schedule — "...2 spots open ... Mondays at 5:00 p.m. ..." */
const SEAT_TWO_WITH_SCHEDULE = '7098a63fdbe5fb3b8bae449e64a2072939243f516e5ade01385b933d10b70bba';
/** spot-open-voice:seat-one-label-digit — written from exactly `SEAT_ONE` below. */
const SEAT_ONE_LABEL_DIGIT = 'b92a1e3dd31aff42ec02ed6b9baeec0b5e7c088819aa54fc789e196d0ae8bad4';

function recordedDraft(key: string): { text: string } {
  const entry = JSON.parse(readFileSync(join(EVAL_CACHE, `${key}.json`), 'utf8')) as {
    value: { text: string };
  };
  return entry.value;
}

/** The eval's `seat-one-label-digit` facts, verbatim. */
const SEAT_ONE: SpotOpenFacts = {
  kind: 'seat_opened',
  source: "Lakeside's portal",
  label: 'Swimmer 3 Saturday',
  spotsLeft: 1,
  schedule: null,
  language: 'en',
};

/** Answers each recorded draft in turn, keeping every request it was sent. */
function replaying(drafts: Array<{ text: string }>) {
  const requests: StructuredRequestArgs[] = [];
  const call = async (request: StructuredRequestArgs) => {
    requests.push(request);
    const draft = drafts[requests.length - 1];
    if (!draft) throw new Error(`no recorded draft for call ${requests.length}`);
    return draft;
  };
  return { call, requests };
}

const quiet = () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
};

describe('composeSpotOpen', () => {
  const accepted = recordedDraft(SEAT_ONE_LABEL_DIGIT);
  const refused = recordedDraft(SEAT_TWO_WITH_SCHEDULE);

  it('the recordings: one clears these facts, the other is refused on them', () => {
    expect(spotOpenRefusals(accepted.text, SEAT_ONE)).toEqual([]);
    expect(spotOpenRefusals(refused.text, SEAT_ONE)).toEqual(['unbacked_digit']);
  });

  it('positive control: returns a draft that clears the refusals, after one call', async () => {
    const { call, requests } = replaying([accepted]);

    expect(await composeSpotOpen(call, SEAT_ONE, 'family-1')).toBe(accepted.text.trim());

    const skill = await loadCronSkill(SPOT_OPEN_SKILL);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      system: skill.instructions,
      userMessage: spotOpenUserMessage(SEAT_ONE),
      toolName: SPOT_OPEN_TOOL,
    });
  });

  it('drops a refused draft and returns the next one that clears', async () => {
    quiet();
    const { call, requests } = replaying([refused, accepted]);

    const text = await composeSpotOpen(call, SEAT_ONE, 'family-1');

    expect(text).toBe(accepted.text.trim());
    expect(text).not.toBe(refused.text.trim());
    expect(requests).toHaveLength(2);
  });

  it('returns null after two refused drafts, and asks no more', async () => {
    quiet();
    const { call, requests } = replaying([refused, refused, accepted]);

    expect(await composeSpotOpen(call, SEAT_ONE, 'family-1')).toBeNull();
    expect(SPOT_OPEN_MAX_ATTEMPTS).toBe(2);
    expect(requests).toHaveLength(SPOT_OPEN_MAX_ATTEMPTS);
  });
});
