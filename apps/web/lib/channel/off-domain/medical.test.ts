import type { AgentClient } from '@hale/agent';
import { describe, expect, it, vi } from 'vitest';
import { SAFETY_REPLY } from './copy';
import {
  createMedicalComposer,
  detectRedFlag,
  groundUserMessage,
  hasEmergencyDirective,
  sanitizeUserMessage,
  scrubResidualPii,
} from './medical';

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

/**
 * The deterministic PII backstop, tested as a pure decision (repo discipline: extract the
 * decision and test it directly). It redacts the identifier classes a regex can catch, and
 * — the positive controls that keep it from eating the medicine — leaves clinical values
 * that only look number-ish alone. Expected values are derived from the de-id spec, not from
 * what the code happens to emit.
 */
describe('scrubResidualPii', () => {
  it('redacts the residual identifiers that must never cross the border', () => {
    expect(scrubResidualPii('call me at 416-555-1234')).toBe('call me at [redacted]');
    expect(scrubResidualPii('reach mom at parent@example.com')).toBe('reach mom at [redacted]');
    expect(scrubResidualPii('we live at M5V 2T6')).toBe('we live at [redacted]');
    expect(scrubResidualPii('health card 1234567890')).toBe('health card [redacted]');
    // formatting variants of a phone still fall
    expect(scrubResidualPii('(416) 555-1234')).toBe('[redacted]');
    expect(scrubResidualPii('4165551234')).toBe('[redacted]');
  });

  it('leaves clinical values untouched (positive controls)', () => {
    expect(scrubResidualPii('fever 39.5 for 3 days')).toBe('fever 39.5 for 3 days');
    expect(scrubResidualPii('vomited 4 times overnight')).toBe('vomited 4 times overnight');
    expect(scrubResidualPii('temp 38.2C, cough, 3 days, toddler')).toBe(
      'temp 38.2C, cough, 3 days, toddler',
    );
  });

  it('redacts a date of birth in the formats a parent actually types', () => {
    expect(scrubResidualPii('born 2021-03-05')).toBe('born [redacted]');
    expect(scrubResidualPii('DOB 3/5/2021')).toBe('DOB [redacted]');
    expect(scrubResidualPii('date of birth 05/03/2021')).toBe('date of birth [redacted]');
    expect(scrubResidualPii('born March 5, 2021')).toBe('born [redacted]');
    expect(scrubResidualPii('born Mar 5 2021')).toBe('born [redacted]');
  });

  it('redacts an exact age while leaving the coarse clinical picture', () => {
    expect(scrubResidualPii('she is 27 months')).toBe('she is [redacted]');
    expect(scrubResidualPii('exactly 2 years 3 months old')).toBe('exactly [redacted]');
    expect(scrubResidualPii('he is 6 weeks old')).toBe('he is [redacted]');
    expect(scrubResidualPii('my 18-month-old')).toBe('my [redacted]');
    expect(scrubResidualPii('she just turned 2 years old')).toBe('she just turned [redacted]');
  });

  it('never eats a clinical duration, temperature, or count (positive controls)', () => {
    // "weeks" is redacted ONLY as an age ("6 weeks old"); a duration keeps it.
    expect(scrubResidualPii('symptoms for 2 weeks')).toBe('symptoms for 2 weeks');
    // Small month-counts read as durations, not toddler ages, and survive.
    expect(scrubResidualPii('congestion for 3 months')).toBe('congestion for 3 months');
    expect(scrubResidualPii('fever 39.5 for 3 days')).toBe('fever 39.5 for 3 days');
    expect(scrubResidualPii('vomited 4 times')).toBe('vomited 4 times');
  });
});

/**
 * The red-flag detector, tested as a pure decision. It must FIRE on each unambiguous
 * pediatric emergency and must NOT fire on the benign path (a mild cold, teething) — an
 * over-firing detector replaces a good grounded answer with the fixed line, which is its
 * own harm. Inputs are the SANITIZED clinical query + coarse age band, exactly what the
 * runtime hands it. Expected values are derived from published pediatric red-flags.
 */
describe('detectRedFlag', () => {
  it('fires on each red-flag class', () => {
    expect(detectRedFlag('trouble breathing, ribs pulling in', null)).toBe(true);
    expect(detectRedFlag('rapid breathing with rib retractions and dusky lips', null)).toBe(true);
    expect(detectRedFlag('her lips look blue', null)).toBe(true);
    expect(detectRedFlag('febrile seizure, now floppy and drowsy', null)).toBe(true);
    expect(detectRedFlag('unresponsive and hard to wake', null)).toBe(true);
    expect(detectRedFlag('fever with non-blanching purple spot rash on legs', null)).toBe(true);
    expect(detectRedFlag('purple spots that do not fade when pressed', null)).toBe(true);
    expect(detectRedFlag('face and lips are swelling, anaphylaxis', null)).toBe(true);
    expect(detectRedFlag('sunken eyes and no wet diaper in 12 hours', null)).toBe(true);
    // stiff neck is a red flag only alongside fever (meningitis), not on its own
    expect(detectRedFlag('high fever, headache, stiff neck', null)).toBe(true);
    // ANY fever under 3 months, from the band or an explicit "under 3 months"
    expect(detectRedFlag('fever', 'infant_under_3mo')).toBe(true);
    expect(detectRedFlag('fever 38.2C in infant under 3 months', null)).toBe(true);
  });

  it('does NOT fire on the benign path', () => {
    expect(detectRedFlag('runny nose, mild cough, no fever, active and eating well', 'preschooler')).toBe(false);
    expect(detectRedFlag('drooling, chewing on objects, fussiness, teething', 'toddler')).toBe(false);
    expect(detectRedFlag('tugging at ear, crying overnight, possible ear infection', 'toddler')).toBe(false);
    expect(detectRedFlag('sore throat and fever, sibling with recent strep', 'preschooler')).toBe(false);
    expect(detectRedFlag('watery diarrhea and vomiting, still drinking, wet diapers present', 'toddler')).toBe(false);
    // fever alone in an OLDER child is not a red flag, and a stiff neck alone is not either
    expect(detectRedFlag('fever 39C 3 days', 'toddler')).toBe(false);
    expect(detectRedFlag('stiff neck after sleeping awkwardly', 'school_age')).toBe(false);
    // an under-3-months infant with an EXPLICIT no-fever is not the infant-fever red flag
    expect(detectRedFlag('stuffy nose, no fever', 'infant_under_3mo')).toBe(false);
  });
});

/**
 * The emergency-directive check: the positive half of the escalation invariant. It must
 * accept a real "seek emergency care" instruction and REJECT the presence of 811 alone —
 * "watch and wait, call 811" is exactly the under-escalation this lane must catch.
 *
 * It is checked in all THREE languages the lane answers in, because the check is what
 * decides whether a red-flag answer may ship: an English-only matcher reading a French or
 * Chinese body finds no directive in a perfectly good "allez aux urgences" and falls the
 * turn closed, and — the direction that actually hurts — would have no way to tell that
 * body apart from a French under-escalation. Both directions are asserted per language.
 */
describe('hasEmergencyDirective', () => {
  it('accepts an explicit emergency instruction', () => {
    expect(hasEmergencyDirective('Go to the ER or call 911 now.')).toBe(true);
    expect(hasEmergencyDirective('This needs emergency care now.')).toBe(true);
    expect(hasEmergencyDirective('Seek immediate care.')).toBe(true);
    expect(hasEmergencyDirective('Call an ambulance right away.')).toBe(true);
    expect(hasEmergencyDirective('This needs urgent medical care now.')).toBe(true);
  });

  it('accepts an explicit emergency instruction in French', () => {
    expect(hasEmergencyDirective('Emmenez-la aux urgences maintenant.')).toBe(true);
    expect(hasEmergencyDirective("Allez a l'urgence tout de suite.")).toBe(true);
    expect(hasEmergencyDirective("Allez à l'urgence tout de suite.")).toBe(true);
    expect(hasEmergencyDirective("Elle a besoin de soins d'urgence immédiats.")).toBe(true);
    expect(hasEmergencyDirective('Appelez une ambulance.')).toBe(true);
    // The digits need no translation — the universal anchor.
    expect(hasEmergencyDirective('Composez le 911 tout de suite.')).toBe(true);
  });

  it('accepts an explicit emergency instruction in Chinese', () => {
    expect(hasEmergencyDirective('请立即就医。')).toBe(true);
    expect(hasEmergencyDirective('马上去急诊。')).toBe(true);
    expect(hasEmergencyDirective('立刻叫救护车。')).toBe(true);
    expect(hasEmergencyDirective('马上就医，不要等。')).toBe(true);
    expect(hasEmergencyDirective('立即拨打911。')).toBe(true);
  });

  it('rejects a body that only names the non-urgent nurse line', () => {
    expect(hasEmergencyDirective('Probably viral, watch and wait, call 811 if worried.')).toBe(false);
    expect(hasEmergencyDirective('Call 811 any time to talk it through with a nurse.')).toBe(false);
    expect(hasEmergencyDirective('Keep an eye on her and use your judgement.')).toBe(false);
  });

  /**
   * The FR/ZH half of the same refusal, and the reason the French matcher is written
   * around DIRECTIVES ("aux urgences", "soins d'urgence") rather than around the bare noun
   * "urgence": a body that says "ce n'est pas une urgence" contains the word and escalates
   * nothing, so a bare-noun matcher would wave through exactly the under-escalation this
   * check exists to catch.
   */
  it('rejects a soft FR/ZH line that names only the nurse line', () => {
    expect(hasEmergencyDirective('Appelle le 811 si inquiet.')).toBe(false);
    expect(
      hasEmergencyDirective("Ce n'est pas une urgence - surveille-la et appelle le 811."),
    ).toBe(false);
    expect(hasEmergencyDirective('Surveillez-la à la maison et appelez le 811 au besoin.')).toBe(
      false,
    );
    expect(hasEmergencyDirective('在家观察即可，有疑问可拨打811咨询护士。')).toBe(false);
  });
});

const RED_FLAG_SANITIZE = {
  clinical_query: 'rapid breathing with rib retractions and dusky lips',
  age_band: 'preschooler',
  duration: '1 hour',
};

/**
 * The escalation invariant, end-to-end: a genuine red flag whose composed body names 811
 * but never says "seek emergency care" is an under-escalation, and it must fall CLOSED to
 * the fixed line (which itself names 911) rather than ship. Paired with a positive control:
 * the same red flag WITH a real directive ships.
 */
describe('a detected red flag must be escalated (runtime invariant)', () => {
  it('falls closed when a red-flag body under-escalates (811 present, no emergency directive)', async () => {
    const log = quiet();
    const underEscalated = {
      answer: 'A cough like this at this age is usually just a viral thing, watch and wait.',
      triage: 'Call 811 any time to talk it through with a nurse if you stay worried.',
    };
    const out = await createMedicalComposer(
      makeClient({
        sanitize: sanitizeResult(RED_FLAG_SANITIZE),
        ground: groundResult(2),
        compose: composeResult(underEscalated),
      }),
    ).answer('raw message');

    expect(out).toEqual({ reply: SAFETY_REPLY, replySource: 'fixed' });
    const reasons = log.mock.calls.map((c) => (c[0] as { reason?: string })?.reason);
    expect(reasons).toContain('under_escalated');
    log.mockRestore();
  });

  it('positive control: the same red flag ships when the body carries a real directive', async () => {
    const out = await createMedicalComposer(
      makeClient({
        sanitize: sanitizeResult(RED_FLAG_SANITIZE),
        ground: groundResult(2),
        compose: composeResult(OK_COMPOSE),
      }),
    ).answer('raw message');

    expect(out.replySource).toBe('web_grounded');
    expect(out.reply).toContain('911');
  });

  /**
   * The same invariant with the answer written in the parent's language — the pair that
   * proves the escalation gate reads the body it is actually given. The Chinese directive
   * carries NO 911 digits on purpose: if the gate were still English-keyed it would read
   * a correct Chinese emergency answer as an under-escalation and fall it closed, and it
   * would read the Chinese under-escalation below the same way. One of those is a bug and
   * the other is the whole point, so both are asserted.
   */
  it('ships a red-flag answer whose emergency directive is Chinese, with no 911 digits', async () => {
    const out = await createMedicalComposer(
      makeClient({
        sanitize: sanitizeResult({ ...RED_FLAG_SANITIZE, language: 'zh' }),
        ground: groundResult(2),
        compose: composeResult({
          answer: '呼吸急促、肋骨凹陷和嘴唇发紫是呼吸窘迫的表现，请立即就医。',
          triage: '马上去急诊，不要在家等待。非紧急的问题可以拨打811咨询护士。',
        }),
      }),
    ).answer('raw message');

    expect(out.replySource).toBe('web_grounded');
    expect(out.reply).toContain('急诊');
  });

  it('falls closed on a Chinese under-escalation (811 named, no emergency directive)', async () => {
    const log = quiet();
    const out = await createMedicalComposer(
      makeClient({
        sanitize: sanitizeResult({ ...RED_FLAG_SANITIZE, language: 'zh' }),
        ground: groundResult(2),
        compose: composeResult({
          answer: '这多半只是普通病毒感染，在家观察就好。',
          triage: '如果你仍然担心，可以拨打811咨询护士。',
        }),
      }),
    ).answer('raw message');

    expect(out).toEqual({ reply: SAFETY_REPLY, replySource: 'fixed' });
    const reasons = log.mock.calls.map((c) => (c[0] as { reason?: string })?.reason);
    expect(reasons).toContain('under_escalated');
    log.mockRestore();
  });

  it('falls closed on a French under-escalation, and ships the French escalation', async () => {
    const log = quiet();
    const softFrench = {
      answer: "C'est probablement viral et il n'y a rien d'inquiétant pour l'instant.",
      triage: "Ce n'est pas une urgence - surveillez-la et appelez le 811 au besoin.",
    };
    expect(
      await createMedicalComposer(
        makeClient({
          sanitize: sanitizeResult({ ...RED_FLAG_SANITIZE, language: 'fr' }),
          ground: groundResult(2),
          compose: composeResult(softFrench),
        }),
      ).answer('raw message'),
    ).toEqual({ reply: SAFETY_REPLY, replySource: 'fixed' });
    log.mockRestore();

    const escalated = await createMedicalComposer(
      makeClient({
        sanitize: sanitizeResult({ ...RED_FLAG_SANITIZE, language: 'fr' }),
        ground: groundResult(2),
        compose: composeResult({
          answer:
            'Emmenez-la aux urgences maintenant: des tirages et des lèvres bleuâtres sont des signes de détresse respiratoire.',
          triage:
            'Composez le 911 si elle a du mal à respirer. Le 811 reste là pour les questions non urgentes.',
        }),
      }),
    ).answer('raw message');
    expect(escalated.replySource).toBe('web_grounded');
    expect(escalated.reply).toContain('urgences');
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

  it('grounds the SCRUBBED query, not the raw sanitizer output, when residual PII survives', async () => {
    const seen: Seen[] = [];
    // The blind sanitizer missed a phone number the parent typed into their message.
    await createMedicalComposer(
      makeClient(
        {
          sanitize: sanitizeResult({
            clinical_query: 'rash on trunk, call 416-555-1234',
            age_band: 'toddler',
          }),
          ground: groundResult(2),
          compose: composeResult(OK_COMPOSE),
        },
        seen,
      ),
    ).answer('raw message');

    const ground = seen.find(
      (s) => Array.isArray(s.tools) && s.tools[0]?.type === 'web_search_20250305',
    );
    // The backstop stripped the phone before the border...
    expect(ground?.userMessage).not.toContain('416-555-1234');
    expect(ground?.userMessage).toContain('[redacted]');
    // ...while the symptom that makes the search useful survived (positive control).
    expect(ground?.userMessage).toContain('rash');
  });
});

/**
 * The parent's language is decided by the ONE stage that sees their words, and it travels
 * to the composer alone. It is deliberately kept out of the search: `clinical_query` and
 * `duration` are English by contract (the red-flag lexicon and the pediatric search are
 * English-keyed), so a language tag on the search turn could only invite the model to
 * answer the search in French — it buys nothing and risks the one field the safety gate
 * reads. Compose is where it belongs, because compose is what writes to the parent.
 */
describe('the parent language reaches compose and nothing else', () => {
  it('carries the sanitizer-detected language into the compose payload only', async () => {
    const seen: Seen[] = [];
    await createMedicalComposer(
      makeClient(
        {
          sanitize: sanitizeResult({ ...OK_SANITIZE, language: 'fr' }),
          ground: groundResult(2),
          compose: composeResult(OK_COMPOSE),
        },
        seen,
      ),
    ).answer('raw message');

    const compose = seen.find((s) => s.toolChoice === 'medical_answer');
    expect(compose?.userMessage).toContain('"language":"fr"');
    const ground = seen.find(
      (s) => Array.isArray(s.tools) && s.tools[0]?.type === 'web_search_20250305',
    );
    expect(ground?.userMessage).not.toContain('language');
    // positive control: the search still got the clinical query it exists to run.
    expect(ground?.userMessage).toContain('fever');
  });

  it('falls back to English when the sanitizer omits or garbles the language', async () => {
    const seen: Seen[] = [];
    await createMedicalComposer(
      makeClient(
        {
          sanitize: sanitizeResult(OK_SANITIZE), // no language field at all
          ground: groundResult(2),
          compose: composeResult(OK_COMPOSE),
        },
        seen,
      ),
    ).answer('raw message');
    expect(seen.find((s) => s.toolChoice === 'medical_answer')?.userMessage).toContain(
      '"language":"en"',
    );

    const garbled: Seen[] = [];
    await createMedicalComposer(
      makeClient(
        {
          sanitize: sanitizeResult({ ...OK_SANITIZE, language: 'Klingon' }),
          ground: groundResult(2),
          compose: composeResult(OK_COMPOSE),
        },
        garbled,
      ),
    ).answer('raw message');
    expect(garbled.find((s) => s.toolChoice === 'medical_answer')?.userMessage).toContain(
      '"language":"en"',
    );
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
  /**
   * The gate that used to stand here refused any body that was not GSM-7, which meant a
   * French answer with one "ç" and every Chinese answer ever written fell closed to the
   * English safety line. What makes a message sendable is not its alphabet, it is what the
   * carrier will bill and deliver: `smsSegments` counts UCS-2 bodies in their own currency
   * (67 units a part against GSM-7's 153), so ONE ceiling is correct in all three
   * languages — the same move answer.ts made for the general answer.
   */
  it('ships a Chinese body inside the UCS-2 segment budget', async () => {
    const out = await createMedicalComposer(
      makeClient({
        sanitize: sanitizeResult({ ...OK_SANITIZE, language: 'zh' }),
        ground: groundResult(2),
        compose: composeResult({
          answer: '这个年龄发烧几天多半是病毒感染，多喝水、多休息通常就能过去。',
          triage:
            '有疑问随时拨打811找护士。如果出现呼吸困难、叫不醒或嘴唇发紫，请立即拨打911或去急诊。',
        }),
      }),
    ).answer('raw message');

    expect(out.replySource).toBe('web_grounded');
    expect(out.reply).toContain('811');
    expect(out.reply).toContain('急诊');
  });

  it('ships an accented French body', async () => {
    const out = await createMedicalComposer(
      makeClient({
        sanitize: sanitizeResult({ ...OK_SANITIZE, language: 'fr' }),
        ground: groundResult(2),
        compose: composeResult({
          answer:
            "Une fièvre de quelques jours à cet âge est le plus souvent virale; l'hydratation et le repos suffisent en général.",
          triage:
            'Appelez le 811 pour parler à une infirmière. Composez le 911 ou allez aux urgences si elle respire mal ou ne se réveille pas.',
        }),
      }),
    ).answer('raw message');

    expect(out.replySource).toBe('web_grounded');
    expect(out.reply).toContain('fièvre');
    expect(out.reply).toContain('811');
  });

  /**
   * The other half of that move: the ceiling is counted in the body's OWN currency. 400
   * Chinese characters is well under the skill's 600-character English budget and more
   * than SEVEN UCS-2 segments, so a gate that had been left counting characters would wave
   * this through.
   */
  it('falls closed when a UCS-2 body runs past the UCS-2 segment ceiling', async () => {
    const log = quiet();
    const out = await createMedicalComposer(
      makeClient({
        sanitize: sanitizeResult({ ...OK_SANITIZE, language: 'zh' }),
        ground: groundResult(2),
        compose: composeResult({
          answer: '宝宝发烧的时候要多喝水多休息。'.repeat(27),
          triage: '有疑问可拨打811，紧急情况请拨打911。',
        }),
      }),
    ).answer('raw message');

    expect(out).toEqual({ reply: SAFETY_REPLY, replySource: 'fixed' });
    // Closed by the SEGMENT gate, not for missing triage: the triage names both numbers.
    const reasons = log.mock.calls.map((c) => (c[0] as { reason?: string })?.reason);
    expect(reasons).toContain('unsendable');
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
