import { describe, expect, it, vi } from 'vitest';

vi.mock('~/lib/channel/linq/family-outbound', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/lib/channel/linq/family-outbound')>()),
  familySpeechLanguage: async () => 'en',
}));

/** A skill that cannot be loaded, switched on per test: the real loader otherwise. */
const skillLoad = vi.hoisted(() => ({ fail: false }));
vi.mock('~/lib/cron/skill', async (importOriginal) => {
  const real = await importOriginal<typeof import('~/lib/cron/skill')>();
  const guarded = <T>(load: () => Promise<T>) => {
    if (skillLoad.fail) throw new Error('skill missing');
    return load();
  };
  return {
    ...real,
    loadCronSkill: async (name: string) => guarded(() => real.loadCronSkill(name)),
    loadNudgeVoiceSkill: async () => guarded(() => real.loadNudgeVoiceSkill()),
  };
});
import type { AgentClient } from '@hale/agent';
import { smsSegments } from '~/lib/channel/sms-segments';
import type { Nudge } from './nudge-decide.js';
import {
  MAX_NUDGE_SEGMENTS,
  NUDGE_OPT_OUT,
  type VoicedNudge,
  composeNudgeMessage,
  nudgeFactSlots,
  nudgeVoiceContext,
  nudgeVoiceStrings,
  parseNudgeVoiceAnswer,
  usableNudgeMessage,
} from './nudge-voice.js';

/**
 * VIL-239 · M4 — COMPOSE's pure seam. Same contract as M3's, with one addition that
 * matters more here than anywhere else in the product: this message is UNSOLICITED,
 * so the CASL opt-out line is part of the shell and the model may not touch it.
 *
 * What is proved:
 *   - the model is handed the decision's facts and no internal identifiers;
 *   - a message that invents a time or a link, writes the opt-out line itself, or
 *     blows the segment budget once the opt-out is appended, is REJECTED;
 *   - when the model cannot write it, nothing is written: there is no fixed sentence.
 */

const REGISTRATION: Nudge = {
  kind: 'registration',
  windowRef: {
    id: 'window-uuid-1',
    municipality: 'richmond_hill',
    programDomain: 'rec_program',
    cycleLabel: 'Fall 2026',
  },
  opensAtLocal: 'Aug 5, 10:30 a.m.',
  kidNames: ['Maya', 'Leo'],
  residentNote: 'residents can register first',
  ageApproximate: false,
};

const SWAP: Nudge = {
  kind: 'weather_swap',
  candidateRef: { id: 'cand-uuid-1', title: 'Library story time', venueName: 'Riverdale Library' },
  day: 'saturday',
  kidNames: ['Maya'],
  weatherFact: 'the weekend forecast is wet',
  whyFacts: ['free', 'indoor'],
};

const DROP_IN: Nudge = {
  kind: 'weekday_dropin',
  candidateRef: { id: 'cand-uuid-3', title: 'EarlyON drop-in', venueName: 'Armour Heights' },
  eventDate: '2026-08-04',
  weekday: 'tuesday',
  kidNames: ['Mia'],
};

const SATURDAY: Nudge = {
  kind: 'empty_saturday',
  kidName: 'Maya',
  saturday: '2026-10-10',
  candidateId: 'sat-1',
  title: 'Fanous Lantern Craft',
  venueName: 'North York Central Library',
  whenLabel: '2:00 p.m.',
  url: 'https://tpl.example/lantern',
};

describe('nudgeVoiceContext', () => {
  it('hands the model the facts and no internal identifiers', () => {
    const context = JSON.stringify(nudgeVoiceContext(SWAP));
    expect(context).toContain('Library story time');
    expect(context).toContain('the weekend forecast is wet');
    expect(context).not.toContain('cand-uuid-1');
  });

  it('names the town rather than the internal municipality token', () => {
    const context = JSON.stringify(nudgeVoiceContext(REGISTRATION));
    expect(context).toContain('Richmond Hill');
    expect(context).not.toContain('richmond_hill');
  });

  it('tells the model which kind of nudge it is writing', () => {
    expect((nudgeVoiceContext(REGISTRATION) as { kind: string }).kind).toBe('registration');
    expect((nudgeVoiceContext(SWAP) as { kind: string }).kind).toBe('weather_swap');
    expect((nudgeVoiceContext(DROP_IN) as { kind: string }).kind).toBe('weekday_dropin');
  });

  /** The weekday find's context carries a DAY and no date and no time: the row it came
   * from has neither in a form this message may state, and a model handed the ISO key
   * would put it in the text. */
  it('hands the weekday find its day and withholds the raw date', () => {
    const context = JSON.stringify(nudgeVoiceContext(DROP_IN));
    expect(context).toContain('tuesday');
    expect(context).toContain('EarlyON drop-in');
    expect(context).not.toContain('2026-08-04');
    expect(context).not.toContain('cand-uuid-3');
  });
});

describe('nudgeFactSlots', () => {
  it('lists every renderable fact so the lint can ground the voice against them', () => {
    expect(nudgeFactSlots(REGISTRATION)).toEqual(
      expect.arrayContaining(['Richmond Hill', 'Fall 2026', 'Aug 5, 10:30 a.m.', 'Maya', 'Leo']),
    );
    expect(nudgeFactSlots(SWAP)).toEqual(
      expect.arrayContaining([
        'Library story time',
        'Riverdale Library',
        'the weekend forecast is wet',
      ]),
    );
  });

  it('grounds the weekday find on its day, its title and its venue', () => {
    expect(nudgeFactSlots(DROP_IN)).toEqual(
      expect.arrayContaining(['EarlyON drop-in', 'tuesday', 'Armour Heights', 'Mia']),
    );
    expect(nudgeFactSlots(DROP_IN)).not.toContain('2026-08-04');
  });

  it('carries no internal identifier a model could echo', () => {
    expect(nudgeFactSlots(SWAP)).not.toContain('cand-uuid-1');
    expect(nudgeFactSlots(REGISTRATION)).not.toContain('window-uuid-1');
    expect(JSON.stringify(nudgeVoiceContext(REGISTRATION))).not.toContain('window-uuid-1');
  });
});

describe('parseNudgeVoiceAnswer', () => {
  it('reads the message out of a clean JSON object', () => {
    expect(parseNudgeVoiceAnswer('{"message":"Saturday looks good."}')).toEqual({
      message: 'Saturday looks good.',
    });
  });

  it('reads it out of an object wrapped in prose', () => {
    expect(parseNudgeVoiceAnswer('Sure:\n{"message":"ok"}\nhope that helps')).toEqual({
      message: 'ok',
    });
  });

  it('rejects an extra field — the schema is strict', () => {
    expect(parseNudgeVoiceAnswer('{"message":"ok","link":"https://x.test"}')).toBeNull();
  });

  it('rejects a non-object, an empty message, and no answer at all', () => {
    expect(parseNudgeVoiceAnswer('no json here')).toBeNull();
    expect(parseNudgeVoiceAnswer('{"message":"   "}')).toBeNull();
    expect(parseNudgeVoiceAnswer(null)).toBeNull();
  });
});

describe('usableNudgeMessage', () => {
  it('accepts a grounded, short message', () => {
    expect(
      usableNudgeMessage('Library story time at Riverdale Library on Saturday suits Maya.', SWAP),
    ).toBe(true);
  });

  it('rejects a message that invents a time nobody gave it', () => {
    expect(usableNudgeMessage('Library story time starts at 9:15 on Saturday.', SWAP)).toBe(false);
  });

  it('rejects a message that invents a link', () => {
    expect(
      usableNudgeMessage('Register at https://richmondhill.example.ca now.', REGISTRATION),
    ).toBe(false);
  });

  it('rejects a message that writes the opt-out line the shell appends', () => {
    expect(usableNudgeMessage(`Saturday looks good. ${NUDGE_OPT_OUT}`, SWAP)).toBe(false);
  });

  it('rejects a message that blows the segment budget once the opt-out is appended', () => {
    const long = 'Library story time suits Maya. '.repeat(20);
    expect(smsSegments(`${long}\n\n${NUDGE_OPT_OUT}`)).toBeGreaterThan(MAX_NUDGE_SEGMENTS);
    expect(usableNudgeMessage(long, SWAP)).toBe(false);
  });
});

describe('nudgeVoiceStrings', () => {
  it('exposes the one user-facing string for the lint', () => {
    expect(nudgeVoiceStrings({ message: 'hello' })).toEqual(['hello']);
  });
});

describe('composeNudgeMessage — weekday care', () => {
  it('does not send a template when there is no model', async () => {
    const message = await composeNudgeMessage(
      { kind: 'weekday_care', ask: { prompt: 'weekend_fallback' } },
      { familyId: 'fam-1', database: {} as never, client: null },
    );
    expect(message).toEqual({ unwritten: 'no_client' });
  });

  it('names a skill that will not load instead of throwing out of the sweep', async () => {
    skillLoad.fail = true;
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const written = await composeNudgeMessage(
        { kind: 'weekday_care', ask: { prompt: 'weekend_fallback' } },
        { familyId: 'fam-1', database: {} as never, client: answering('{"message":"unread"}') },
      );
      expect(written).toEqual({ unwritten: 'skill_load' });
    } finally {
      skillLoad.fail = false;
      errors.mockRestore();
    }
  });

  it('counts an answer that came back unreadable as a bad draft, not an outage', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const written = await composeNudgeMessage(
      { kind: 'weekday_care', ask: { prompt: 'weekend_fallback' } },
      { familyId: 'fam-1', database: {} as never, client: answering('this is not json') },
    );
    const logged = errors.mock.calls.find(
      ([, line]) => line === 'nudge: weekday ask model call failed - unvoiced',
    );
    errors.mockRestore();
    expect(logged?.[0]).toEqual({ err: 'StructuredOutputError', familyId: 'fam-1' });
    expect(written).toEqual({ unwritten: 'unusable' });
  });

  it('logs a failed model call by its error class, never the message', async () => {
    class ProviderError extends Error {
      status = 400;
    }
    const fail = () => {
      throw new ProviderError('400 invalid request: "prompt":"QUOTED-REQUEST"');
    };
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const message = await composeNudgeMessage(
      { kind: 'weekday_care', ask: { prompt: 'weekend_fallback' } },
      {
        familyId: 'fam-1',
        database: {} as never,
        client: { messages: { create: fail, stream: fail } } as never,
      },
    );
    expect(message).toEqual({ unwritten: 'model_failed' });
    const logged = errors.mock.calls.find(
      ([, line]) => line === 'nudge: weekday ask model call failed - unvoiced',
    );
    expect(logged?.[0]).toEqual({ err: 'ProviderError', familyId: 'fam-1' });
    expect(JSON.stringify(errors.mock.calls)).not.toContain('QUOTED-REQUEST');
    errors.mockRestore();
  });

  it('a draft the check refuses sends nothing', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const written = await composeNudgeMessage(
      { kind: 'weekday_care', ask: { prompt: 'weekend_fallback' } },
      {
        familyId: 'fam-1',
        database: {} as never,
        client: answering(JSON.stringify({ message: 'Want weekday stuff too? Tuesday at 9:15?' })),
      },
    );
    errors.mockRestore();
    expect(written).toEqual({ unwritten: 'unusable' });
  });

  it('positive control: a good draft is what goes out, word for word', async () => {
    // Claude's own answer for this ask (weekday-care-ask eval, weekend-fallback).
    const draft =
      "Hey, I just noticed everything I've sent you so far has been for the weekend. Want me to look at weekday stuff too?";
    const written = await composeNudgeMessage(
      { kind: 'weekday_care', ask: { prompt: 'weekend_fallback' } },
      {
        familyId: 'fam-1',
        database: {} as never,
        client: answering(JSON.stringify({ message: draft })),
      },
    );
    expect(written).toEqual({ message: draft });
  });
});

/**
 * The transport only: the fake drives the seam and its failure paths (rule #8). What
 * the model writes is the cached-real nudge eval's job (apps/worker/evals).
 */
function answering(text: string): AgentClient {
  return {
    messages: {
      create: vi.fn(async () => ({
        content: [{ type: 'text', text }],
        usage: { input_tokens: 100, output_tokens: 20 },
      })),
    },
  } as unknown as AgentClient;
}

const failingCall = {
  messages: {
    create: vi.fn(async () => {
      throw new Error('model unavailable');
    }),
  },
} as unknown as AgentClient;

/** Just enough database for composeVoice to record its agent_runs row. */
const agentRunsDb = {
  insert: () => ({ values: () => ({ returning: async () => [{ id: 'run-1' }] }) }),
} as never;

describe('composeNudgeMessage — when the model cannot write it, nothing is written', () => {
  const KINDS: Array<[string, VoicedNudge, string]> = [
    ['registration', REGISTRATION, 'Fall 2026 registration opens at 9:15.'],
    ['weather_swap', SWAP, 'Library story time starts at 9:15 on Saturday.'],
    ['weekday_dropin', DROP_IN, 'EarlyON drop-in starts at 9:15 on Tuesday.'],
    ['empty_saturday', SATURDAY as VoicedNudge, 'Fanous Lantern Craft starts at 9:15 on Saturday.'],
  ];

  it.each(KINDS)('%s: no client', async (_kind, nudge) => {
    const written = await composeNudgeMessage(nudge, {
      familyId: 'fam-1',
      database: agentRunsDb,
      client: null,
    });
    expect(written).toEqual({ unwritten: 'no_client' });
  });

  it.each(KINDS)('%s: the skill would not load', async (_kind, nudge) => {
    skillLoad.fail = true;
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const written = await composeNudgeMessage(nudge, {
        familyId: 'fam-1',
        database: agentRunsDb,
        client: answering('{"message":"never read"}'),
      });
      expect(written).toEqual({ unwritten: 'skill_load' });
    } finally {
      skillLoad.fail = false;
      errors.mockRestore();
    }
  });

  it.each(KINDS)('%s: a draft that fails the check', async (_kind, nudge, draft) => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const written = await composeNudgeMessage(nudge, {
      familyId: 'fam-1',
      database: agentRunsDb,
      client: answering(JSON.stringify({ message: draft })),
    });
    errors.mockRestore();
    expect(written).toEqual({ unwritten: 'unusable' });
  });

  it('a draft that passes the fact lint but writes the opt-out line', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const written = await composeNudgeMessage(SWAP, {
      familyId: 'fam-1',
      database: agentRunsDb,
      client: answering(JSON.stringify({ message: `Saturday looks good. ${NUDGE_OPT_OUT}` })),
    });
    errors.mockRestore();
    expect(written).toEqual({ unwritten: 'unusable' });
  });

  it('a model call that throws is named apart from a bad draft', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const written = await composeNudgeMessage(REGISTRATION, {
      familyId: 'fam-1',
      database: agentRunsDb,
      client: failingCall,
    });
    errors.mockRestore();
    expect(written).toEqual({ unwritten: 'model_failed' });
  });

  it('positive control: a good draft is what goes out, word for word', async () => {
    // Claude's own answer for this fixture (nudge eval, 2kid-window-soon-resident-head-start).
    const draft =
      'Richmond Hill Fall 2026 registration opens Aug 5, 10:30 a.m. for Maya and Leo - residents can register first.';
    const written = await composeNudgeMessage(REGISTRATION, {
      familyId: 'fam-1',
      database: agentRunsDb,
      client: answering(JSON.stringify({ message: draft })),
    });
    expect(written).toEqual({ message: draft });
  });
});

describe('composeNudgeMessage — empty Saturday', () => {
  const GOOD_DRAFT =
    'Maya could make Fanous Lantern Craft at North York Central Library on Saturday at 2:00 p.m.';

  it('does not fall back to the fixed sentence when there is no model', async () => {
    const message = await composeNudgeMessage(SATURDAY, {
      familyId: 'fam-1',
      database: {} as never,
      client: null,
    });
    expect(message).toEqual({ unwritten: 'no_client' });
  });

  it('a model call that throws is named apart from a bad draft', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const written = await composeNudgeMessage(SATURDAY, {
      familyId: 'fam-1',
      database: agentRunsDb,
      client: failingCall,
    });
    errors.mockRestore();
    expect(written).toEqual({ unwritten: 'model_failed' });
  });

  it.each([
    ['does not name the session', 'Maya could make a craft at the library on Saturday.'],
    ['writes the opt-out line', `Fanous Lantern Craft on Saturday suits Maya. ${NUDGE_OPT_OUT}`],
  ])('a draft that passes the fact lint but %s sends nothing', async (_why, draft) => {
    const written = await composeNudgeMessage(SATURDAY, {
      familyId: 'fam-1',
      database: agentRunsDb,
      client: answering(JSON.stringify({ message: draft })),
    });
    expect(written).toEqual({ unwritten: 'unusable' });
  });

  it('positive control: a good draft goes out word for word, with its link', async () => {
    const written = await composeNudgeMessage(SATURDAY, {
      familyId: 'fam-1',
      database: agentRunsDb,
      client: answering(JSON.stringify({ message: GOOD_DRAFT })),
    });
    expect(written).toEqual({ message: `${GOOD_DRAFT} https://tpl.example/lantern` });
  });
});
