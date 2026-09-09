import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import { runClassifier } from './classifier.js';
import { dedupHashFor } from './dedup.js';

/**
 * VIL-160 · the classify stage REDACTS ITS OWN INPUT (rule #1).
 *
 * Redaction used to be a courtesy of the two callers: each flattened and
 * redacted a throwaway copy and handed the classifier a `rawContent: string`
 * that no type and no callee could tell apart from a raw one. It is now a
 * property of the callee — so it is tested at the callee, against a scripted
 * transport injected through the same seam runReviewer uses. A mock of
 * runClassifier can no longer witness this (injected fakes hide callee bugs),
 * which is exactly why the assertions live here and not in the wiring test.
 *
 * Real prompt + stage packs are read from disk (precedent:
 * prompts/discovery-contract.test.ts); only the model transport is scripted, so
 * no LLM is mocked in the sense hard rule #8 forbids — this asserts the REQUEST,
 * not the model's semantics.
 */

const FAMILY_ID = 'fam-160';
const CHILD_NAME = 'Maya';
const EMAIL = 'office@example.com';
const PHONE = '416-555-0199';
const DATE = '2026-09-01';

const payload = {
  subject: `${CHILD_NAME} — pickup change`,
  body: `call ${PHONE} or ${EMAIL} by ${DATE}`,
};

function classificationMessage(): Anthropic.Message {
  return {
    id: 'msg_vil160',
    type: 'message',
    role: 'assistant',
    model: 'claude-test',
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      server_tool_use: null,
    },
    content: [
      {
        type: 'tool_use',
        id: 'tu_0',
        name: 'classification',
        input: {
          event_type: 'daycare_communication',
          confidence: 0.9,
          rationale: 'a pickup change from the daycare',
          payload: { body: 'pickup change' },
          suggested_action: { kind: 'surface_only' },
          teen_content: false,
          concerns_child_id: null,
        },
      },
    ],
  };
}

function capturingClient(): {
  client: Pick<Anthropic, 'messages'>;
  create: ReturnType<typeof vi.fn>;
} {
  const create = vi.fn(async () => classificationMessage());
  return { client: { messages: { create } } as unknown as Pick<Anthropic, 'messages'>, create };
}

/** The signal the model was actually handed, read off the captured request. */
function capturedSignal(create: ReturnType<typeof vi.fn>): {
  source: string;
  raw_content: string;
  family_context_slice: unknown;
} {
  const args = create.mock.calls[0]?.[0] as { messages: Array<{ content: string }> };
  const parsed = JSON.parse(args.messages[0]?.content ?? '') as {
    signal: { source: string; raw_content: string };
    family_context_slice: unknown;
  };
  return { ...parsed.signal, family_context_slice: parsed.family_context_slice };
}

describe('runClassifier — the input it sends is redacted by the callee (rule #1)', () => {
  it('redacts child name, email, phone and date out of raw_content', async () => {
    const { client, create } = capturingClient();

    await runClassifier(
      { familyId: FAMILY_ID, source: 'gmail', payload, childNames: [CHILD_NAME] },
      { client },
    );

    const signal = capturedSignal(create);
    expect(signal.raw_content).toContain('[CHILD]');
    expect(signal.raw_content).toContain('[EMAIL]');
    expect(signal.raw_content).toContain('[PHONE]');
    expect(signal.raw_content).toContain('[DATE]');
    expect(signal.raw_content).not.toContain(CHILD_NAME);
    expect(signal.raw_content).not.toContain(EMAIL);
    expect(signal.raw_content).not.toContain(PHONE);
    expect(signal.raw_content).not.toContain(DATE);
    expect(signal.source).toBe('gmail');
    expect(signal.family_context_slice).toBeNull();
  });

  it('hashes the ORIGINAL payload, not the redacted string the model saw', async () => {
    const { client, create } = capturingClient();

    const result = await runClassifier(
      { familyId: FAMILY_ID, source: 'gmail', payload, childNames: [CHILD_NAME] },
      { client },
    );

    // The dedup key must survive redaction: a signal that arrives twice dedups
    // to the same row whether or not the family's child names changed between
    // the two arrivals.
    expect(result.dedupHash).toBe(dedupHashFor(FAMILY_ID, 'gmail', JSON.stringify(payload)));
    expect(result.dedupHash).not.toBe(
      dedupHashFor(FAMILY_ID, 'gmail', capturedSignal(create).raw_content),
    );
  });

  it('is idempotent on an already-redacted payload — why sync.ts redacts before enqueue', async () => {
    const alreadyRedacted = {
      subject: '[CHILD] — pickup change',
      body: 'call [PHONE] or [EMAIL] by [DATE]',
    };
    const { client, create } = capturingClient();

    await runClassifier(
      { familyId: FAMILY_ID, source: 'gmail', payload: alreadyRedacted, childNames: [CHILD_NAME] },
      { client },
    );

    // The connector leg redacts once before the pg-boss row is written and the
    // classifier redacts again; the placeholders match none of the five
    // patterns, so the second pass is byte-stable rather than corrupting.
    expect(capturedSignal(create).raw_content).toBe(JSON.stringify(alreadyRedacted));
  });

  it('has no field for un-redacted content — the type refuses a rawContent string', async () => {
    const { client } = capturingClient();

    await runClassifier(
      {
        familyId: FAMILY_ID,
        source: 'gmail',
        payload,
        childNames: [CHILD_NAME],
        // @ts-expect-error — VIL-160: `rawContent` is not a field of the classifier's
        // input. If this line ever compiles, the callee no longer owns redaction and
        // a caller can hand the model an arbitrary string again.
        rawContent: JSON.stringify(payload),
      },
      { client },
    );
  });
});
