import { type AgentClient, SONNET_MODEL } from '@hale/agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type NonGoogleClearance, assertClearance } from '~/lib/pipeline/provider-clearance';
import { structuredReply } from '~/lib/testing/structured-reply';
import { applyVerbatimGuard, createReplyIntentReader } from './intent';

const PARENT_TEXT = { kind: 'parent_text' } as const;

function confidentDecline() {
  return vi.fn(async (_args: unknown, _clearance: NonGoogleClearance) => ({
    choice: 'decline' as const,
    probabilities: { assent: 0.02, decline: 0.95, ambiguous: 0.03 },
    confidence: 0.95,
    usage: { inputTokens: 10, outputTokens: 1 },
  }));
}

function currentClient(): AgentClient {
  return {
    messages: {
      create: vi.fn(async (request: unknown) =>
        structuredReply(request, 'intent', {
          intent: 'decline',
          verbatim: 'no thanks',
          rationale: 'clear decline',
          confidence: 0.9,
        }),
      ),
    },
  } as unknown as AgentClient;
}

describe('applyVerbatimGuard', () => {
  it('passes a reading through untouched when the reply was echoed exactly', () => {
    const reading = {
      intent: 'assent' as const,
      verbatim: 'yes please',
      interpretation: 'a yes',
    };
    expect(applyVerbatimGuard(reading, 'yes please')).toBe(reading);
  });

  it('collapses an ASSENT to ambiguous when the echo does not match', () => {
    // A model that paraphrased did not read the reply it was given, so its verdict is
    // not evidence — and the direction that must never survive is a false yes.
    const guarded = applyVerbatimGuard(
      { intent: 'assent', verbatim: 'Yes.', interpretation: 'a yes' },
      'yes please',
    );
    expect(guarded.intent).toBe('ambiguous');
    expect(guarded.verbatim).toBe('yes please');
  });

  it('keeps the parent’s real words on the record even when the reading is discarded', () => {
    const guarded = applyVerbatimGuard(
      { intent: 'decline', verbatim: 'no', interpretation: 'a no' },
      "  no thanks, we're good  ",
    );
    expect(guarded.verbatim).toBe("  no thanks, we're good  ");
    expect(guarded.interpretation).toContain('verbatim mismatch');
  });
});

describe('createReplyIntentReader rollout', () => {
  beforeEach(() => vi.stubEnv('HALE_REPLY_INTENT_MODEL_MODE', ''));
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it.each([undefined, '', ' \t\n ', 'invalid', 'shadow', 'current'])(
    'keeps Sonnet 5 for model mode %j',
    async (raw) => {
      vi.stubEnv('HALE_REPLY_INTENT_MODEL_MODE', raw);
      const client = currentClient();
      const evaluateChoice = vi.fn(async () => ({
        choice: 'assent' as const,
        probabilities: { assent: 0.9 },
        confidence: 0.8,
        usage: { inputTokens: 10, outputTokens: 1 },
      }));

      const result = await createReplyIntentReader(client, {
        evaluateChoice,
      }).read({ question: 'Want me to watch this?', reply: 'no thanks', origin: PARENT_TEXT });

      expect(result.intent).toBe('decline');
      expect(evaluateChoice).not.toHaveBeenCalled();
      expect(client.messages.create).toHaveBeenCalledTimes(1);
    },
  );

  it('falls back to the current model when JEV fails', async () => {
    const client = currentClient();
    const result = await createReplyIntentReader(client, {
      modelMode: 'candidate',
      evaluateChoice: vi.fn(async () => {
        throw new Error('candidate unavailable');
      }),
    }).read({ question: 'Want me to watch this?', reply: 'no thanks', origin: PARENT_TEXT });

    expect(result.intent).toBe('decline');
    expect(client.messages.create).toHaveBeenCalledTimes(1);
  });

  it('uses a confident JEV decline without calling Sonnet', async () => {
    const client = currentClient();
    const evaluateChoice = confidentDecline();
    const result = await createReplyIntentReader(client, {
      modelMode: 'candidate',
      evaluateChoice,
    }).read({ question: 'Want me to watch this?', reply: 'no thanks', origin: PARENT_TEXT });

    expect(result.intent).toBe('decline');
    expect(result.candidateRefusal).toBeNull();
    expect(client.messages.create).not.toHaveBeenCalled();
    // VIL-556 positive control: parent text reaches the candidate with a minted clearance.
    expect(evaluateChoice).toHaveBeenCalledTimes(1);
    const clearance = evaluateChoice.mock.calls[0]?.[1];
    if (!clearance) throw new Error('the candidate was called without a clearance');
    expect(clearance.basis).toBe('parent_text');
    expect(() => assertClearance(clearance)).not.toThrow();
  });

  it.each([
    [{ kind: 'google' } as const, 'google_derived_input'],
    [{ kind: 'unproven' } as const, 'origin_unproven'],
  ])(
    'origin %j never reaches the candidate: Sonnet reads it and the refusal is named',
    async (origin, refusal) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const client = currentClient();
      const evaluateChoice = confidentDecline();

      const result = await createReplyIntentReader(client, {
        modelMode: 'candidate',
        evaluateChoice,
      }).read({ question: 'Want me to watch this?', reply: 'no thanks', origin });

      expect(evaluateChoice).not.toHaveBeenCalled();
      expect(client.messages.create).toHaveBeenCalledTimes(1);
      expect(client.messages.create).toHaveBeenCalledWith(
        expect.objectContaining({ model: SONNET_MODEL }),
      );
      expect(result.intent).toBe('decline');
      expect(result.candidateRefusal).toBe(refusal);
      expect(warn.mock.calls.map((call) => call[0])).toContainEqual({
        stage: 'reply intent',
        refusal,
      });
    },
  );

  it('sends assent and low-confidence choices through the guarded Sonnet path', async () => {
    const client = currentClient();
    await createReplyIntentReader(client, {
      modelMode: 'candidate',
      evaluateChoice: vi.fn(async () => ({
        choice: 'assent' as const,
        probabilities: { assent: 0.98, decline: 0.01, ambiguous: 0.01 },
        confidence: 0.98,
        usage: { inputTokens: 10, outputTokens: 1 },
      })),
    }).read({ question: 'Want me to watch this?', reply: 'yes please', origin: PARENT_TEXT });

    expect(client.messages.create).toHaveBeenCalledTimes(1);
  });

  it('falls back to Sonnet for a low-confidence ambiguous choice', async () => {
    const client = currentClient();
    await createReplyIntentReader(client, {
      modelMode: 'candidate',
      evaluateChoice: vi.fn(async () => ({
        choice: 'ambiguous' as const,
        probabilities: { assent: 0.25, decline: 0.2, ambiguous: 0.55 },
        confidence: 0.55,
        usage: { inputTokens: 10, outputTokens: 1 },
      })),
    }).read({
      question: 'Want me to watch this?',
      reply: 'what does that include?',
      origin: PARENT_TEXT,
    });

    expect(client.messages.create).toHaveBeenCalledTimes(1);
  });

  it('uses Sonnet 5 when current mode is explicit', async () => {
    const client = currentClient();
    const evaluateChoice = vi.fn();

    const result = await createReplyIntentReader(client, {
      modelMode: 'current',
      evaluateChoice,
    }).read({ question: 'Want me to watch this?', reply: 'no thanks', origin: PARENT_TEXT });

    expect(result.intent).toBe('decline');
    expect(evaluateChoice).not.toHaveBeenCalled();
    expect(client.messages.create).toHaveBeenCalledTimes(1);
  });
});
