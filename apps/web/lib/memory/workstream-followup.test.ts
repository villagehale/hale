import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type Anthropic from '@anthropic-ai/sdk';
import { type AgentClient, type Skill, runAgent } from '@hale/agent';
import type { Database } from '@hale/db';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { groupCapResetsAt } from '~/lib/channel/linq/family-outbound';
import { OPT_OUT_LINE, OPT_OUT_SHORT } from '~/lib/channel/opt-out';
import type { OutboundGatePorts } from '~/lib/channel/outbound-gate';
import {
  composeWorkstreamFollowup,
  followupBackoffUntil,
  followupRefusal,
  inventedHalePromise,
  promisedPassedWeekday,
  runWorkstreamFollowupSweep,
  workstreamHoldUntil,
} from './workstream-followup';
import { WORKSTREAMS_ENABLED_ENV, activeWorkstreamBlock, haleActionNextStep } from './workstreams';

/** 11:00 in Toronto, 00:00 in Tokyo. Quiet hours are 21:00–08:00 local. */
const NOW = new Date('2026-08-12T15:00:00.000Z');
const FAMILY = '11111111-1111-4111-8111-111111111111';
const TITLE = 'Saturday swim for Sebastian near L7G';

function usage(): Anthropic.Usage {
  return {
    input_tokens: 8,
    output_tokens: 8,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
    server_tool_use: null,
  };
}

function toolMessage(body: string): Anthropic.Message {
  return {
    id: 'msg-voice',
    type: 'message',
    role: 'assistant',
    model: 'claude-haiku',
    stop_reason: 'end_turn',
    stop_sequence: null,
    content: [{ type: 'tool_use', id: 'toolu_voice', name: 'write_followup', input: { body } }],
    usage: usage(),
  };
}

function gate(timeZone: string, sends = 0): OutboundGatePorts {
  return {
    channelEnrolled: async () => true,
    watchConsentGranted: async () => true,
    countProactiveSends: async () => sends,
    proactiveSentSince: async () => false,
    parentTimeZone: async () => timeZone,
  };
}

const due = {
  id: '22222222-2222-4222-8222-222222222222',
  familyId: FAMILY,
  title: TITLE,
  status: 'waiting_on_parent' as const,
  nextStep: 'parent has not picked',
  checkBackAt: new Date('2026-08-12T14:00:00.000Z'),
  childIds: [],
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('workstream follow-up sweep', () => {
  it('does nothing, and reads nothing, unless the flag is exactly true', async () => {
    const listDue = vi.fn();
    vi.stubEnv(WORKSTREAMS_ENABLED_ENV, 'true\n');
    const off = await runWorkstreamFollowupSweep({} as Database, { listDue });
    expect(off.enabled).toBe(false);
    expect(listDue).not.toHaveBeenCalled();

    const touched = {
      select: () => {
        throw new Error('touched');
      },
    } as unknown as Database;
    expect(await activeWorkstreamBlock(touched, FAMILY, NOW)).toBeNull();
  });

  it('holds a due check-back through quiet hours and does not compose', async () => {
    vi.stubEnv(WORKSTREAMS_ENABLED_ENV, 'true');
    const compose = vi.fn();
    const deliver = vi.fn();
    const result = await runWorkstreamFollowupSweep({} as Database, {
      now: () => NOW,
      listDue: async () => [due],
      f14: () => true,
      linkedTeen: async () => false,
      parentFor: async () => 'user-1',
      dedupeActive: async () => false,
      buildGate: () => gate('Asia/Tokyo'),
      compose,
      deliver,
    });
    expect(result.held.quiet_hours).toBe(1);
    expect(result.sent).toBe(0);
    expect(compose).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
  });

  it('holds when the family already had a follow-up today', async () => {
    vi.stubEnv(WORKSTREAMS_ENABLED_ENV, 'true');
    const compose = vi.fn();
    const result = await runWorkstreamFollowupSweep({} as Database, {
      now: () => NOW,
      listDue: async () => [due],
      f14: () => true,
      linkedTeen: async () => false,
      parentFor: async () => 'user-1',
      dedupeActive: async () => false,
      buildGate: () => gate('America/Toronto', 1),
      compose,
    });
    expect(result.held.frequency_cap).toBe(1);
    expect(compose).not.toHaveBeenCalled();
  });

  it('sends nothing and pages #ops when the model fails twice', async () => {
    vi.stubEnv(WORKSTREAMS_ENABLED_ENV, 'true');
    const pages: string[] = [];
    const deferred: Array<{ attempt: number; until: string }> = [];
    const deliver = vi.fn();
    const stamp = vi.fn(async () => undefined);
    const result = await runWorkstreamFollowupSweep({} as Database, {
      now: () => NOW,
      listDue: async () => [due],
      f14: () => true,
      linkedTeen: async () => false,
      parentFor: async () => 'user-1',
      dedupeActive: async () => false,
      buildGate: () => gate('America/Toronto'),
      compose: async () => ({ ok: false, reason: 'model_failed' }),
      deliver,
      stamp,
      pendingDeferral: async () => null,
      defer: async (_db, input) => {
        deferred.push({ attempt: input.attempt, until: input.until.toISOString() });
      },
      alreadyPaged: async () => false,
      noteUnsent: async () => undefined,
      page: async (text) => {
        pages.push(text);
      },
    });
    expect(result.skipped.compose_failed).toBe(1);
    expect(result.sent).toBe(0);
    expect(deliver).not.toHaveBeenCalled();
    expect(stamp).not.toHaveBeenCalled();
    expect(deferred).toEqual([{ attempt: 1, until: followupBackoffUntil(1, NOW).toISOString() }]);
    expect(pages).toEqual([`workstream followup unsent family=${FAMILY} reason=model_failed`]);
    expect(pages[0]).not.toContain(TITLE);
    expect(pages[0]).not.toContain('Sebastian');
  });

  it('stamps a declined check-back without paging #ops', async () => {
    vi.stubEnv(WORKSTREAMS_ENABLED_ENV, 'true');
    const page = vi.fn();
    const stamp = vi.fn(async () => undefined);
    const result = await runWorkstreamFollowupSweep({} as Database, {
      now: () => NOW,
      listDue: async () => [due],
      f14: () => true,
      linkedTeen: async () => false,
      parentFor: async () => 'user-1',
      dedupeActive: async () => false,
      buildGate: () => gate('America/Toronto'),
      compose: async () => ({ ok: false, reason: 'empty' }),
      pendingDeferral: async () => null,
      stamp,
      page,
    });
    expect(result.skipped.nothing_to_say).toBe(1);
    expect(stamp).toHaveBeenCalledTimes(1);
    expect(page).not.toHaveBeenCalled();
  });

  it('does not back off a missing model client', async () => {
    vi.stubEnv(WORKSTREAMS_ENABLED_ENV, 'true');
    const stamp = vi.fn(async () => undefined);
    const page = vi.fn();
    const result = await runWorkstreamFollowupSweep({} as Database, {
      now: () => NOW,
      listDue: async () => [due],
      f14: () => true,
      linkedTeen: async () => false,
      parentFor: async () => 'user-1',
      dedupeActive: async () => false,
      buildGate: () => gate('America/Toronto'),
      compose: async () => ({ ok: false, reason: 'not_configured' }),
      pendingDeferral: async () => null,
      stamp,
      page,
    });
    expect(result.skipped.not_configured).toBe(1);
    expect(stamp).not.toHaveBeenCalled();
    expect(page).not.toHaveBeenCalled();
  });

  it('counts a group hold as that hold and keeps it quiet until the window resets', async () => {
    vi.stubEnv(WORKSTREAMS_ENABLED_ENV, 'true');
    const deferred: Array<{ id: string; reason: string; until: string; attempt: number }> = [];
    const result = await runWorkstreamFollowupSweep({} as Database, {
      now: () => NOW,
      listDue: async () => [due, { ...due, id: '33333333-3333-4333-8333-333333333333' }],
      f14: () => true,
      linkedTeen: async () => false,
      parentFor: async () => 'user-1',
      dedupeActive: async () => false,
      buildGate: () => gate('America/Toronto'),
      pendingDeferral: async () => null,
      timeZoneFor: async () => 'America/Toronto',
      defer: async (_db, input) => {
        deferred.push({
          id: input.workstreamId,
          reason: input.reason,
          until: input.until.toISOString(),
          attempt: input.attempt,
        });
      },
      compose: async () => ({ ok: true, body: 'The camp has not written back.' }),
      resolvePhone: async () => '+14165550199',
      targetFor: async () => ({ channel: 'legacy' }),
      deliver: vi
        .fn()
        .mockResolvedValueOnce({
          status: 'held',
          reason: 'group_cap',
          until: new Date('2026-08-12T18:00:00.001Z'),
        })
        .mockResolvedValueOnce({ status: 'held', reason: 'quiet_hours' }),
    });
    expect(result.held.group_cap).toBe(1);
    expect(result.held.quiet_hours).toBe(1);
    expect(result.held.frequency_cap).toBe(0);
    expect(result.sent).toBe(0);
    expect(deferred).toEqual([
      {
        id: due.id,
        reason: 'group_cap',
        until: '2026-08-12T18:00:00.001Z',
        attempt: 0,
      },
      {
        id: '33333333-3333-4333-8333-333333333333',
        reason: 'quiet_hours',
        until: workstreamHoldUntil('quiet_hours', NOW, 'America/Toronto').toISOString(),
        attempt: 0,
      },
    ]);
  });

  it('does not compose again while a hold or a backoff is still in force', async () => {
    vi.stubEnv(WORKSTREAMS_ENABLED_ENV, 'true');
    const compose = vi.fn();
    const result = await runWorkstreamFollowupSweep({} as Database, {
      now: () => NOW,
      listDue: async () => [due],
      f14: () => true,
      linkedTeen: async () => false,
      parentFor: async () => 'user-1',
      dedupeActive: async () => false,
      buildGate: () => gate('America/Toronto'),
      pendingDeferral: async () => ({
        until: new Date(NOW.getTime() + 60_000),
        attempt: 1,
        reason: 'group_cap',
      }),
      compose,
    });
    expect(result.skipped.deferred).toBe(1);
    expect(compose).not.toHaveBeenCalled();
  });

  it('backs off a failed send, and gives up once the cap is reached', async () => {
    vi.stubEnv(WORKSTREAMS_ENABLED_ENV, 'true');
    const pages: string[] = [];
    const stamp = vi.fn(async () => undefined);
    const gaveUp: number[] = [];
    const deferred: number[] = [];
    const base = {
      now: () => NOW,
      listDue: async () => [due],
      f14: () => true,
      linkedTeen: async () => false,
      parentFor: async () => 'user-1',
      dedupeActive: async () => false,
      buildGate: () => gate('America/Toronto'),
      compose: async () => ({ ok: true as const, body: 'The camp has not written back.' }),
      resolvePhone: async () => '+14165550199',
      targetFor: async () => ({ channel: 'legacy' as const }),
      deliver: async () => ({ status: 'skipped' as const, reason: 'unavailable' }),
      stamp,
      alreadyPaged: async () => false,
      noteUnsent: async () => undefined,
      noteGaveUp: async (
        _db: Database,
        _family: string,
        _reason: string,
        _now: Date,
        _id: string,
        _at: Date,
        attempt: number,
      ) => {
        gaveUp.push(attempt);
      },
      page: async (text: string) => {
        pages.push(text);
      },
    };
    const first = await runWorkstreamFollowupSweep({} as Database, {
      ...base,
      pendingDeferral: async () => null,
      defer: async (_db, input) => {
        deferred.push(input.attempt);
      },
    });
    expect(first.failed).toBe(1);
    expect(stamp).not.toHaveBeenCalled();
    expect(deferred).toEqual([1]);
    expect(pages).toEqual([`workstream followup unsent family=${FAMILY} reason=unavailable`]);

    const last = await runWorkstreamFollowupSweep({} as Database, {
      ...base,
      alreadyPaged: async () => true,
      pendingDeferral: async () => ({
        until: new Date(NOW.getTime() - 1000),
        attempt: 2,
        reason: 'unavailable',
      }),
      defer: vi.fn(),
    });
    expect(last.failed).toBe(1);
    expect(stamp).toHaveBeenCalledTimes(1);
    expect(gaveUp).toEqual([3]);
    expect(pages).toHaveLength(1);
  });

  it('backs off a thrown send the same way, and pages once', async () => {
    vi.stubEnv(WORKSTREAMS_ENABLED_ENV, 'true');
    const pages: string[] = [];
    const stamp = vi.fn(async () => undefined);
    const gaveUp: number[] = [];
    const deferred: number[] = [];
    const compose = vi.fn(async () => ({
      ok: true as const,
      body: 'The camp has not written back.',
    }));
    const base = {
      now: () => NOW,
      listDue: async () => [due],
      f14: () => true,
      linkedTeen: async () => false,
      parentFor: async () => 'user-1',
      dedupeActive: async () => false,
      buildGate: () => gate('America/Toronto'),
      compose,
      resolvePhone: async () => '+14165550199',
      targetFor: async () => ({ channel: 'legacy' as const }),
      deliver: async () => {
        throw new Error('linq down');
      },
      stamp,
      alreadyPaged: async () => false,
      noteUnsent: async () => undefined,
      noteGaveUp: async (
        _db: Database,
        _family: string,
        _reason: string,
        _now: Date,
        _id: string,
        _at: Date,
        attempt: number,
      ) => {
        gaveUp.push(attempt);
      },
      page: async (text: string) => {
        pages.push(text);
      },
    };
    const first = await runWorkstreamFollowupSweep({} as Database, {
      ...base,
      pendingDeferral: async () => null,
      defer: async (_db, input) => {
        deferred.push(input.attempt);
      },
    });
    expect(first.failed).toBe(1);
    expect(stamp).not.toHaveBeenCalled();
    expect(gaveUp).toEqual([]);
    expect(deferred).toEqual([1]);
    expect(pages).toEqual([`workstream followup unsent family=${FAMILY} reason=send_failed`]);

    compose.mockClear();
    const quiet = await runWorkstreamFollowupSweep({} as Database, {
      ...base,
      pendingDeferral: async () => ({
        until: new Date(NOW.getTime() + 60_000),
        attempt: 1,
        reason: 'send_failed',
      }),
    });
    expect(quiet.skipped.deferred).toBe(1);
    expect(compose).not.toHaveBeenCalled();

    const last = await runWorkstreamFollowupSweep({} as Database, {
      ...base,
      alreadyPaged: async () => true,
      pendingDeferral: async () => ({
        until: new Date(NOW.getTime() - 1000),
        attempt: 2,
        reason: 'send_failed',
      }),
      defer: vi.fn(),
    });
    expect(last.failed).toBe(1);
    expect(stamp).toHaveBeenCalledTimes(1);
    expect(gaveUp).toEqual([3]);
    expect(pages).toHaveLength(1);
  });
});

describe('workstream hold windows', () => {
  it('waits out quiet hours until 08:00 and a co-parent ask until local midnight', () => {
    expect(workstreamHoldUntil('coparent_ask', NOW, 'America/Toronto').toISOString()).toBe(
      '2026-08-13T04:00:00.000Z',
    );
    expect(workstreamHoldUntil('quiet_hours', NOW, 'America/Toronto').toISOString()).toBe(
      '2026-08-13T12:00:00.000Z',
    );
    const early = new Date('2026-08-12T06:00:00.000Z');
    expect(workstreamHoldUntil('quiet_hours', early, 'America/Toronto').toISOString()).toBe(
      '2026-08-12T12:00:00.000Z',
    );
  });

  it('holds a group cap until the rolling window resets, not local midnight', () => {
    const sent = new Date('2026-08-13T14:00:00.000Z');
    const fridayMorning = new Date('2026-08-14T12:00:00.000Z');
    const until = groupCapResetsAt(
      'discretionary',
      {
        discretionaryDay: 1,
        discretionaryWeek: 1,
        ceilingToday: 1,
        discretionaryDayAt: [sent],
        discretionaryWeekAt: [sent],
        ceilingTodayAt: [sent],
      },
      fridayMorning,
    );
    expect(until.toISOString()).toBe('2026-08-14T14:00:00.001Z');

    const oldest = new Date('2026-08-08T12:00:00.000Z');
    const recent = new Date('2026-08-14T10:00:00.000Z');
    const both = groupCapResetsAt(
      'discretionary',
      {
        discretionaryDay: 1,
        discretionaryWeek: 3,
        ceilingToday: 1,
        discretionaryDayAt: [recent],
        discretionaryWeekAt: [oldest, sent, recent],
        ceilingTodayAt: [recent],
      },
      fridayMorning,
    );
    expect(both.toISOString()).toBe('2026-08-15T12:00:00.001Z');
  });
});

describe('workstream follow-up voice', () => {
  it('retries once and keeps the second sentence', async () => {
    const bodies = [
      'Just checking in on the swim.',
      'Still holding that Saturday swim if you want to pick one.',
    ];
    const client = {
      messages: {
        create: vi.fn(async () => toolMessage(bodies.shift() ?? '')),
      },
    } as unknown as AgentClient;
    const result = await composeWorkstreamFollowup({
      client,
      title: TITLE,
      status: 'waiting_on_parent',
      nextStep: 'parent has not picked',
    });
    expect(result).toEqual({
      ok: true,
      body: 'Still holding that Saturday swim if you want to pick one.',
    });
    expect(client.messages.create).toHaveBeenCalledTimes(2);
  });

  it('treats an empty draft as a skip and does not retry', async () => {
    const client = {
      messages: {
        create: vi.fn(async () => toolMessage('')),
      },
    } as unknown as AgentClient;
    const result = await composeWorkstreamFollowup({
      client,
      title: TITLE,
      status: 'waiting_on_third_party',
      nextStep: 'the camp has not written back',
      now: NOW,
      timeZone: 'America/Toronto',
    });
    expect(result).toEqual({ ok: false, reason: 'empty' });
    expect(client.messages.create).toHaveBeenCalledTimes(1);
  });

  it('folds a French sentence the way the other French sends do', async () => {
    const client = {
      messages: {
        create: vi.fn(async () =>
          toolMessage('Le camp n’a pas encore répondu — je te le dis pour la fête.'),
        ),
      },
    } as unknown as AgentClient;
    const result = await composeWorkstreamFollowup({
      client,
      title: 'inscription au camp',
      status: 'waiting_on_third_party',
      nextStep: 'le camp n’a pas écrit',
      now: NOW,
      timeZone: 'America/Toronto',
      language: 'fr',
    });
    expect(result).toEqual({
      ok: true,
      body: "Le camp n'a pas encore répondu - je te le dis pour la fete.",
    });
  });

  it('rejects a stock opener and a weekday that is already today', async () => {
    const thursday = new Date('2026-08-13T15:00:00.000Z');
    const bodies = [
      'Just checking in on the swim.',
      "I'll follow up with them Thursday.",
      'The camp still has not written back.',
    ];
    const seen: string[] = [];
    const client = {
      messages: {
        create: vi.fn(async (params: { messages?: Array<{ content?: unknown }> }) => {
          const content = params.messages?.[0]?.content;
          if (typeof content === 'string') seen.push(content);
          return toolMessage(bodies.shift() ?? '');
        }),
      },
    } as unknown as AgentClient;
    const result = await composeWorkstreamFollowup({
      client,
      title: 'camp spot',
      status: 'waiting_on_third_party',
      nextStep: 'waiting on the camp',
      now: thursday,
      timeZone: 'America/Toronto',
      language: 'en',
    });
    expect(result).toEqual({ ok: false, reason: 'past_weekday' });
    expect(seen[0]).toContain('whose_move: third_party');
    expect(seen[0]).toContain('today: 2026-08-13');
    expect(seen[0]).toContain('language: en');
    expect(seen[1]).toContain('previous attempt refused: stock_opener');
    expect(seen[2]).toBeUndefined();
  });

  it('asks an order retry to become a question, then sends nothing', async () => {
    const seen: string[] = [];
    const bodies = ['Il faut choisir entre les deux.', "Faut qu'on choisisse entre les deux."];
    const client = {
      messages: {
        create: vi.fn(async (params: { messages?: Array<{ content?: unknown }> }) => {
          const content = params.messages?.[0]?.content;
          if (typeof content === 'string') seen.push(content);
          return toolMessage(bodies.shift() ?? '');
        }),
      },
    } as unknown as AgentClient;
    const result = await composeWorkstreamFollowup({
      client,
      title: 'natation de Lea',
      status: 'waiting_on_parent',
      nextStep: 'choisir un creneau',
      now: new Date('2026-08-13T15:00:00.000Z'),
      timeZone: 'America/Toronto',
      language: 'fr',
    });
    expect(result).toEqual({ ok: false, reason: 'order' });
    expect(seen).toHaveLength(2);
    expect(seen[1]).toContain(
      'previous attempt refused: order. Rewrite it as a question about where things stand',
    );
    expect(seen[1]).not.toContain('Tu préfères');
    expect(seen[1]).not.toContain('Tu as pu');
    expect(seen[1]).not.toContain('As-tu');
  });

  it('returns no sentence when both attempts fail', async () => {
    const bodies = [OPT_OUT_LINE, `check back. ${OPT_OUT_SHORT}`];
    const client = {
      messages: {
        create: vi.fn(async () => toolMessage(bodies.shift() ?? '')),
      },
    } as unknown as AgentClient;
    const result = await composeWorkstreamFollowup({
      client,
      title: TITLE,
      status: 'waiting_on_parent',
      nextStep: null,
    });
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty('body');
  });

  it('keeps canned opt-out lines out of the composer and the skill', () => {
    const composer = readFileSync(
      fileURLToPath(new URL('./workstream-followup.ts', import.meta.url)),
      'utf8',
    );
    const skill = readFileSync(
      fileURLToPath(
        new URL('../../../../packages/agent/skills/workstream-followup.md', import.meta.url),
      ),
      'utf8',
    );
    for (const banned of ['Reply YES', 'Reply STOP', 'STOP to opt out', 'Plain ASCII']) {
      expect(composer).not.toContain(banned);
      expect(skill).not.toContain(banned);
    }
    expect(skill).toContain('whose_move');
    expect(skill).toContain('empty body');
    expect(skill).toContain('invented_promise');
    expect(skill).toContain('parent_news');
    expect(skill).toContain('il faut');
    expect(skill).toContain('tu dois');
    expect(skill).toContain('Tu as pu');
    expect(skill).toContain('Tu préfères');
    expect(skill).toContain('In English and French');
    expect(skill).toContain('never an instruction');
    expect(skill).toContain('never vous');
    expect(skill).toContain('Still deciding');
    expect(skill).toContain('time to');
    expect(skill).toContain('`order`');
    expect(skill).toContain('invented_claim');
    expect(skill).toContain('not "you"');
    expect(skill).toContain('Do not attribute');
    expect(skill).toContain('must not come out as the same sentence');
    expect(skill).toContain('must not share an opening shape');
  });

  it('treats a promised weekday that has passed as past, and a later one as still ahead', () => {
    const thursday = new Date('2026-08-13T15:00:00.000Z');
    const zone = 'America/Toronto';
    expect(promisedPassedWeekday("I'll follow up with them Thursday", thursday, zone)).toBe(true);
    expect(promisedPassedWeekday("I'll follow up with them Friday", thursday, zone)).toBe(false);
    expect(promisedPassedWeekday("I'll follow up next Thursday", thursday, zone)).toBe(false);
    expect(promisedPassedWeekday('The camp said Thursday', thursday, zone)).toBe(false);
    expect(promisedPassedWeekday('Je vais leur écrire jeudi', thursday, zone)).toBe(true);
    expect(promisedPassedWeekday('Je vais écrire vendredi', thursday, zone)).toBe(false);
    expect(promisedPassedWeekday("I'm going to call the desk Thursday", thursday, zone)).toBe(true);
    expect(promisedPassedWeekday("I'll check back Thu.", thursday, zone)).toBe(true);
    expect(promisedPassedWeekday('Je relance le centre jeudi.', thursday, zone)).toBe(true);
    expect(promisedPassedWeekday("I'll check back tomorrow", thursday, zone)).toBe(false);
    expect(promisedPassedWeekday("I'll email the registration desk again", thursday, zone)).toBe(
      false,
    );
    expect(inventedHalePromise("I'll check back tomorrow")).toBe(true);
    expect(inventedHalePromise("I'll email the registration desk again")).toBe(true);
    expect(inventedHalePromise('The camp still has not written back.')).toBe(false);

    expect(followupRefusal("I'll check back tomorrow", thursday, zone)).toBe('invented_promise');
    expect(followupRefusal("I'll email the registration desk again", thursday, zone)).toBe(
      'invented_promise',
    );
    expect(followupRefusal('Checking in on the swim.', thursday, zone)).toBe('stock_opener');
    expect(followupRefusal('Quick check-in: the camp list.', thursday, zone)).toBe('stock_opener');
    expect(followupRefusal('Hope your week is easy.', thursday, zone)).toBe('stock_opener');
    expect(
      followupRefusal(
        'Any news from Camp Kawartha on your end?',
        thursday,
        zone,
        'waiting_on_third_party',
      ),
    ).toBe('parent_news');
    expect(
      followupRefusal(
        'As-tu des nouvelles du centre de ton coté?',
        thursday,
        zone,
        'waiting_on_third_party',
      ),
    ).toBe('parent_news');
    expect(
      followupRefusal('Any news on your end about the swim?', thursday, zone, 'waiting_on_parent'),
    ).toBeNull();
    expect(followupRefusal('The camp still has not written back.', thursday, zone)).toBeNull();
    expect(followupRefusal('Let me know which Saturday works.', thursday, zone)).toBeNull();

    expect(
      followupRefusal(
        'We will reach out to the camp Thursday.',
        thursday,
        zone,
        'waiting_on_third_party',
      ),
    ).toBe('past_weekday');
    expect(followupRefusal("Hale's going to call the desk tomorrow.", thursday, zone)).toBe(
      'invented_promise',
    );
    expect(followupRefusal('Let me check with the studio Friday.', thursday, zone)).toBe(
      'invented_promise',
    );
    expect(followupRefusal('On relance le centre lundi.', thursday, zone)).toBe('past_weekday');
    expect(
      followupRefusal('Je te tiens au courant dès que le centre répond.', thursday, zone),
    ).toBe('invented_promise');

    expect(
      followupRefusal('Did you hear back from the camp?', thursday, zone, 'waiting_on_third_party'),
    ).toBe('parent_news');
    expect(
      followupRefusal('Any update from the school?', thursday, zone, 'waiting_on_third_party'),
    ).toBe('parent_news');
    expect(
      followupRefusal('Le centre t’a-t-il répondu?', thursday, zone, 'waiting_on_third_party'),
    ).toBe('parent_news');

    expect(followupRefusal('Hey! Just wanted to check in on the jersey.', thursday, zone)).toBe(
      'stock_opener',
    );
    expect(followupRefusal('Following up on the jersey order.', thursday, zone)).toBe(
      'stock_opener',
    );
    expect(followupRefusal('Circling back on the jersey order.', thursday, zone)).toBe(
      'stock_opener',
    );
    expect(followupRefusal('Hope you had a good weekend!', thursday, zone)).toBe('stock_opener');
    expect(followupRefusal('Petit suivi: le maillot.', thursday, zone)).toBe('stock_opener');
    expect(followupRefusal('Still need to know the size.', thursday, zone)).toBe('stock_opener');

    expect(
      followupRefusal(
        'Tu dois décider si tu apportes une salade ou un dessert pour la fete de demain?',
        thursday,
        zone,
      ),
    ).toBe('order');
    expect(followupRefusal('Tu dois choisir entre les deux.', thursday, zone)).toBe('order');
    expect(followupRefusal('Faut juste que tu décides entre les deux.', thursday, zone)).toBe(
      'order',
    );
    expect(followupRefusal('Il faut que tu décides entre les deux.', thursday, zone)).toBe('order');
    expect(followupRefusal('Il faut choisir entre les deux.', thursday, zone)).toBe('order');
  });

  it('drops a step only when Hale is the subject', () => {
    const keep = [
      'Alex will call the dentist',
      'Sam is going to email the coach',
      "Sam's dad to call the coach",
      'Barton needs to call the dentist',
      "Call the dentist to rebook Maya's cleaning",
      'Email the coach about jersey size (Sam)',
      'Contacter le CPE pour confirmer la place (parent)',
      'Le parent doit contacter le CPE',
      'Waiting on the camp to email the schedule',
      'Studio will call the parent back',
      'The school will reach out by Monday',
      'Parent to call the dentist',
      'Parent to email the coach',
      'Sam to email the coach',
      'Parent to reach out to the school',
      'Parent to text the babysitter',
      'I need to call the dentist and want a reminder Thursday',
    ];
    for (const step of keep) {
      expect(haleActionNextStep(step, 'waiting_on_parent'), step).toBe(false);
      expect(haleActionNextStep(step, 'scheduled'), step).toBe(false);
    }
    expect(
      haleActionNextStep(
        'Contacter le dentiste pour reprendre le rendez-vous',
        'waiting_on_parent',
      ),
    ).toBe(false);
    expect(
      haleActionNextStep("Call the dentist to rebook Maya's cleaning", 'waiting_on_third_party'),
    ).toBe(false);

    const drop = [
      'Hale checks back Friday',
      "I'll look again Thursday",
      "I'll email the camp again Thursday",
      'Je regarde de nouveau jeudi',
      "We'll call the camp Thursday",
      'On va relancer le centre',
    ];
    for (const step of drop) {
      expect(haleActionNextStep(step, 'waiting_on_parent'), step).toBe(true);
    }
    const chase = [
      'Écrire au camp lundi',
      'Ping the camp Thursday',
      "Revérifier jeudi si l'entraîneur a répondu",
      'Follow up with Camp Kawartha registration desk Thursday',
    ];
    for (const step of chase) {
      expect(haleActionNextStep(step, 'waiting_on_third_party'), step).toBe(true);
      expect(haleActionNextStep(step, 'waiting_on_parent'), step).toBe(false);
    }
  });

  it('spaces an em dash between words and leaves a range and an edge dash alone', async () => {
    const folded = async (body: string) => {
      const client = {
        messages: { create: vi.fn(async () => toolMessage(body)) },
      } as unknown as AgentClient;
      const result = await composeWorkstreamFollowup({
        client,
        title: 'lane',
        status: 'waiting_on_parent',
        nextStep: 'which lane',
        now: NOW,
        timeZone: 'America/Toronto',
      });
      if (!result.ok) throw new Error(result.reason);
      return result.body;
    };
    expect(await folded('Please confirm\u2014are you in for 9\u201310.')).toBe(
      'Please confirm - are you in for 9-10.',
    );
    expect(await folded('Saturday\u2014Wallace has the lane.')).toBe(
      'Saturday - Wallace has the lane.',
    );
    expect(await folded('Sessions run Mon\u2013Fri this month.')).toBe(
      'Sessions run Mon-Fri this month.',
    );
    expect(await folded('\u2014hello from the desk.')).toBe('-hello from the desk.');
  });

  it('rejects the close variants, openers, orders, and invented claims from the live check', () => {
    const thursday = new Date('2026-08-13T15:00:00.000Z');
    const zone = 'America/Toronto';
    const third = 'waiting_on_third_party';
    const refuse = (
      body: string,
      status = 'waiting_on_parent',
      thread: { title?: string; nextStep?: string | null } = {},
    ) => followupRefusal(body, thursday, zone, status, thread);

    expect(refuse("I'd follow up with the camp if you want.", third)).toBe('invented_promise');
    expect(refuse('I can check with the camp Friday.')).toBe('invented_promise');
    expect(refuse('Je te redis ça jeudi.', third)).toBe('past_weekday');
    expect(refuse('Je te reviens là-dessus demain.')).toBe('invented_promise');
    expect(refuse("Je m'en occupe demain.")).toBe('invented_promise');
    expect(refuse('On te revient vendredi.')).toBe('invented_promise');
    expect(refuse('Je regarde de nouveau jeudi.', third)).toBe('past_weekday');
    expect(refuse('Je revérifie jeudi.', third)).toBe('past_weekday');
    expect(refuse('Je reviens vers toi vendredi.')).toBe('invented_promise');
    expect(refuse('Rien de ton côté pour le camp?', third)).toBe('parent_news');

    expect(refuse('Did the camp get back to you?', third)).toBe('parent_news');
    expect(refuse('Has the studio replied yet?', 'open')).toBe('parent_news');
    expect(refuse('Did they ever answer the desk?', 'scheduled')).toBe('parent_news');
    expect(refuse('Any word from the coach?', third)).toBe('parent_news');
    expect(refuse('Did they say anything yet?', third)).toBe('parent_news');
    expect(refuse('Le centre t’a recontacté?', third)).toBe('parent_news');
    expect(refuse("Est-ce que l'entraîneur t'est revenu?", 'open')).toBe('parent_news');
    expect(refuse('Did you hear back from the camp?', 'waiting_on_parent')).toBeNull();

    for (const line of [
      'Hey there, just checking in on the jersey.',
      'Hi Barton, following up on the jersey.',
      'Bonjour ! Petit suivi sur le maillot.',
      'Coucou, petit suivi sur le maillot.',
      'Hello — following up on the jersey.',
      'Quick follow-up on the jersey.',
      'Just following up on the jersey.',
      'Just a quick check-in on the jersey.',
      'Checking back on the jersey.',
      'Touching base on the jersey.',
      'Je fais un petit suivi sur le maillot.',
      'Un petit suivi: le maillot.',
      'Hey, just circling back on the jersey.',
      'Hey following up on the swim class.',
      'Hi checking in about piano.',
      'Bonjour petit suivi pour la natation.',
      'Hello circling back on the jersey.',
    ]) {
      expect(refuse(line), line).toBe('stock_opener');
    }

    expect(refuse('Il faudrait que tu signes le formulaire.')).toBe('order');
    expect(refuse('Faudrait que tu signes le formulaire.')).toBe('order');
    expect(refuse('Vous devez signer le formulaire.')).toBe('order');
    expect(refuse('Il te faut signer le formulaire.')).toBe('order');
    expect(refuse("Il faut trouver un cadeau de moins de 30 $ pour l'anniversaire de Zoé.")).toBe(
      'order',
    );
    expect(refuse('Il faut confirmer la place.')).toBe('order');
    expect(refuse('Faut choisir entre Pierre-Charbonneau 9 h et Rosemont 10 h 30?')).toBe('order');
    expect(refuse('Faut-il appeler le CPE pour la place?')).toBeNull();
    expect(
      refuse("Il faudrait choisir un cadeau de moins de 30 $ pour l'anniversaire de Zoé."),
    ).toBe('order');
    expect(refuse('Il faudrait appeler le CPE pour confirmer la place de Léa.')).toBe('order');
    expect(refuse('Il faudrait contacter le dentiste de Zoé pour reprendre le rendez-vous.')).toBe(
      'order',
    );
    expect(
      refuse('Il te reste à contacter le dentiste de Zoé pour reprendre le rendez-vous.'),
    ).toBe('order');
    expect(refuse("Faut qu'on reprenne le rendez-vous chez le dentiste de Zoé.")).toBe('order');
    expect(refuse("Il faut qu'on décide si on apporte une salade ou un dessert.")).toBe('order');
    expect(refuse("N'oublie pas d'appeler le CPE.")).toBe('order');
    expect(refuse("T'as juste à appeler le CPE.")).toBe('order');
    expect(refuse('Tu devrais confirmer avant samedi.')).toBe('order');
    expect(refuse('Vous devriez confirmer avant samedi.')).toBe('order');
    expect(refuse("Tu veux qu'on voie si c'est fait?")).toBe('invented_promise');
    expect(refuse("Time to call the dentist and rebook Maya's cleaning.")).toBe('order');
    expect(refuse('Need to pick a gift under $30 before Saturday.')).toBe('order');
    expect(refuse('You should confirm before Saturday.')).toBe('order');
    expect(refuse("Don't forget to call the dentist.")).toBe('order');
    expect(refuse('Make sure you send the form.')).toBe('order');
    expect(refuse('Do you still need to call the dentist?')).toBeNull();
    expect(refuse('Do you need to call the dentist?')).toBeNull();
    expect(refuse('Did you get a chance to send the deposit form?')).toBeNull();

    expect(refuse('Great that you booked the 9:30 swim!')).toBe('invented_claim');
    expect(refuse("Maya's spot is confirmed.")).toBe('invented_claim');
    expect(refuse('You said you would pick Saturday.')).toBe('invented_claim');
    expect(refuse('Tu as dit que tu nous dirais.')).toBe('invented_claim');
    expect(refuse('Super que la place soit réservée!')).toBe('invented_claim');
    expect(refuse('Léa est inscrite au CPE.')).toBe('invented_claim');
    expect(refuse('Léa est inscrite au CPE, et ensuite?')).toBe('invented_claim');
    expect(refuse('Léa est inscrite au CPE, tu veux que je le note?')).toBe('invented_promise');
    expect(refuse("Theo's camp spot is all set for March break.", third)).toBe('invented_claim');
    expect(refuse("C'est réglé pour la place de Léa.")).toBe('invented_claim');
    expect(refuse('Zoé est-elle inscrite pour mardi ou jeudi?')).toBeNull();
    expect(refuse('La place de Léa au CPE est-elle réservée?')).toBeNull();
    expect(refuse('Your swim is confirmed.', 'scheduled')).toBeNull();
    expect(
      refuse("Maya's swim at Annette Pool starts this Sunday at 10:00.", 'scheduled', {
        title: 'starts Oct 18',
        nextStep: 'first class Oct 18 at 10:00',
      }),
    ).toBe('invented_claim');
    expect(
      refuse('Did you get a chance to email the coach about the level test?', 'waiting_on_parent', {
        title: "Omar's level test",
        nextStep: 'Sam to email the coach',
      }),
    ).toBe('invented_claim');
    expect(
      refuse('Le formulaire doit être signé et renvoyé demain.', 'waiting_on_parent', {
        title: 'formulaire de sortie',
        nextStep: 'signé et renvoyé avant vendredi',
      }),
    ).toBe('invented_claim');
    expect(
      refuse(
        'Wallace Emerson at 9:30 or Annette Pool at 11:00 for Maya this Saturday?',
        'scheduled',
        {
          title: 'Saturday swim lessons',
        },
      ),
    ).toBeNull();
    expect(
      refuse("Who's grabbing Maya for the dentist tomorrow, you or Sam?", 'waiting_on_parent', {
        title: "Friday's dentist",
      }),
    ).toBeNull();
    expect(
      refuse('Ce samedi, salade ou dessert pour la fête?', 'waiting_on_parent', {
        nextStep: 'fête de samedi',
      }),
    ).toBeNull();
    expect(
      refuse("Maya's swim starts this Sunday at 10:00.", 'scheduled', {
        title: 'Sunday session starts Oct 18',
      }),
    ).toBe('invented_claim');
    const oct15 = new Date('2026-10-15T15:00:00.000Z');
    expect(
      followupRefusal("Maya's swim starts this Sunday at 10:00.", oct15, zone, 'scheduled', {
        title: 'Sunday session starts Oct 18',
      }),
    ).toBeNull();
    expect(
      refuse(
        "Sam needs to email the coach about Omar's level test—can you send that over?",
        'waiting_on_parent',
        { nextStep: 'Sam to email the coach' },
      ),
    ).toBe('invented_claim');
    expect(
      refuse('Did Sam get a chance to email the coach?', 'waiting_on_parent', {
        nextStep: 'Sam to email the coach',
      }),
    ).toBeNull();

    const controls: Array<{
      body: string;
      status?: string;
      thread?: { title?: string; nextStep?: string | null };
    }> = [
      { body: 'The camp still has not written back.', status: third },
      { body: 'Let me know which Saturday works.' },
      { body: 'Any news on your end about the swim?', status: 'waiting_on_parent' },
      { body: 'The camp said Thursday is when they decide.', status: third },
      { body: 'Did you land on youth M or youth L for Ava’s jersey?' },
      {
        body: "Has Sam had a chance to email the coach about Omar's level test?",
        thread: { nextStep: 'Sam to email the coach' },
      },
      { body: 'Have you had a chance to send that deposit form to Camp Kawartha?' },
      { body: 'Pour la fête de samedi, ça te tente plutôt une salade ou un dessert à apporter?' },
      { body: 'As-tu pu appeler le CPE pour confirmer la place pour Léa ?' },
      { body: 'Le premier cours de piano de Jules est mardi à 16 h chez Mme Roy.' },
      { body: 'Faut-il appeler le CPE pour la place?' },
      { body: 'Léa attend juste que tu appelles le CPE.' },
      { body: 'The camp will call the parent back Thursday.', status: third },
      { body: 'Studio has not replied yet.', status: third },
      { body: 'No word from the coach yet.', status: 'open' },
      { body: 'Still holding that Saturday swim if you want to pick one.' },
      {
        body: 'Which works better for you this Saturday—Wallace Emerson at 9:30 or Annette Pool at 11:00?',
        thread: { title: 'Saturday swim lessons' },
      },
      { body: 'The form is in and nothing else is owed.' },
    ];
    expect(controls).toHaveLength(18);
    const extras: Array<{
      body: string;
      status?: string;
      thread?: { title?: string; nextStep?: string | null };
    }> = [
      { body: 'Zoé est-elle inscrite pour mardi ou jeudi?' },
      { body: 'La place de Léa au CPE est-elle réservée?' },
      {
        body: "Who's grabbing Maya for the dentist tomorrow, you or Sam?",
        thread: { title: "Friday's dentist" },
      },
      {
        body: 'Ce samedi, salade ou dessert pour la fête?',
        thread: { nextStep: 'fête de samedi' },
      },
      {
        body: "Sam was going to email the coach about Omar's level test—did that go out?",
        thread: { nextStep: 'Sam to email the coach' },
      },
      { body: 'What size skates does Ben need — a 2 or a 3?' },
      { body: "Maya's swim at Annette Pool starts Oct 18, Sundays at 10:00." },
      { body: 'Which works better for Ivy — Tuesday at 4 or Wednesday at 5?' },
      { body: 'Tu vas apporter une salade ou un dessert à la fête de samedi?' },
      {
        body: 'Le formulaire de sortie de Léa à signer et renvoyer avant vendredi — tu as pu le trouver?',
      },
    ];
    expect(extras).toHaveLength(10);
    for (const line of extras) {
      expect(refuse(line.body, line.status, line.thread), line.body).toBeNull();
    }
    for (const line of controls) {
      expect(refuse(line.body, line.status, line.thread), line.body).toBeNull();
    }
  });
});

describe('workstream prompt placement', () => {
  it('puts the open list on the user turn, after the cached skill prefix', async () => {
    const captured: Array<{
      system?: Anthropic.TextBlockParam[];
      messages?: Anthropic.MessageParam[];
    }> = [];
    const client = {
      messages: {
        create: async (params: {
          system?: Anthropic.TextBlockParam[];
          messages?: Anthropic.MessageParam[];
        }) => {
          captured.push(params);
          return {
            id: 'msg',
            type: 'message',
            role: 'assistant',
            model: 'claude',
            stop_reason: 'end_turn',
            stop_sequence: null,
            content: [{ type: 'text', text: 'Still on the swim.', citations: null }],
            usage: usage(),
          } as Anthropic.Message;
        },
      },
    } as unknown as AgentClient;
    const skill: Skill = {
      meta: { name: 'cache-probe', whenToUse: 'test', task: 'converse', tools: [] },
      instructions: 'static skill instructions',
    };
    await runAgent({
      skill,
      context: { memoryBrief: { text: `active_workstreams:\ntitle=${TITLE}` } },
      tools: [],
      client,
      maxSteps: 1,
      toolContext: { familyId: FAMILY, actor: 'system' },
      guardDeps: { writeAudit: async () => undefined },
      maxTokens: 64,
    });
    const system = JSON.stringify(captured[0]?.system);
    const user = JSON.stringify(captured[0]?.messages?.[0]?.content);
    expect(system).toContain('static skill instructions');
    expect(system).toContain('ephemeral');
    expect(system).not.toContain(TITLE);
    expect(user).toContain(TITLE);
  });
});
