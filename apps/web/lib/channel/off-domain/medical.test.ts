import type { AgentClient } from '@hale/agent';
import { describe, expect, it, vi } from 'vitest';
import { SAFETY_REPLY } from './copy';
import { createMedicalComposer, groundUserMessage, sanitizeUserMessage } from './medical';

/**
 * The medical-symptom composer's MECHANICS and its SAFETY INVARIANTS — not its judgement.
 *
 * Whether the words it composes are good pediatric triage is decided by a real model and
 * measured in apps/worker/evals/run-medical-symptom-eval.mjs against real cached Claude
 * (rule #8). What is proven here is what the eval cannot reach and what a fake CAN prove
 * structurally: that the parent's raw message reaches ONLY the sanitize call and the
 * de-identified query is the only thing searched (rule #1); that an ungrounded answer
 * never ships (the founder's invariant); that an answer with no triage never ships; that
 * nothing unsendable ever leaves; that a failed turn is retried once and then falls
 * CLOSED to the fixed 811/911 line rather than to silence or a generic apology; and that
 * no path logs the parent's words. Every negative assertion is paired with a positive
 * control through the same path.
 */

interface Seen {
  system?: string;
  toolChoice?: string;
  tools?: Array<{ type?: string; name?: string }>;
  userMessage?: string;
}

const sanitizeResult = (input: unknown) => ({
  content: [{ type: 'tool_use', name: 'sanitize', input }],
  usage: { input_tokens: 5, output_tokens: 5 },
  stop_reason: 'tool_use',
});

const groundResult = (nResults: number) => ({
  content: [
    { type: 'text', text: 'Authoritative pediatric guidance research notes from the search.' },
    {
      type: 'web_search_tool_result',
      tool_use_id: 'srvtu_1',
      content:
        nResults > 0
          ? Array.from({ length: nResults }, (_, i) => ({
              type: 'web_search_result',
              url: `https://health.example/${i}`,
              title: 'Guidance',
              encrypted_content: 'x',
              page_age: null,
            }))
          : { type: 'web_search_tool_result_error', error_code: 'unavailable' },
    },
  ],
  usage: { input_tokens: 5, output_tokens: 5 },
  stop_reason: 'end_turn',
});

const composeResult = (input: unknown) => ({
  content: [{ type: 'tool_use', name: 'medical_answer', input }],
  usage: { input_tokens: 5, output_tokens: 5 },
  stop_reason: 'tool_use',
});

const OK_SANITIZE = { clinical_query: 'fever 39C 3 days toddler', age_band: 'toddler', duration: '3 days' };
const OK_COMPOSE = {
  answer:
    'A fever this high for a few days at this age is most often a viral illness, and fluids, rest and comfort usually carry them through it.',
  triage:
    'Call 811 any time to talk it through with a nurse. Go to the ER or call 911 now if she has trouble breathing, will not wake, or her lips look blue.',
};

type PhaseResponse = unknown | (() => unknown) | Error;

function makeClient(
  script: { sanitize?: PhaseResponse; ground?: PhaseResponse; compose?: PhaseResponse },
  seen: Seen[] = [],
): () => AgentClient {
  return () =>
    ({
      messages: {
        // biome-ignore lint/suspicious/noExplicitAny: a fake driving the request mechanics
        async create(req: any) {
          const isSanitize = req.tool_choice?.name === 'sanitize';
          const isCompose = req.tool_choice?.name === 'medical_answer';
          const isGround =
            Array.isArray(req.tools) && req.tools[0]?.type === 'web_search_20250305';
          seen.push({
            system: req.system,
            toolChoice: req.tool_choice?.name,
            tools: req.tools,
            userMessage: req.messages?.[0]?.content,
          });
          const pick = isSanitize
            ? script.sanitize
            : isCompose
              ? script.compose
              : isGround
                ? script.ground
                : undefined;
          const resolved = typeof pick === 'function' ? (pick as () => unknown)() : pick;
          if (resolved instanceof Error) throw resolved;
          if (resolved === undefined) throw new Error('medical test: no script for this phase');
          return resolved;
        },
      },
    }) as unknown as AgentClient;
}

const throwingClient = (): AgentClient => {
  throw new Error('ANTHROPIC_API_KEY is not set');
};

const quiet = () => vi.spyOn(console, 'error').mockImplementation(() => {});

describe('sanitizeUserMessage / groundUserMessage', () => {
  it('hands the sanitizer the raw text and nothing else', () => {
    expect(sanitizeUserMessage('she is 3 and has a fever')).toBe(
      '{"text":"she is 3 and has a fever"}',
    );
  });

  it('omits the age band from the search when it is unknown', () => {
    expect(groundUserMessage({ clinicalQuery: 'barking cough', ageBand: null })).toBe(
      '{"clinical_query":"barking cough"}',
    );
  });

  it('carries a coarse age band and duration when known', () => {
    expect(
      groundUserMessage({ clinicalQuery: 'fever', ageBand: 'infant_under_3mo', duration: '1 day' }),
    ).toBe('{"clinical_query":"fever","age_band":"infant_under_3mo","duration":"1 day"}');
  });
});

describe('the happy path', () => {
  it('answers with a web-grounded reply that carries its own triage', async () => {
    const out = await createMedicalComposer(
      makeClient({
        sanitize: sanitizeResult(OK_SANITIZE),
        ground: groundResult(2),
        compose: composeResult(OK_COMPOSE),
      }),
    ).answer('raw message');

    expect(out.replySource).toBe('web_grounded');
    expect(out.reply).not.toBe(SAFETY_REPLY);
    expect(out.reply).toContain('811');
    expect(out.reply).toContain('911');
    // The body is the answer AND the triage, assembled — not one or the other.
    expect(out.reply).toContain('viral illness');
    expect(out.reply).toContain('trouble breathing');
  });
});

/**
 * The rule #1 property this lane is BUILT on, asserted structurally: the parent's raw
 * words reach the sanitize call and NO other, and only the de-identified query is
 * searched. A future edit that pipes the raw text into the search has to break this test.
 */
describe('de-identification before search', () => {
  it('sends only the sanitized query onward, never the raw message', async () => {
    const seen: Seen[] = [];
    const raw =
      'My daughter Emma, exactly 2 years and 3 months old, has had a fever of 39C for 3 days';
    await createMedicalComposer(
      makeClient(
        {
          sanitize: sanitizeResult({ clinical_query: 'fever 39C 3 days toddler', age_band: 'toddler' }),
          ground: groundResult(2),
          compose: composeResult(OK_COMPOSE),
        },
        seen,
      ),
    ).answer(raw);

    // Sanitize is the ONE call that sees the raw message (positive control), on its own skill.
    expect(seen[0]?.toolChoice).toBe('sanitize');
    expect(seen[0]?.userMessage).toBe(sanitizeUserMessage(raw));
    expect(seen[0]?.userMessage).toContain('Emma');
    expect(seen[0]?.system).toContain('Strip the identity');

    // The search sees the de-identified query alone, on the BLIND medical skill.
    const ground = seen.find((s) => Array.isArray(s.tools) && s.tools[0]?.type === 'web_search_20250305');
    expect(ground?.userMessage).toContain('fever'); // positive control: the query reached search
    expect(ground?.userMessage).not.toContain('Emma');
    expect(ground?.userMessage).not.toContain('2 years');
    expect(ground?.system).toContain('A grounded answer to a worried parent');

    // Compose is blind too.
    const compose = seen.find((s) => s.toolChoice === 'medical_answer');
    expect(compose?.userMessage).not.toContain('Emma');
    expect(compose?.userMessage).not.toContain('2 years');
    expect(compose?.userMessage).toContain('fever');
  });
});

describe('retry, then fall closed', () => {
  it('retries once and returns the grounded answer when the first attempt fails', async () => {
    const log = quiet();
    let groundCalls = 0;
    const out = await createMedicalComposer(
      makeClient({
        sanitize: sanitizeResult(OK_SANITIZE),
        ground: () => {
          groundCalls += 1;
          if (groundCalls === 1) throw new Error('web_search upstream 529');
          return groundResult(2);
        },
        compose: composeResult(OK_COMPOSE),
      }),
    ).answer('raw message');

    expect(out.replySource).toBe('web_grounded');
    expect(out.reply).toContain('811');
    expect(groundCalls).toBe(2); // the retry actually re-ran the pipeline
    log.mockRestore();
  });

  it('falls closed to the fixed 811/911 line when BOTH attempts fail', async () => {
    const log = quiet();
    const out = await createMedicalComposer(
      makeClient({
        sanitize: sanitizeResult(OK_SANITIZE),
        ground: () => {
          throw new Error('outage');
        },
        compose: composeResult(OK_COMPOSE),
      }),
    ).answer('raw message');

    expect(out).toEqual({ reply: SAFETY_REPLY, replySource: 'fixed' });
    // Both attempts named and logged, never silent (rule #11).
    const attempts = log.mock.calls.map((c) => (c[0] as { attempt?: number })?.attempt);
    expect(attempts).toEqual([1, 2]);
    log.mockRestore();
  });

  it('falls closed when there is no client, and never throws', async () => {
    const log = quiet();
    expect(await createMedicalComposer(throwingClient).answer('raw message')).toEqual({
      reply: SAFETY_REPLY,
      replySource: 'fixed',
    });
    log.mockRestore();
  });
});

/**
 * The founder's invariant: normal operation is 100% web-grounded, and an answer that did
 * not actually search is not an answer. tool_choice cannot force a server tool, so this is
 * held by COUNTING the results the model produced.
 */
describe('grounding is required', () => {
  it('never ships an ungrounded answer: zero searches falls closed', async () => {
    const log = quiet();
    expect(
      await createMedicalComposer(
        makeClient({
          sanitize: sanitizeResult(OK_SANITIZE),
          ground: groundResult(0),
          compose: composeResult(OK_COMPOSE),
        }),
      ).answer('raw message'),
    ).toEqual({ reply: SAFETY_REPLY, replySource: 'fixed' });
    const reasons = log.mock.calls.map((c) => (c[0] as { reason?: string })?.reason);
    expect(reasons).toContain('not_grounded');
    log.mockRestore();
  });

  it('positive control: the same answer ships once a search actually ran', async () => {
    expect(
      (
        await createMedicalComposer(
          makeClient({
            sanitize: sanitizeResult(OK_SANITIZE),
            ground: groundResult(1),
            compose: composeResult(OK_COMPOSE),
          }),
        ).answer('raw message')
      ).replySource,
    ).toBe('web_grounded');
  });
});

describe('triage is required', () => {
  it('falls closed when the composed answer carries no triage', async () => {
    const log = quiet();
    const noTriage = {
      answer: 'This is usually a mild viral thing at this age and rest helps.',
      triage: 'Keep an eye on her and use your judgement about how she seems.',
    };
    expect(
      await createMedicalComposer(
        makeClient({
          sanitize: sanitizeResult(OK_SANITIZE),
          ground: groundResult(2),
          compose: composeResult(noTriage),
        }),
      ).answer('raw message'),
    ).toEqual({ reply: SAFETY_REPLY, replySource: 'fixed' });
    log.mockRestore();
  });

  it('positive control: the answer ships when the triage names 811/911', async () => {
    const out = await createMedicalComposer(
      makeClient({
        sanitize: sanitizeResult(OK_SANITIZE),
        ground: groundResult(2),
        compose: composeResult(OK_COMPOSE),
      }),
    ).answer('raw message');
    expect(out.replySource).toBe('web_grounded');
    expect(out.reply).toMatch(/\b(?:811|911)\b/);
  });
});

describe('the body must be sendable', () => {
  it('falls closed when the composed body is not GSM-7', async () => {
    const log = quiet();
    const emoji = {
      answer: 'Usually mild at this age and rest helps a lot 🤒.',
      triage: 'Call 811 for nurse advice; go to the ER or call 911 if breathing gets hard.',
    };
    expect(
      await createMedicalComposer(
        makeClient({
          sanitize: sanitizeResult(OK_SANITIZE),
          ground: groundResult(2),
          compose: composeResult(emoji),
        }),
      ).answer('raw message'),
    ).toEqual({ reply: SAFETY_REPLY, replySource: 'fixed' });
    log.mockRestore();
  });

  it('falls closed when the composed body runs past the segment ceiling', async () => {
    const log = quiet();
    const long = {
      answer: `${'a very long clause about the illness '.repeat(20)}`,
      triage: 'Call 811 for nurse advice; go to the ER or call 911 if breathing gets hard.',
    };
    expect(
      await createMedicalComposer(
        makeClient({
          sanitize: sanitizeResult(OK_SANITIZE),
          ground: groundResult(2),
          compose: composeResult(long),
        }),
      ).answer('raw message'),
    ).toEqual({ reply: SAFETY_REPLY, replySource: 'fixed' });
    log.mockRestore();
  });

  it('positive control: a GSM-7 body within the ceiling ships', async () => {
    expect(
      (
        await createMedicalComposer(
          makeClient({
            sanitize: sanitizeResult(OK_SANITIZE),
            ground: groundResult(2),
            compose: composeResult(OK_COMPOSE),
          }),
        ).answer('raw message')
      ).replySource,
    ).toBe('web_grounded');
  });
});

describe('never logs the parent raw message (rule #1)', () => {
  it('keeps the raw words out of the log when a later phase fails', async () => {
    const secret = 'my son Kai at 47 Boulton Ave has a rash and he is 3';
    const log = quiet();
    await createMedicalComposer(
      makeClient({
        sanitize: sanitizeResult({ clinical_query: 'rash trunk toddler', age_band: 'toddler' }),
        ground: () => {
          throw new Error('outage');
        },
        compose: composeResult(OK_COMPOSE),
      }),
    ).answer(secret);

    const logged = JSON.stringify(log.mock.calls);
    expect(logged).not.toContain('Kai');
    expect(logged).not.toContain('Boulton');
    expect(logged).not.toContain(secret);
    log.mockRestore();
  });

  it('keeps the raw words out of the log even when the sanitize call itself errors', async () => {
    const secret = 'my son Kai has a rash, he is 3';
    const log = quiet();
    await createMedicalComposer(
      makeClient({
        sanitize: () => {
          // The one call whose request carries the raw message — its error string must
          // not become the log detail.
          throw new Error(`400 bad request echoing {"text":"${secret}"}`);
        },
        ground: groundResult(2),
        compose: composeResult(OK_COMPOSE),
      }),
    ).answer(secret);

    expect(JSON.stringify(log.mock.calls)).not.toContain('Kai');
    expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
    log.mockRestore();
  });
});
