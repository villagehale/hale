import type { AgentClient } from '@hale/agent';
import { describe, expect, it } from 'vitest';
import { smsSegments } from '~/lib/channel/sms-segments';
import { followUp, followUpQuestion } from './copy';
import type { IntakeCollected } from './extract';
import {
  MAX_ACK_CHARS,
  type IntakeAckInput,
  createIntakeAckComposer,
  intakeAckContext,
  intakeAckFactSlots,
  usableAck,
} from './intake-voice';

/**
 * The COMPOSE stage's pure seam plus its fallback ladder.
 *
 * The model writes only the acknowledgment half — the question is appended
 * deterministically — so what is proved here is the contract that makes letting it write
 * anything safe: an ack that invents a fact, asks its own question, leaves the GSM-7
 * alphabet, or runs long is REJECTED, and the template goes out instead. And every one
 * of those rejections comes back NAMED (rule #11), because "the model was skipped" and
 * "the model was wrong" need different fixes.
 *
 * Composition QUALITY is not asserted here against a canned sentence — that is the
 * eval's job against real cached Claude (rule #8, apps/worker/evals/run-intake-voice-eval.mjs).
 */

const CHILDREN: IntakeCollected['children'] = [
  { name: 'Maya', ageMonths: 48, agePrecision: 'years' },
  { name: 'Leo', ageMonths: null, agePrecision: null },
];

const INPUT: IntakeAckInput = {
  parentWords: 'Maya just turned 4 and Leo is the baby',
  summary: 'Maya (4) and Leo',
  children: CHILDREN,
  venue: null,
  missing: ['ages'],
};

/** A client whose one tool call returns `ack`. The mechanics are faked; the words are
 * supplied by the test so a specific GUARD can be exercised. */
function clientReturning(ack: unknown): AgentClient {
  return {
    messages: {
      async create() {
        return {
          content: [{ type: 'tool_use', name: 'ack', input: { ack } }],
          usage: { input_tokens: 10, output_tokens: 5 },
        };
      },
    },
  } as unknown as AgentClient;
}

function throwingClient(): AgentClient {
  return {
    messages: {
      async create() {
        throw new Error('upstream 529');
      },
    },
  } as unknown as AgentClient;
}

describe('intakeAckContext', () => {
  it('hands the model the parent words and the extracted facts, and no session internals', () => {
    const context = JSON.stringify(intakeAckContext(INPUT));
    expect(context).toContain('Maya just turned 4');
    expect(context).toContain('Maya');
    expect(context).toContain('48');
    // Precision is an internal derivation input, not a fact about the family.
    expect(context).not.toContain('agePrecision');
    expect(context).not.toContain('postalCode');
  });

  it('carries an unnamed child as an explicit null rather than dropping them', () => {
    const context = intakeAckContext({
      ...INPUT,
      children: [{ name: null, ageMonths: 6, agePrecision: 'months' }],
    }) as { children: unknown[] };
    expect(context.children).toEqual([{ name: null, ageMonths: 6 }]);
  });
});

describe('intakeAckFactSlots', () => {
  it('admits the names and ages the parent gave, and the venue when there is one', () => {
    expect(intakeAckFactSlots({ ...INPUT, venue: 'library' })).toEqual(
      expect.arrayContaining(['Maya', '48', 'library', 'Maya (4) and Leo']),
    );
  });

  it('admits NO venue when the parent did not arrive through one', () => {
    expect(intakeAckFactSlots(INPUT)).not.toContain('library');
  });
});

describe('usableAck', () => {
  it('accepts a warm, grounded, question-free sentence', () => {
    expect(usableAck('Got it - Maya just turned 4, and Leo is your baby.', INPUT)).toBe(true);
  });

  it('rejects a sentence that asks its own question (the shell owns the only one)', () => {
    expect(usableAck('Got it - Maya is 4. How old is Leo?', INPUT)).toBe(false);
  });

  it('rejects an invented clock time and an invented link', () => {
    expect(usableAck('Got it - I will text you at 9:15.', INPUT)).toBe(false);
    expect(usableAck('Got it - see https://villagehale.com/setup for more.', INPUT)).toBe(false);
  });

  it('rejects a curly apostrophe, which would re-encode the whole text as UCS-2', () => {
    expect(usableAck('Got it — Maya’s 4 and Leo is the baby.', INPUT)).toBe(false);
  });

  it('rejects an ack past the 160-character ceiling, and an empty one', () => {
    expect(usableAck('Got it. '.repeat(30), INPUT)).toBe(false);
    expect(usableAck('   ', INPUT)).toBe(false);
  });

  // The 160-char ceiling is the ONLY budget guard, so this is the arithmetic that makes
  // a separate segment check unnecessary: the worst case an accepted ack can produce —
  // the longest allowed sentence plus the longest question the shell appends — must
  // still be one two-segment text. If a future gap widens the question, this fails.
  it('cannot produce a payload over two segments, even at the ceiling', () => {
    const atCeiling = 'a'.repeat(MAX_ACK_CHARS);
    expect(usableAck(atCeiling, { ...INPUT, parentWords: atCeiling })).toBe(true);
    const worst = `${atCeiling} ${followUpQuestion(['ages', 'location'])}`;
    expect(smsSegments(worst)).toBeLessThanOrEqual(2);
  });
});

describe('createIntakeAckComposer · the fallback is never silent (rule #11)', () => {
  const templateBody = followUp(INPUT.summary, INPUT.missing);

  it('names voice_unavailable when there is no client at all', async () => {
    expect(await createIntakeAckComposer(null).compose(INPUT)).toEqual({
      body: templateBody,
      source: 'template',
      fallback: 'voice_unavailable',
    });
  });

  it('names model_failed when the call throws, and still asks the question', async () => {
    const ack = await createIntakeAckComposer(throwingClient()).compose(INPUT);
    expect(ack).toEqual({ body: templateBody, source: 'template', fallback: 'model_failed' });
    expect(ack.body).toContain('Last thing:');
  });

  it('names unusable when the model composed something the guards reject', async () => {
    const ack = await createIntakeAckComposer(clientReturning('So how old is Leo?')).compose(INPUT);
    expect(ack).toEqual({ body: templateBody, source: 'template', fallback: 'unusable' });
  });

  it('sends the composed half with the deterministic ask appended, and no fallback', async () => {
    const ack = await createIntakeAckComposer(
      clientReturning('Got it - Maya just turned 4, and Leo is your baby.'),
    ).compose(INPUT);
    expect(ack).toEqual({
      body: 'Got it - Maya just turned 4, and Leo is your baby. Last thing: how old are they?',
      source: 'composed',
      fallback: null,
    });
  });

  it('never lets the model write the question, even when it tries to end on one', async () => {
    // A model answer with a trailing question is rejected wholesale rather than trimmed:
    // half a rejected sentence is not a sentence anyone approved.
    const ack = await createIntakeAckComposer(
      clientReturning('Got it - Maya is 4. What about Leo?'),
    ).compose(INPUT);
    expect(ack.source).toBe('template');
    expect(ack.body.match(/\?/g)).toHaveLength(1);
  });
});
