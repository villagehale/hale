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
import { OPT_OUT_LINE as NUDGE_OPT_OUT } from '~/lib/channel/opt-out';
import { writeNudgeModelOnly } from './model-only';
import type { Nudge } from './nudge-decide.js';
import type { VoicedNudge } from './nudge-voice.js';

/**
 * The flag-on writer (NUDGE_MODEL_ONLY_ENABLED): when the model cannot write the nudge,
 * nothing is written and the reason is named. The fixed sentence and segment budget of
 * the flag-off path are pinned, unmodified, in nudge-voice.test.ts.
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

describe('writeNudgeModelOnly — weekday care', () => {
  it('does not send a template when there is no model', async () => {
    const message = await writeNudgeModelOnly(
      { kind: 'weekday_care', ask: { prompt: 'weekend_fallback' } },
      { familyId: 'fam-1', database: {} as never, client: null },
    );
    expect(message).toEqual({ unwritten: 'no_client' });
  });

  it('names a skill that will not load instead of throwing out of the sweep', async () => {
    skillLoad.fail = true;
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const written = await writeNudgeModelOnly(
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
    const written = await writeNudgeModelOnly(
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
    const message = await writeNudgeModelOnly(
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
    const written = await writeNudgeModelOnly(
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
    const written = await writeNudgeModelOnly(
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

describe('writeNudgeModelOnly — when the model cannot write it, nothing is written', () => {
  const KINDS: Array<[string, VoicedNudge, string]> = [
    ['registration', REGISTRATION, 'Fall 2026 registration opens at 9:15.'],
    ['weather_swap', SWAP, 'Library story time starts at 9:15 on Saturday.'],
    ['weekday_dropin', DROP_IN, 'EarlyON drop-in starts at 9:15 on Tuesday.'],
    ['empty_saturday', SATURDAY as VoicedNudge, 'Fanous Lantern Craft starts at 9:15 on Saturday.'],
  ];

  it.each(KINDS)('%s: no client', async (_kind, nudge) => {
    const written = await writeNudgeModelOnly(nudge, {
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
      const written = await writeNudgeModelOnly(nudge, {
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
    const written = await writeNudgeModelOnly(nudge, {
      familyId: 'fam-1',
      database: agentRunsDb,
      client: answering(JSON.stringify({ message: draft })),
    });
    errors.mockRestore();
    expect(written).toEqual({ unwritten: 'unusable' });
  });

  it('a draft that passes the fact lint but writes the opt-out line', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const written = await writeNudgeModelOnly(SWAP, {
      familyId: 'fam-1',
      database: agentRunsDb,
      client: answering(JSON.stringify({ message: `Saturday looks good. ${NUDGE_OPT_OUT}` })),
    });
    errors.mockRestore();
    expect(written).toEqual({ unwritten: 'unusable' });
  });

  it('a correct draft naming a child outside the SMS alphabet goes out word for word', async () => {
    const draft =
      'Zoë could do Library story time at Riverdale Library on Saturday, since the weekend forecast is wet and it is free, indoors and easy to drop into.';
    const written = await writeNudgeModelOnly({ ...SWAP, kidNames: ['Zoë'] } as VoicedNudge, {
      familyId: 'fam-1',
      database: agentRunsDb,
      client: answering(JSON.stringify({ message: draft })),
    });
    expect(written).toEqual({ message: draft });
  });

  it('a model call that throws is named apart from a bad draft', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const written = await writeNudgeModelOnly(REGISTRATION, {
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
    const written = await writeNudgeModelOnly(REGISTRATION, {
      familyId: 'fam-1',
      database: agentRunsDb,
      client: answering(JSON.stringify({ message: draft })),
    });
    expect(written).toEqual({ message: draft });
  });
});

describe('writeNudgeModelOnly — empty Saturday', () => {
  const GOOD_DRAFT =
    'Maya could make Fanous Lantern Craft at North York Central Library on Saturday at 2:00 p.m.';

  it('does not fall back to the fixed sentence when there is no model', async () => {
    const message = await writeNudgeModelOnly(SATURDAY, {
      familyId: 'fam-1',
      database: {} as never,
      client: null,
    });
    expect(message).toEqual({ unwritten: 'no_client' });
  });

  it('a model call that throws is named apart from a bad draft', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const written = await writeNudgeModelOnly(SATURDAY, {
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
    const written = await writeNudgeModelOnly(SATURDAY, {
      familyId: 'fam-1',
      database: agentRunsDb,
      client: answering(JSON.stringify({ message: draft })),
    });
    expect(written).toEqual({ unwritten: 'unusable' });
  });

  it('a correct draft is not refused for its length once the link is on it', async () => {
    const draft =
      'Zoë could make Fanous Lantern Craft at North York Central Library on Saturday at 2:00 p.m.';
    const written = await writeNudgeModelOnly({ ...SATURDAY, kidName: 'Zoë' } as VoicedNudge, {
      familyId: 'fam-1',
      database: agentRunsDb,
      client: answering(JSON.stringify({ message: draft })),
    });
    expect(written).toEqual({ message: `${draft} https://tpl.example/lantern` });
  });

  it('positive control: a good draft goes out word for word, with its link', async () => {
    const written = await writeNudgeModelOnly(SATURDAY, {
      familyId: 'fam-1',
      database: agentRunsDb,
      client: answering(JSON.stringify({ message: GOOD_DRAFT })),
    });
    expect(written).toEqual({ message: `${GOOD_DRAFT} https://tpl.example/lantern` });
  });
});
