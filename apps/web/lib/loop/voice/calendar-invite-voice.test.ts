import type { AgentClient } from '@hale/agent';
import { describe, expect, it, vi } from 'vitest';
import {
  ASK_USER_MESSAGE,
  MAX_ASK_CHARS,
  MAX_COMPOSE_ATTEMPTS,
  askViolations,
  createCalendarVoice,
  inviteNoteUserMessage,
  noteViolations,
} from './calendar-invite-voice';

/**
 * VIL-249 — the composed surfaces' MECHANICS. Not their judgement.
 *
 * Whether the ask reads like Hale is decided by a real model and measured in
 * apps/worker/evals/run-calendar-voice-eval.mjs against real cached Claude (rule #8).
 * What is proven here is what the eval cannot reach: that every gate refuses what it
 * says it refuses, that a refusal is handed BACK to the model rather than shipped or
 * swallowed, and that a composer which never clears the gates DEFERS by name instead
 * of falling back to words nobody composed.
 */

const NOTE_CONTEXT = {
  summary: 'Maya — Swim class',
  when: 'Thu, Jul 23 at 10:30 AM',
  method: 'added' as const,
};

const GOOD_ASK = "Want this in your real calendar too? Text me your email and I'll send invites there.";
const GOOD_NOTE = {
  subject: 'Maya — Swim class is on your calendar',
  body: "Maya — Swim class is set for Thu, Jul 23 at 10:30 AM. I've attached the invite so your calendar can add it.",
};

/** A client that answers with each scripted tool input in turn, recording the turns. */
function scriptedClient(inputs: unknown[]): {
  client: () => AgentClient;
  turns: string[];
} {
  const turns: string[] = [];
  let call = 0;
  return {
    turns,
    client: () =>
      ({
        messages: {
          async create(request: { messages: Array<{ content: string }>; tools: Array<{ name: string }> }) {
            turns.push(request.messages[0]?.content ?? '');
            const input = inputs[Math.min(call, inputs.length - 1)];
            call += 1;
            return {
              content: [{ type: 'tool_use', name: request.tools[0]?.name, input }],
              usage: { input_tokens: 10, output_tokens: 5 },
            };
          },
        },
      }) as unknown as AgentClient,
  };
}

const quiet = () => vi.spyOn(console, 'error').mockImplementation(() => {});

describe('askViolations — what may never be texted', () => {
  it('passes a one-question, plain-ASCII, link-free ask', () => {
    expect(askViolations(GOOD_ASK)).toEqual([]);
  });

  /** The shape the model actually reaches for, and the reason the gate counts a
   * SECOND question rather than requiring a first (calibrated on the live run). */
  it('passes an offer that asks without a question mark at all', () => {
    expect(
      askViolations("I can send real calendar invites by email - text me your address and I'll use it."),
    ).toEqual([]);
  });

  it.each([
    ['', 'empty'],
    ['a'.repeat(MAX_ASK_CHARS + 1), 'characters'],
    ['Want your email? I can send invites — say the word?', 'questions'],
    ["Want this in your calendar? Text me your email — I'll send invites there.", 'plain ASCII'],
    ['Text me your address and I will send invites there.', 'email'],
    ['Want invites by email? See https://villagehale.com', 'link'],
    ['Want invites by email, like you@example.com?', '@ address'],
    ['Want invites by email? It takes 2 seconds?', 'questions'],
    ['Want invites by email in 2 seconds?', 'digit'],
  ])('refuses %j', (text, expected) => {
    const violations = askViolations(text);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.join(' | ')).toContain(expected);
  });
});

describe('noteViolations — the containment gate', () => {
  it('passes a note that reproduces the summary and the time', () => {
    expect(noteViolations(GOOD_NOTE, NOTE_CONTEXT)).toEqual([]);
  });

  it('refuses a subject that paraphrases the redacted summary', () => {
    // The dial gave "an appointment"; "Maya's therapy intake" is the leak this stops.
    const context = { ...NOTE_CONTEXT, summary: 'an appointment' };
    const violations = noteViolations(
      {
        subject: "Maya's therapy intake is on your calendar",
        body: "Maya's therapy intake is set for Thu, Jul 23 at 10:30 AM. The invite is attached.",
      },
      context,
    );
    expect(violations.join(' | ')).toContain('"an appointment" exactly as given');
  });

  it('refuses a body that drops the time it was given', () => {
    expect(
      noteViolations(
        { subject: GOOD_NOTE.subject, body: 'Maya — Swim class is on. The invite is attached.' },
        NOTE_CONTEXT,
      ).join(' | '),
    ).toContain('"Thu, Jul 23 at 10:30 AM" exactly as given');
  });

  it('refuses an invented clock time even when the given one is present too', () => {
    const violations = noteViolations(
      {
        subject: GOOD_NOTE.subject,
        body: 'Maya — Swim class is set for Thu, Jul 23 at 10:30 AM. Doors open at 10:15.',
        // 10:15 was in no slot — a specific the model made up.
      },
      NOTE_CONTEXT,
    );
    expect(violations.join(' | ')).toContain('10:15');
  });

  it('refuses a link', () => {
    expect(
      noteViolations(
        { subject: GOOD_NOTE.subject, body: `${GOOD_NOTE.body} More at https://villagehale.com` },
        NOTE_CONTEXT,
      ).join(' | '),
    ).toContain('link');
  });
});

describe('createCalendarVoice — retry, then defer', () => {
  it('composes the ask the model wrote, in one attempt', async () => {
    const { client, turns } = scriptedClient([{ text: GOOD_ASK }]);

    expect(await createCalendarVoice(client).composeAsk()).toEqual({
      status: 'composed',
      text: GOOD_ASK,
      attempts: 1,
    });
    // Blind: the model is handed nothing about this family (rule #1).
    expect(turns).toEqual([ASK_USER_MESSAGE]);
  });

  it('hands a violation back and takes the fixed second attempt', async () => {
    const { client, turns } = scriptedClient([
      { text: 'Want invites by email? Check https://villagehale.com/settings' },
      { text: GOOD_ASK },
    ]);

    const outcome = await createCalendarVoice(client).composeAsk();

    expect(outcome).toEqual({ status: 'composed', text: GOOD_ASK, attempts: 2 });
    // The retry turn names the problem in words the model can act on.
    expect(turns[1]).toContain('carried a link');
    expect(turns[1]).toContain('yourLastAttempt');
  });

  it('DEFERS by name after the attempt budget, sending nothing', async () => {
    const restore = quiet();
    const { client, turns } = scriptedClient([{ text: 'Want invites? Reply with @ your email 24/7!!' }]);

    const outcome = await createCalendarVoice(client).composeAsk();

    expect(turns).toHaveLength(MAX_COMPOSE_ATTEMPTS);
    expect(outcome.status).toBe('deferred');
    if (outcome.status !== 'deferred') throw new Error('expected a defer');
    expect(outcome.attempts).toBe(MAX_COMPOSE_ATTEMPTS);
    expect(outcome.reason).toContain('@ address');
    restore.mockRestore();
  });

  it('names an unresolvable client rather than composing nothing quietly', async () => {
    const outcome = await createCalendarVoice(() => {
      throw new Error('ANTHROPIC_API_KEY is not set');
    }).composeAsk();

    expect(outcome).toEqual({
      status: 'deferred',
      reason: 'client_unavailable: ANTHROPIC_API_KEY is not set',
      attempts: 0,
    });
  });

  it('retries a model outage inside the same budget, then defers naming it', async () => {
    const restore = quiet();
    let calls = 0;
    const client = () =>
      ({
        messages: {
          async create() {
            calls += 1;
            throw new Error('upstream 529');
          },
        },
      }) as unknown as AgentClient;

    const outcome = await createCalendarVoice(client).composeNote(NOTE_CONTEXT);

    expect(calls).toBe(MAX_COMPOSE_ATTEMPTS);
    expect(outcome).toEqual({
      status: 'deferred',
      reason: 'model_failed: upstream 529',
      attempts: MAX_COMPOSE_ATTEMPTS,
    });
    restore.mockRestore();
  });

  it('composes the note over the redacted event, and hands the model only that', async () => {
    const { client, turns } = scriptedClient([GOOD_NOTE]);

    const outcome = await createCalendarVoice(client).composeNote(NOTE_CONTEXT);

    expect(outcome).toEqual({ status: 'composed', ...GOOD_NOTE, attempts: 1 });
    expect(turns).toEqual([inviteNoteUserMessage(NOTE_CONTEXT)]);
    expect(turns[0]).toBe('{"summary":"Maya — Swim class","when":"Thu, Jul 23 at 10:30 AM","method":"added"}');
  });
});
