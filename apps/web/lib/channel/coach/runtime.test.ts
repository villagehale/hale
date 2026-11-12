import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import {
  type RegisteredTool,
  type RunAgentArgs,
  type Skill,
  defineTool,
  invokeTool,
} from '@hale/agent';
import type { Database } from '@hale/db';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { readInboundMedia } from '~/lib/channel/inbound-media';
import {
  type ChannelTurn,
  ChannelTurnFailed,
  draftsFromFailure,
} from '~/lib/channel/router/coach-runtime';
import { smsSegments } from '~/lib/channel/sms-segments';
import { watchForOpeningTool } from '~/lib/channel/spots/tool';
import { loadCronSkill } from '~/lib/cron/skill';
import { findReplyNotJudged } from './find-reasoning-judge';
import {
  CHANNEL_COACH_MAX_TOKENS,
  type ChannelCoachPorts,
  channelCoachRuntime,
  productionChannelCoachPorts,
} from './runtime';

/**
 * The runtime, with every collaborator injected — the model included, because what is
 * asserted here is the PLUMBING around it: that the turn is grounded on the thread C1
 * already wrote, that the answer is post-processed before it leaves, that a run with no
 * answer is a THROWN failed turn rather than a soothing sentence, and that the run is
 * recorded either way.
 *
 * Whether the model picks the right tool and writes the right words is not asserted
 * here and could not be: that is rule #8's territory, measured against real cached
 * Claude in `apps/worker/evals/run-coach-channel-eval.mjs`.
 */

function promptOf(args: RunAgentArgs): string {
  return [args.skill.instructions, ...(args.systemExtras ?? [])].join('\n\n');
}

const FAMILY = '11111111-1111-4111-8111-111111111111';
const PARENT = '22222222-2222-4222-8222-222222222222';
const CONVERSATION = '33333333-3333-4333-8333-333333333333';
const NOW = new Date('2026-07-30T12:00:00.000Z');
const LINK = 'https://app.villagehale.com';

/** 16y at NOW → teenager, derived from the @hale/types boundary, not from output. */
const TEEN = { name: 'Nora', gender: 'girl', dateOfBirth: '2010-03-04' };

function turn(body = 'move swim to tuesday'): ChannelTurn {
  return {
    familyId: FAMILY,
    parentUserId: PARENT,
    conversationId: CONVERSATION,
    body,
    now: NOW,
    standingQuestions: [],
    audience: 'direct',
  };
}

const SKILL: Skill = {
  meta: { name: 'coach-channel-sms', whenToUse: 'x', task: 'converse', tools: [] },
  instructions: 'be terse',
};

function answering(answer: string | null, hitMaxSteps = false): ChannelCoachPorts['runAgent'] {
  return async () => ({
    answer,
    steps: 1,
    hitMaxSteps,
    truncatedRetries: 0,
    truncated: false,
    usage: { promptTokens: 100, cacheCreationTokens: 0, cacheReadTokens: 0, completionTokens: 20 },
  });
}

interface Recorded {
  agentName: string;
  status: string;
  latencyMs: number;
  costUsd: number;
}

function ports(overrides: Partial<ChannelCoachPorts> = {}) {
  const recorded: Recorded[] = [];
  const contextInputs: unknown[] = [];
  const base: ChannelCoachPorts = {
    loadSkill: async () => SKILL,
    loadTranscript: async () => [{ role: 'user' as const, content: 'earlier' }],
    loadContext: async (input) => {
      contextInputs.push(input);
      return {
        question: input.question,
        transcript: input.transcript,
        memoryFacts: [],
        location: { city: null, province: null, country: 'Canada' },
      } as never;
    },
    loadChildren: async () => [TEEN],
    loadRegistrationWindows: async () => [],
    buildTools: () => [] as RegisteredTool[],
    // Nothing nearby by default: the surface flag is off for months, so silence is the
    // ordinary answer and the cases that exercise it override this.
    nearbySaid: async () => null,
    guardDeps: { async writeAudit() {} },
    // Never reached: `runAgent` is injected below, and it is the only consumer.
    client: () => ({ messages: {} }) as never,
    judgeFindReply: findReplyNotJudged,
    runAgent: answering('Move swim to Tue 4:30? YES to confirm.'),
    recordRun: async (run) => {
      recorded.push({
        agentName: run.agentName,
        status: run.status,
        latencyMs: run.latencyMs,
        costUsd: run.costUsd,
      });
    },
    now: () => NOW,
    ...overrides,
  };
  return Object.assign(base, { recorded, contextInputs });
}

describe('channelCoachRuntime', () => {
  it('answers a turn with the post-processed reply', async () => {
    const { reply } = await channelCoachRuntime(ports()).respond(turn(), []);

    expect(reply).toBe('Move swim to Tue 4:30? YES to confirm.');
  });

  /** VIL-536: thinking and tool calls share this ceiling with the reply. 400 was spent
   * before the model spoke on a broad grouped-map ask; 2000 is the room the reply keeps. */
  it('hands the loop a completion budget thinking and tools cannot spend alone', async () => {
    let seen: number | undefined;
    const p = ports({
      runAgent: async (args) => {
        seen = args.maxTokens;
        return answering('Move swim to Tue 4:30? YES to confirm.')(args);
      },
    });

    await channelCoachRuntime(p).respond(turn(), []);

    expect(seen).toBe(CHANNEL_COACH_MAX_TOKENS);
    expect(CHANNEL_COACH_MAX_TOKENS).toBe(2000);
  });

  /**
   * The turn is grounded on the thread rather than on the job: C1 has already appended
   * the parent's message, so the runtime reads the conversation and never re-states the
   * question into it. Nothing in {@link ChannelCoachPorts} can write to `messages` —
   * that is the structural half of the same guarantee.
   */
  it('grounds the model on the conversation C1 threaded, whole-family scope', async () => {
    const p = ports();

    await channelCoachRuntime(p).respond(turn('cancel swim'), []);

    expect(p.contextInputs).toEqual([
      expect.objectContaining({
        familyId: FAMILY,
        question: 'cancel swim',
        focusedChildId: null,
        transcript: [{ role: 'user', content: 'earlier' }],
      }),
    ]);
  });

  it('carries the household group and its skill only when the context has one (VIL-566)', async () => {
    const group = (await loadCronSkill('household-group')).instructions;
    const run = async (householdGroup?: 'pending' | 'claimed') => {
      const seen: { context: unknown; instructions: string; prefix?: string }[] = [];
      const p = ports({
        loadContext: async (input) =>
          ({
            question: input.question,
            transcript: input.transcript,
            memoryFacts: [],
            location: { city: null, province: null, country: 'Canada' },
            ...(householdGroup ? { householdGroup } : {}),
          }) as never,
        runAgent: async (args) => {
          seen.push({
            context: args.context,
            instructions: promptOf(args),
            prefix: args.skill.instructions,
          });
          return answering('ok.')(args);
        },
      });
      await channelCoachRuntime(p).respond(turn(), []);
      return seen[0];
    };
    const pending = await run('pending');
    expect(pending?.context).toMatchObject({ householdGroup: 'pending' });
    expect(pending?.instructions.endsWith(`\n\n${group}`)).toBe(true);
    expect(pending?.prefix).not.toContain(group);
    const none = await run();
    expect(none?.context).not.toHaveProperty('householdGroup');
    expect(none?.instructions).not.toContain(group);
  });

  it('carries the fact-source skill only on a 1:1 turn holding a fact read in email (VIL-429)', async () => {
    const addendum = (await loadCronSkill('coach-fact-source')).instructions;
    const fact = { childId: null, factType: 'routine', factKey: 'soccer_day', factValue: 'Thu' };
    const sourced = { ...fact, seenIn: { email: { from: 'Northside Rec', on: '2026-10-03' } } };
    const run = async (seen: boolean, audience: ChannelTurn['audience']) => {
      const calls: string[] = [];
      const p = ports({
        loadContext: async (input) =>
          ({
            question: input.question,
            transcript: input.transcript,
            memoryFacts: [seen ? sourced : fact],
            location: { city: null, province: null, country: 'Canada' },
          }) as never,
        runAgent: async (args) => {
          calls.push(promptOf(args));
          return answering('ok.')(args);
        },
      });
      await channelCoachRuntime(p).respond({ ...turn(), audience }, []);
      return calls[0] ?? '';
    };
    expect((await run(true, 'direct')).endsWith(`\n\n${addendum}`)).toBe(true);
    expect(await run(false, 'direct')).not.toContain(addendum);
    expect(await run(true, 'group')).not.toContain(addendum);
  });

  it('tells the coach how many texts arrived together, and only on a burst', async () => {
    const run = async (burstSize?: number) => {
      const seen: { context: unknown; prompt: string }[] = [];
      const p = ports({
        runAgent: async (args) => {
          seen.push({ context: args.context, prompt: promptOf(args) });
          return answering('ok.')(args);
        },
      });
      await channelCoachRuntime(p).respond(
        burstSize === undefined ? turn() : { ...turn(), burstSize },
        [],
      );
      return seen[0];
    };
    const lone = await run();
    expect(lone?.context).not.toHaveProperty('arrivedTogether');
    const burst = await run(2);
    expect(burst?.context).toMatchObject({ arrivedTogether: 2 });
    // The fact rides in the context; the system prompt, and its cache prefix, stay put.
    expect(burst?.prompt).toBe(lone?.prompt);
    const { arrivedTogether: _dropped, ...rest } = burst?.context as Record<string, unknown>;
    expect(JSON.stringify(rest)).toBe(JSON.stringify(lone?.context));
  });

  it('asks for the context as the parent who texted (VIL-429)', async () => {
    const p = ports();
    await channelCoachRuntime(p).respond(turn(), []);
    expect(p.contextInputs).toEqual([expect.objectContaining({ readerUserId: PARENT })]);
  });

  it('asks for a group turn’s context as every adult, a 1:1 turn’s as that parent (VIL-599)', async () => {
    const p = ports();
    await channelCoachRuntime(p).respond({ ...turn(), audience: 'group' }, []);
    await channelCoachRuntime(p).respond({ ...turn(), audience: 'direct' }, []);
    expect(p.contextInputs).toEqual([
      expect.objectContaining({ readerUserId: PARENT, inGroup: true }),
      expect.objectContaining({ readerUserId: PARENT, inGroup: false }),
    ]);
  });

  it('hands the loop the channel context: the surface and the family clock', async () => {
    const seen: unknown[] = [];
    const p = ports({
      runAgent: async (args) => {
        seen.push(args.context);
        return answering('ok.')(args);
      },
    });

    await channelCoachRuntime(p).respond(turn(), []);

    expect(seen[0]).toEqual(
      expect.objectContaining({
        channel: 'sms',
        nowIso: NOW.toISOString(),
        question: 'move swim to tuesday',
      }),
    );
  });

  it('hands the loop the family-local day and forecast as facts, with their skill (VIL-435)', async () => {
    const addendum = (await loadCronSkill('coach-local-day')).instructions;
    const seen: { context: Record<string, unknown>; instructions: string }[] = [];
    const runAgent: ChannelCoachPorts['runAgent'] = async (args) => {
      seen.push({
        context: args.context as Record<string, unknown>,
        instructions: promptOf(args),
      });
      return answering('ok.')(args);
    };
    const rainy = { date: '2026-10-12', precipitationChancePct: 80, highTempC: 9 };
    // 10:07 on Canadian Thanksgiving in Toronto is 14:07 UTC.
    const thanksgiving = new Date('2026-10-12T14:07:20Z');

    await channelCoachRuntime(
      ports({
        runAgent,
        now: () => thanksgiving,
        loadTimeZone: async () => 'America/Toronto',
        loadForecast: async () => [{ ...rainy, weekday: 'Monday' }],
      }),
    ).respond(turn('find me something to do today'), []);

    expect(seen[0]?.context.localNow).toEqual({
      date: '2026-10-12',
      weekday: 'Monday',
      time: '10:07',
      timeZone: 'America/Toronto',
    });
    expect(seen[0]?.context.forecast).toEqual([{ ...rainy, weekday: 'Monday' }]);
    expect(seen[0]?.instructions.endsWith(`\n\n${addendum}`)).toBe(true);
  });

  it('leaves the day facts and their skill out when neither is known', async () => {
    const addendum = (await loadCronSkill('coach-local-day')).instructions;
    const seen: { context: Record<string, unknown>; instructions: string }[] = [];
    const runAgent: ChannelCoachPorts['runAgent'] = async (args) => {
      seen.push({
        context: args.context as Record<string, unknown>,
        instructions: promptOf(args),
      });
      return answering('ok.')(args);
    };

    await channelCoachRuntime(
      ports({ runAgent, loadTimeZone: async () => null, loadForecast: async () => [] }),
    ).respond(turn(), []);
    await channelCoachRuntime(ports({ runAgent })).respond(turn(), []);

    expect(seen[0]?.context).not.toHaveProperty('localNow');
    expect(seen[0]?.context).not.toHaveProperty('forecast');
    expect(seen[0]?.instructions).not.toContain(addendum);
    expect(JSON.stringify(seen[0]?.context)).toBe(JSON.stringify(seen[1]?.context));
    expect(seen[0]?.instructions).toBe(seen[1]?.instructions);
  });

  it('reads a photo into the loop and names a video it did not watch', async () => {
    const seen: Array<{
      context: Record<string, unknown>;
      attachments?: unknown[];
      instructions: string;
    }> = [];
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0xd9]);
    const p = ports({
      readInboundMedia: (parts) =>
        readInboundMedia(
          parts,
          (async () => new Response(jpeg, { status: 200 })) as unknown as typeof fetch,
        ),
      runAgent: async (args) => {
        seen.push({
          context: args.context as Record<string, unknown>,
          attachments: args.attachments as unknown[],
          instructions: args.skill.instructions,
        });
        return answering('Got the flyer.')(args);
      },
    });

    await channelCoachRuntime(p).respond(
      {
        ...turn(''),
        inboundMedia: [
          { kind: 'image', url: 'https://cdn.example/flyer.jpg', mime: 'image/jpeg' },
          { kind: 'video', url: 'https://cdn.example/clip.mp4', mime: 'video/mp4' },
        ],
      },
      [],
    );

    expect(seen[0]?.attachments?.[0]).toMatchObject({ type: 'image' });
    expect(seen[0]?.context.arrivedMedia).toEqual([{ kind: 'video' }]);
    expect(seen[0]?.context).not.toHaveProperty('photoFacts');
    expect(seen[0]?.instructions).not.toContain('arrivedContacts');
  });

  it('reads a .vcf into the loop as contact fields, not as an attachment', async () => {
    const seen: Array<{
      context: Record<string, unknown>;
      attachments?: unknown[];
      instructions: string;
    }> = [];
    const vcf = ['BEGIN:VCARD', 'FN:Jane Smith', 'TEL;TYPE=CELL:+14165550100', 'END:VCARD'].join(
      '\n',
    );
    const p = ports({
      readInboundMedia: (parts) =>
        readInboundMedia(parts, fetch, undefined, async () => new Response(vcf, { status: 200 })),
      runAgent: async (args) => {
        seen.push({
          context: args.context as Record<string, unknown>,
          attachments: args.attachments as unknown[],
          instructions: promptOf(args),
        });
        return answering('ok.')(args);
      },
    });

    await channelCoachRuntime(p).respond(
      {
        ...turn('this is my mom'),
        inboundMedia: [
          { kind: 'contact', url: 'https://cdn.example/Jane.vcf', mime: 'text/vcard' },
        ],
      },
      [],
    );

    expect(seen[0]?.attachments).toBeUndefined();
    expect(seen[0]?.context.arrivedMedia).toBeUndefined();
    expect(seen[0]?.context.arrivedContacts).toEqual([
      {
        name: 'Jane Smith',
        phones: [{ number: '+14165550100', e164: '+14165550100', label: 'cell' }],
      },
    ]);
    expect(seen[0]?.context.arrivedContactsTruncated).toBeUndefined();
    expect(seen[0]?.instructions).toContain('arrivedContacts');
  });

  it('tells the loop when a contact file had more cards than it kept', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const p = ports({
      readInboundMedia: async () => ({
        blocks: [],
        unwatched: [],
        contacts: [{ name: 'Ada', phones: [] }],
        contactsTruncated: true,
      }),
      runAgent: async (args) => {
        seen.push(args.context as Record<string, unknown>);
        return answering('ok.')(args);
      },
    });

    await channelCoachRuntime(p).respond(
      {
        ...turn(''),
        inboundMedia: [
          { kind: 'contact', url: 'https://cdn.example/book.vcf', mime: 'text/vcard' },
        ],
      },
      [],
    );

    expect(seen[0]?.arrivedContacts).toEqual([{ name: 'Ada', phones: [] }]);
    expect(seen[0]?.arrivedContactsTruncated).toBe(true);
  });

  it('tells the loop it is in the family group, and leaves a 1:1 context byte-identical', async () => {
    const seen: Record<string, unknown>[] = [];
    const p = ports({
      runAgent: async (args) => {
        seen.push(args.context as Record<string, unknown>);
        return answering('ok.')(args);
      },
    });

    await channelCoachRuntime(p).respond({ ...turn(), audience: 'group' }, []);
    await channelCoachRuntime(p).respond(turn(), []);

    expect(seen[0]).toHaveProperty('audience', 'group');
    expect(seen[1]).not.toHaveProperty('audience');
  });

  it('offers the shared-list verbs only on a group turn with GROUP_SHARED_LISTS_ENABLED on (VIL-447)', async () => {
    const seen: Array<{ tools: string[]; instructions: string }> = [];
    const p = ports({
      runAgent: async (args) => {
        seen.push({
          tools: [...args.skill.meta.tools],
          instructions: promptOf(args),
        });
        return answering('ok.')(args);
      },
    });
    const names = ['list_group_lists', 'add_to_group_list', 'check_off_group_list_items'];
    const tone = await loadCronSkill('coach-group-lists');
    try {
      vi.stubEnv('GROUP_SHARED_LISTS_ENABLED', '');
      await channelCoachRuntime(p).respond({ ...turn(), audience: 'group' }, []);
      vi.stubEnv('GROUP_SHARED_LISTS_ENABLED', 'true');
      await channelCoachRuntime(p).respond({ ...turn(), audience: 'group' }, []);
      await channelCoachRuntime(p).respond(turn(), []);
    } finally {
      vi.unstubAllEnvs();
    }
    for (const n of names) {
      expect(seen[0]?.tools).not.toContain(n);
      expect(seen[1]?.tools).toContain(n);
      expect(seen[2]?.tools).not.toContain(n);
    }
    // A 1:1 turn adds only the VIL-303 decline verb, which rides while a capability is dark.
    expect(seen[2]?.tools).toEqual([...SKILL.meta.tools, 'note_capability_declined']);
    // Tone is the disk skill, appended only when the list verbs are offered.
    expect(seen[0]?.instructions).not.toContain(tone.instructions);
    expect(seen[1]?.instructions.endsWith(`\n\n${tone.instructions}`)).toBe(true);
    expect(seen[2]?.instructions).not.toContain(tone.instructions);
  });

  it('appends the age-fit correction skill only on a 1:1 turn with AGE_FIT_CORRECTION_ENABLED on (VIL-568)', async () => {
    const addendum = (await loadCronSkill('age-fit-correction')).instructions;
    const seen: string[] = [];
    const p = ports({
      runAgent: async (args) => {
        seen.push(promptOf(args));
        return answering('ok.')(args);
      },
    });
    try {
      vi.stubEnv('AGE_FIT_CORRECTION_ENABLED', '');
      await channelCoachRuntime(p).respond(turn(), []);
      vi.stubEnv('AGE_FIT_CORRECTION_ENABLED', 'true');
      await channelCoachRuntime(p).respond(turn(), []);
      await channelCoachRuntime(p).respond({ ...turn(), audience: 'group' }, []);
    } finally {
      vi.unstubAllEnvs();
    }
    expect(seen[0]).not.toContain(addendum);
    expect(seen[1]?.endsWith(`\n\n${addendum}`)).toBe(true);
    expect(seen[2]).not.toContain(addendum);
  });

  it('appends the no-group-relay skill only on a 1:1 turn with GROUP_1TO1_NO_GROUP_RELAY_ENABLED on (VIL-577)', async () => {
    const addendum = (await loadCronSkill('coach-no-group-relay')).instructions;
    const seen: string[] = [];
    const p = ports({
      runAgent: async (args) => {
        seen.push(promptOf(args));
        return answering('ok.')(args);
      },
    });
    try {
      vi.stubEnv('GROUP_1TO1_NO_GROUP_RELAY_ENABLED', '');
      await channelCoachRuntime(p).respond(turn(), []);
      vi.stubEnv('GROUP_1TO1_NO_GROUP_RELAY_ENABLED', 'true');
      await channelCoachRuntime(p).respond(turn(), []);
      await channelCoachRuntime(p).respond({ ...turn(), audience: 'group' }, []);
    } finally {
      vi.unstubAllEnvs();
    }
    expect(seen[0]).not.toContain(addendum);
    expect(seen[1]?.endsWith(`\n\n${addendum}`)).toBe(true);
    expect(seen[2]).not.toContain(addendum);
  });

  it('hands the loop what the provider watch read as data, and omits the key when empty', async () => {
    const seen: Record<string, unknown>[] = [];
    const reading = {
      provider: 'cityofx.perfectmind.com',
      kind: 'waitlist',
      checkedAt: NOW.toISOString(),
      items: [
        {
          title: 'Preschool Swim',
          ages: null,
          days_times: null,
          starts_on: null,
          location: null,
          status: 'waitlist' as const,
          spots_left: null,
          registration_opens: null,
        },
      ],
    };
    const runAgent: ChannelCoachPorts['runAgent'] = async (args) => {
      seen.push(args.context as Record<string, unknown>);
      return answering('ok.')(args);
    };

    await channelCoachRuntime(
      ports({ runAgent, loadProviderWatch: async () => [reading] }),
    ).respond(turn(), []);
    await channelCoachRuntime(ports({ runAgent, loadProviderWatch: async () => [] })).respond(
      turn(),
      [],
    );
    await channelCoachRuntime(ports({ runAgent })).respond(turn(), []);

    expect(seen[0]).toHaveProperty('providerWatch', [reading]);
    expect(JSON.stringify(seen[0])).not.toContain('https://cityofx');
    expect(seen[1]).not.toHaveProperty('providerWatch');
    expect(seen[2]).not.toHaveProperty('providerWatch');
    expect(JSON.stringify(seen[1])).toBe(JSON.stringify(seen[2]));
  });

  /**
   * The thread does the work; the app is the receipts room a parent never NEEDS. A
   * model told not to send a link is a model that sometimes sends one anyway — it
   * did, on launch day ("You can also add anything manually in the app: ..."). So
   * the link is not withheld by instruction, it is withheld by construction: the
   * loop is handed no URL, and the skill's standing rule is that a URL it did not
   * receive is a URL it invented. Nothing downstream holds one either: the
   * post-processor stopped taking an app link when the overflow tail went (skill audit
   * P0 #4), so there is no URL on this path at all.
   */
  it('hands the loop NO app link — a URL the model was never given cannot be sent', async () => {
    const seen: Record<string, unknown>[] = [];
    const p = ports({
      runAgent: async (args) => {
        seen.push(args.context as Record<string, unknown>);
        return answering('ok.')(args);
      },
    });

    await channelCoachRuntime(p).respond(turn(), []);

    expect(seen[0]).not.toHaveProperty('appLink');
    expect(JSON.stringify(seen[0])).not.toContain(LINK);
  });

  it("redacts a 13+ child's name out of the reply before returning it (rule #1)", async () => {
    const p = ports({ runAgent: answering('Nora has practice Thursday.') });

    const { reply } = await channelCoachRuntime(p).respond(turn(), []);

    expect(reply).toBe('your kid has practice Thursday.');
  });

  it('sends a long answer whole, past two segments', async () => {
    const long = Array.from({ length: 12 }, (_, i) => `Sentence number ${i} about swim.`).join(' ');
    const p = ports({ runAgent: answering(long) });

    const { reply } = await channelCoachRuntime(p).respond(turn(), []);

    expect(smsSegments(reply)).toBeGreaterThan(2);
    expect(reply).toBe(long);
    expect(reply).not.toContain(LINK);
    expect(reply).toContain('Sentence number 11');
  });

  /**
   * VIL-434. A sentence longer than two segments used to trigger a shorten rewrite.
   * Code no longer calls that. The model's text is what leaves, and the client is
   * not asked for a second pass.
   */
  it('does not ask for a shorter rewrite when the answer is long', async () => {
    const long = `${'Please sit with him through a boring bedtime '.repeat(8)}tonight`;
    const created: unknown[] = [];
    const p = ports({
      runAgent: answering(long),
      client: () =>
        ({
          messages: {
            create: async (params: unknown) => {
              created.push(params);
              return { content: [{ type: 'text', text: 'Sit with him until he is quiet.' }] };
            },
          },
        }) as never,
    });

    const { reply } = await channelCoachRuntime(p).respond(turn(), []);

    expect(reply).toBe(long);
    expect(created).toHaveLength(0);
    expect(p.recorded).toEqual([
      expect.objectContaining({ agentName: 'coach-channel-sms', status: 'completed' }),
    ]);
  });

  /** A throw is what the router turns into the honesty template. A runtime that
   * returned an apology string instead would make a failed turn indistinguishable from
   * an answered one — in the thread, in the logs, and in the metrics. */
  it('throws when the loop produced no answer, and records the run as failed', async () => {
    const p = ports({ runAgent: answering(null, true) });

    await expect(channelCoachRuntime(p).respond(turn(), [])).rejects.toThrow(/maxSteps/i);
    expect(p.recorded).toEqual([
      expect.objectContaining({ agentName: 'coach-channel-sms', status: 'failed' }),
    ]);
  });

  /** THREE ways to end without an answer, three messages. A budget that ran out before
   * the model could speak is a lane-config defect somebody can fix; "returned no answer"
   * is the bucket that hid it for a month (rule #11). */
  it('names a turn that ran out of ceiling rather than out of steps', async () => {
    const p = ports({
      runAgent: async () => ({
        answer: null,
        steps: 1,
        hitMaxSteps: false,
        truncatedRetries: 1,
        truncated: true,
        usage: {
          promptTokens: 100,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          completionTokens: 800,
        },
      }),
    });

    await expect(channelCoachRuntime(p).respond(turn(), [])).rejects.toThrow(
      'channel coach: agent truncated before speaking (1 re-ask)',
    );
    expect(p.recorded).toEqual([
      expect.objectContaining({ agentName: 'coach-channel-sms', status: 'failed' }),
    ]);
  });

  /**
   * VIL-260 · WS4 — a turn can commit drafts and THEN break: the two propose_* calls
   * land in the approvals queue, the model runs out of steps, and the router's honesty
   * template said "nothing was changed". It was a false statement about a real write,
   * and the orphaned drafts were left for an unrelated "yes" to approve.
   *
   * So a failed turn carries what it already did. The ids are minted by the tools, which
   * is why the sink is handed to `buildTools` rather than counted here.
   */
  it('surfaces the drafts a failed turn already committed', async () => {
    const sinks: Array<(actionId: string) => void> = [];
    const p = ports({
      buildTools: (_turn, onDraft) => {
        sinks.push(onDraft);
        return [] as RegisteredTool[];
      },
      runAgent: async () => {
        sinks[0]?.('action-1');
        sinks[0]?.('action-2');
        throw new Error('anthropic timeout');
      },
    });

    const err = await channelCoachRuntime(p)
      .respond(turn(), [])
      .catch((e: unknown) => e);

    expect(draftsFromFailure(err)).toEqual(['action-1', 'action-2']);
    // The original failure is not swallowed by the enrichment.
    expect((err as Error).cause).toBeInstanceOf(Error);
  });

  it('VIL-447: a failed turn runs the undo its tools registered, and a good one does not', async () => {
    const undone: string[] = [];
    const failing = ports({
      buildTools: (...args: unknown[]) => {
        const onUndo = args[8] as (u: () => Promise<void>) => void;
        onUndo(async () => {
          undone.push('lists');
        });
        return [] as RegisteredTool[];
      },
      runAgent: async () => {
        throw new Error('anthropic timeout');
      },
    });
    await channelCoachRuntime(failing)
      .respond(turn(), [])
      .catch(() => undefined);
    expect(undone).toEqual(['lists']);

    const ok = ports({
      buildTools: (...args: unknown[]) => {
        const onUndo = args[8] as (u: () => Promise<void>) => void;
        onUndo(async () => {
          undone.push('should-not-run');
        });
        return [] as RegisteredTool[];
      },
    });
    await channelCoachRuntime(ok).respond(turn(), []);
    expect(undone).toEqual(['lists']);
  });

  it('VIL-447: an undo that throws never masks the turn failure', async () => {
    const p = ports({
      buildTools: (...args: unknown[]) => {
        (args[8] as (u: () => Promise<void>) => void)(async () => {
          throw new Error('db down');
        });
        return [] as RegisteredTool[];
      },
      runAgent: async () => {
        throw new Error('anthropic timeout');
      },
    });
    const err = await channelCoachRuntime(p)
      .respond(turn(), [])
      .catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/anthropic timeout/);
  });

  it('surfaces nothing when a turn fails before it drafted anything', async () => {
    const p = ports({ runAgent: answering(null, true) });

    const err = await channelCoachRuntime(p)
      .respond(turn(), [])
      .catch((e: unknown) => e);

    expect(draftsFromFailure(err)).toEqual([]);
    expect((err as Error).message).toMatch(/maxSteps/i);
  });

  it('records a completed run with its latency (the p50 the ticket gates on)', async () => {
    const p = ports();

    await channelCoachRuntime(p).respond(turn(), []);

    expect(p.recorded).toEqual([
      expect.objectContaining({ agentName: 'coach-channel-sms', status: 'completed' }),
    ]);
    expect(p.recorded[0]?.latencyMs).toBeGreaterThanOrEqual(0);
  });

  /**
   * The cached tiers are billed, so they are recorded. A cached turn pays the
   * cache-read rate on every cache-read token and 1.25x input on every cache-write
   * token; pricing promptTokens + completionTokens alone books thousands of billed
   * tokens at $0 and understates the loop-health $/family the founder reads.
   *
   * Derived from the published Sonnet 5.5 rates ($2/MTok in, $10/MTok out, $0.10/MTok
   * cache read), not from output: 200*2 + 1024*2.5 + 5303*0.1 + 90*10 = 4390.3 →
   * $0.0043903.
   */
  it('prices the cache-read and cache-write tiers into the recorded cost', async () => {
    const p = ports({
      runAgent: async () => ({
        answer: 'ok.',
        steps: 1,
        hitMaxSteps: false,
        truncatedRetries: 0,
        truncated: false,
        usage: {
          promptTokens: 1224,
          cacheCreationTokens: 1024,
          cacheReadTokens: 5303,
          completionTokens: 90,
        },
      }),
    });

    await channelCoachRuntime(p).respond(turn(), []);

    expect(p.recorded[0]?.costUsd).toBeCloseTo(0.0043903, 9);
  });

  /** The per-turn draft cap lives in a closure inside the tool set, so a tool set
   * reused across texts would silently spend a later turn's budget on an earlier one. */
  it('builds a fresh tool set per turn', async () => {
    const buildTools = vi.fn(() => [] as RegisteredTool[]);
    const runtime = channelCoachRuntime(ports({ buildTools }));

    await runtime.respond(turn(), []);
    await runtime.respond(turn(), []);

    expect(buildTools).toHaveBeenCalledTimes(2);
  });

  /** D6: the tool set is built for the family's own country, so a US family's coach
   * never answers from Canada's health schedule. Canada is the positive control. */
  it("builds the tool set for the family's country", async () => {
    const countryBuiltFor = async (country: string) => {
      const buildTools = vi.fn(() => [] as RegisteredTool[]);
      const p = ports({ buildTools });
      p.loadContext = async (input) =>
        ({
          question: input.question,
          transcript: input.transcript,
          memoryFacts: [],
          location: { city: null, province: null, country },
        }) as never;
      await channelCoachRuntime(p).respond(turn(), []);
      return (buildTools.mock.calls[0] as unknown[])[9];
    };

    expect(await countryBuiltFor('United States')).toBe('US');
    expect(await countryBuiltFor('Canada')).toBe('CA');
  });
});

/**
 * The router builds its deps for EVERY inbound text, and most texts never reach a model:
 * an approval, a "done", a waitlist report are all answered by deterministic handlers
 * that run AFTER the deps are assembled. So constructing the coach must not require an
 * API key — otherwise one missing env var stops a parent approving a calendar write,
 * which is the failure a deployment is least likely to notice and most likely to cause.
 */
describe('productionChannelCoach', () => {
  it('constructs without ANTHROPIC_API_KEY, so a keyless deploy still takes approvals', async () => {
    const { productionChannelCoach } = await import('./runtime');
    const previous = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = undefined;
    // biome-ignore lint/performance/noDelete: the absent-key case is what is under test.
    delete process.env.ANTHROPIC_API_KEY;

    try {
      expect(() => productionChannelCoach({} as never)).not.toThrow();
    } finally {
      if (previous !== undefined) process.env.ANTHROPIC_API_KEY = previous;
    }
  });
});

/**
 * VIL-337 · THE SEAM THAT MAKES THE VERB LIVE.
 *
 * `watch_for_opening` writes nothing: the row is minted by the router against the
 * outbound message that carried "I'm watching that page", so the intent has to survive
 * the trip from the tool's own closure, through the sixth `buildTools` callback, to
 * `ChannelTurnResult.spotWatch`. Everything else about the feature was tested at one end
 * or the other, and both ends stayed green while that trip was cut.
 *
 * THE REAL VERB, not a stand-in, and the real page it reads: a fake tool here could only
 * prove the runtime forwards what a fake tool produced, which is the one thing nobody
 * doubted.
 */
describe('the watch a turn started', () => {
  const MARKHAM = 'cityofmarkham.perfectmind.com';
  const FULL_COURSE = '85770d4d-bce9-4e53-b969-cf7e88775180';
  const COURSE_URL = `https://${MARKHAM}/Clients/BookMe4LandingPages/CoursesLandingPage?widgetId=15f6af07-39c5-473e-b053-96653f77a406&courseId=${FULL_COURSE}`;
  const fullPage = readFileSync(
    join(__dirname, '..', 'spots', 'fixtures', 'open-window-markham.html'),
    'utf8',
  );

  /** The verb, wired to whatever collector the runtime hands its tool builder. */
  function watchTools(onWatch: (watch: never) => void): RegisteredTool[] {
    return [
      watchForOpeningTool({
        fetchBody: async () => fullPage,
        reader: { householdNames: async () => [] },
        watchConsentGranted: async () => true,
        readClassAvailability: {} as never,
        onWatch: onWatch as never,
      }),
    ];
  }

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('carries the intent the verb collected out of the turn, last call winning', async () => {
    vi.stubEnv('WATCHED_SPOTS_ENABLED', 'true');
    vi.stubEnv('F14_ENABLED', 'true');
    const p = ports({
      buildTools: (_turn, _onDraft, _onOffer, _onShare, _onPromise, onWatch) =>
        watchTools(onWatch as never),
      runAgent: async (args) => {
        const verb = args.tools.find((tool) => tool.name === 'watch_for_opening');
        if (!verb) throw new Error('the runtime built no watch verb');
        // TWO CALLS, because the runtime's local is documented last-call-wins: one arming
        // sentence goes out, and it is the one the model ended up writing.
        await verb.handler(
          { url: COURSE_URL, label: 'Tuesday preschool swim' },
          { familyId: FAMILY, actor: PARENT },
        );
        await verb.handler(
          { url: COURSE_URL, label: 'Saturday skating' },
          { familyId: FAMILY, actor: PARENT },
        );
        return answering("I'm watching that one and I'll text you when a spot opens.")(args);
      },
    });

    const result = await channelCoachRuntime(p).respond(turn('watch this class'), []);

    expect(result.spotWatch).toEqual({
      url: COURSE_URL,
      host: MARKHAM,
      portalLabel: "Markham's portal",
      label: 'Saturday skating',
      instant: false,
      lastState: 'full',
      sessionStartsAt: new Date('2026-09-21T21:00:00.000Z'),
      sessionAnchor: null,
    });
  });

  it('carries null off a turn that never called it', async () => {
    // THE NEGATIVE CONTROL: without it a runtime that returned a constant intent would
    // pass the test above.
    vi.stubEnv('WATCHED_SPOTS_ENABLED', 'true');
    vi.stubEnv('F14_ENABLED', 'true');
    const p = ports({
      buildTools: (_turn, _onDraft, _onOffer, _onShare, _onPromise, onWatch) =>
        watchTools(onWatch as never),
      judgeFindReply: async () => ({ verdict: 'send' }),
    });

    const result = await channelCoachRuntime(p).respond(turn('what is on thursday'), []);

    expect(result.spotWatch).toBeNull();
  });
});

/**
 * WHEN THE NEARBY COUNT IS EVEN LOOKED UP.
 *
 * A count is the least important thing in any message that also carries a promise or a
 * link, so a turn that registered either one does not ask — not "asks and discards",
 * which would pay an indexed scan to throw the answer away.
 */
describe('the nearby count', () => {
  it('asks, and appends what comes back, on an ordinary turn', async () => {
    const p = ports({
      runAgent: answering('Riverdale storytime runs Saturdays at 10.'),
      nearbySaid: async () => ({
        clause: '3 families near you say Riverdale storytime is worth it.',
        title: 'Riverdale storytime',
        otherTitles: [],
      }),
    });

    const { reply } = await channelCoachRuntime(p).respond(turn(), []);

    expect(reply).toContain('3 families near you say Riverdale storytime is worth it.');
  });

  it('does not even ask when the turn offered a plan', async () => {
    const asked: string[] = [];
    const p = ports({
      runAgent: async (args) => {
        const offer = args.tools.find((tool) => tool.name === 'offer_full_plan');
        if (!offer) throw new Error('the runtime built no offer verb');
        await offer.handler({ summary: 'sleep' } as never, {} as never);
        return answering('Riverdale storytime runs Saturdays at 10.')(args);
      },
      buildTools: (_turn, _onDraft, onOffer) => [
        {
          name: 'offer_full_plan',
          description: 'offer',
          inputSchema: {},
          handler: async () => {
            onOffer({ summary: 'sleep', sentence: 'Want me to send the full plan?' } as never);
            return { offered: true };
          },
        } as never,
      ],
      nearbySaid: async (familyId) => {
        asked.push(familyId);
        return {
          clause: '3 families near you say Riverdale storytime is worth it.',
          title: 'Riverdale storytime',
          otherTitles: [],
        };
      },
    });

    const { reply } = await channelCoachRuntime(p).respond(turn(), []);

    expect(asked).toEqual([]);
    expect(reply).not.toContain('families near you');
    expect(reply).toContain('Want me to send the full plan?');
  });
});

/**
 * VIL-497 — the experience-card product path. Dark: no verb, untouched skill, no card.
 * Lit (1:1 only): the model may pick one cited find as a card and writes its title; the
 * URL is the find's own page, resolved from the ref a tool returned this turn.
 */
describe('channelCoachRuntime · experience cards (VIL-497)', () => {
  const PAGE = 'https://example.org/swim/saturday';
  const withLink: ChannelCoachPorts['buildTools'] = (_t, _d, _o, _s, _p, _w, offered) => {
    offered.recordLinks([{ url: PAGE, title: 'Saturday swim' } as never]);
    return [];
  };

  it('dark: registers no card verb and leaves the skill tools untouched', async () => {
    const seen: { tools: string[]; skillTools: string[] }[] = [];
    const p = ports({
      buildTools: withLink,
      runAgent: async (args) => {
        seen.push({
          tools: args.tools.map((t) => t.name),
          skillTools: [...args.skill.meta.tools],
        });
        return answering('ok.')(args);
      },
    });
    const result = await channelCoachRuntime(p).respond(turn(), []);
    expect(seen[0]?.tools).not.toContain('share_experience_card');
    // VIL-303's declined verb rides while a deferred capability is dark; nothing else.
    expect(seen[0]?.skillTools).toEqual(['note_capability_declined']);
    expect(result.experienceCard ?? null).toBeNull();
  });

  it('lit on a group turn: still no card verb', async () => {
    const seen: string[][] = [];
    const p = ports({
      experienceCardsEnabled: () => true,
      loadSkill: async () => SKILL,
      runAgent: async (args) => {
        seen.push(args.tools.map((t) => t.name));
        return answering('ok.')(args);
      },
    });
    await channelCoachRuntime(p)
      .respond({ ...turn(), audience: 'group' }, [])
      .catch(() => undefined);
    expect(seen[0] ?? []).not.toContain('share_experience_card');
  });

  it('lit 1:1: the model picks the card, writes the title; the url comes from the ref', async () => {
    const ref = (await import('./activity-links')).linkRef(PAGE);
    const p = ports({
      experienceCardsEnabled: () => true,
      buildTools: withLink,
      runAgent: async (args) => {
        expect(args.skill.meta.tools).toContain('share_experience_card');
        const card = args.tools.find((t) => t.name === 'share_experience_card');
        if (!card) throw new Error('no card verb');
        await card.handler({ ref, title: 'Sat swim 10am · Riverdale pool' } as never, {} as never);
        return answering(`Saturday swim at Riverdale has room [${ref}].`)(args);
      },
    });
    const result = await channelCoachRuntime(p).respond(turn(), []);
    expect(result.experienceCard).toEqual({ url: PAGE, title: 'Sat swim 10am · Riverdale pool' });
    // The text still cites the page; the router swaps it for the card on iMessage 1:1.
    expect(result.reply).toContain(PAGE);
  });

  it('lit: a ref no tool returned is refused back to the model, nothing registered', async () => {
    let refusal = '';
    const p = ports({
      experienceCardsEnabled: () => true,
      buildTools: withLink,
      runAgent: async (args) => {
        const card = args.tools.find((t) => t.name === 'share_experience_card');
        await card?.handler({ ref: 'link-000000', title: 'x' } as never, {} as never).catch((e) => {
          refusal = (e as Error).message;
        });
        return answering('ok.')(args);
      },
    });
    const result = await channelCoachRuntime(p).respond(turn(), []);
    expect(refusal).toContain('not one a tool returned');
    expect(result.experienceCard).toBeNull();
  });

  it("lit: a teen's name in the title is redacted like the answer", async () => {
    const ref = (await import('./activity-links')).linkRef(PAGE);
    const p = ports({
      experienceCardsEnabled: () => true,
      buildTools: withLink,
      runAgent: async (args) => {
        const card = args.tools.find((t) => t.name === 'share_experience_card');
        await card?.handler({ ref, title: 'Nora · Sat swim' } as never, {} as never);
        return answering(`Swim [${ref}].`)(args);
      },
    });
    const result = await channelCoachRuntime(p).respond(turn(), []);
    expect(result.experienceCard?.title).not.toContain('Nora');
  });
});

/**
 * VIL-495 — the model chooses voice. Dark: no verb, untouched skill, never a memo. Lit
 * (1:1 only): the verb and the addendum ride, and calling it marks the reply as voice.
 */
describe('channelCoachRuntime · voice memos (VIL-495)', () => {
  function seeing(seen: { tools: string[]; skillTools: string[]; instructions: string }[]) {
    return (call?: boolean): ChannelCoachPorts['runAgent'] =>
      async (args) => {
        seen.push({
          tools: args.tools.map((t) => t.name),
          skillTools: [...args.skill.meta.tools],
          instructions: promptOf(args),
        });
        if (call) {
          const verb = args.tools.find((t) => t.name === 'reply_as_voice_memo');
          if (!verb) throw new Error('no voice verb');
          await verb.handler({} as never, {} as never);
        }
        return answering('So glad swim went well. Same time next week?')(args);
      };
  }

  it('dark: no voice verb, the skill untouched, and never a memo', async () => {
    const seen: { tools: string[]; skillTools: string[]; instructions: string }[] = [];
    const result = await channelCoachRuntime(ports({ runAgent: seeing(seen)() })).respond(
      turn(),
      [],
    );
    expect(seen[0]?.tools).not.toContain('reply_as_voice_memo');
    expect(seen[0]?.skillTools).not.toContain('reply_as_voice_memo');
    expect(seen[0]?.instructions).not.toContain('reply_as_voice_memo');
    expect(result.voiceMemo ?? false).toBe(false);
  });

  it('lit on a group turn: still no voice verb', async () => {
    const seen: { tools: string[]; skillTools: string[]; instructions: string }[] = [];
    await channelCoachRuntime(
      ports({
        voiceMemosEnabled: () => true,
        loadSkill: async () => SKILL,
        runAgent: seeing(seen)(),
      }),
    )
      .respond({ ...turn(), audience: 'group' }, [])
      .catch(() => undefined);
    expect(seen[0]?.tools ?? []).not.toContain('reply_as_voice_memo');
  });

  it('lit 1:1: the verb and the addendum ride; not calling it stays text', async () => {
    const seen: { tools: string[]; skillTools: string[]; instructions: string }[] = [];
    const result = await channelCoachRuntime(
      ports({ voiceMemosEnabled: () => true, runAgent: seeing(seen)(false) }),
    ).respond(turn(), []);
    expect(seen[0]?.tools).toContain('reply_as_voice_memo');
    expect(seen[0]?.skillTools).toContain('reply_as_voice_memo');
    expect(seen[0]?.instructions).toContain('A voice memo they sent');
    expect(result.voiceMemo).toBe(false);
  });

  it('lit 1:1: calling the verb marks the same written reply as voice', async () => {
    const seen: { tools: string[]; skillTools: string[]; instructions: string }[] = [];
    const result = await channelCoachRuntime(
      ports({ voiceMemosEnabled: () => true, runAgent: seeing(seen)(true) }),
    ).respond(turn(), []);
    expect(result.voiceMemo).toBe(true);
    expect(result.reply).toContain('So glad swim went well');
  });

  it('hands a heard voice memo to the model as the words the parent said', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const p = ports({
      readInboundMedia: (parts) =>
        readInboundMedia(
          parts,
          (async () => new Response(null)) as unknown as typeof fetch,
          async () => 'is swim still on this saturday',
        ),
      runAgent: async (args) => {
        seen.push(args.context as Record<string, unknown>);
        return answering('It is.')(args);
      },
    });
    await channelCoachRuntime(p).respond(
      {
        ...turn(''),
        inboundMedia: [{ kind: 'audio', url: 'https://cdn.example/memo.m4a', mime: 'audio/x-m4a' }],
      },
      [],
    );
    expect(seen[0]?.arrivedMedia).toEqual([
      { kind: 'audio', heard: 'is swim still on this saturday' },
    ]);
  });
});

describe('channelCoachRuntime · inbound photo facts (VIL-413)', () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0xd9]);
  const FLYER = {
    kind: 'flyer' as const,
    title: 'Fall swim',
    venue: 'Harbor Rec',
    whenText: 'Tuesdays 4:30',
    registrationUrl: 'https://harbor-rec.example/register',
    childName: null,
    notes: 'ages 6-8',
    confidence: 0.9,
  };

  function photoTurn() {
    return {
      ...turn('can you read this'),
      inboundMedia: [
        { kind: 'image' as const, url: 'https://cdn.example/flyer.jpg', mime: 'image/jpeg' },
      ],
    };
  }

  function photoPorts(overrides: Partial<ChannelCoachPorts> = {}) {
    return ports({
      readInboundMedia: (parts) =>
        readInboundMedia(
          parts,
          (async () => new Response(jpeg, { status: 200 })) as unknown as typeof fetch,
        ),
      ...overrides,
    });
  }

  it('dark: does not extract, leaves the skill bytes, and still attaches the image', async () => {
    const addendum = (await loadCronSkill('coach-photo-facts')).instructions;
    const extract = vi.fn();
    const seen: Array<{
      context: Record<string, unknown>;
      instructions: string;
      attachments?: unknown[];
    }> = [];
    const p = photoPorts({
      photoFactsEnabled: () => false,
      readPhotoFacts: extract,
      runAgent: async (args) => {
        seen.push({
          context: args.context as Record<string, unknown>,
          instructions: promptOf(args),
          attachments: args.attachments as unknown[],
        });
        return answering('Got the flyer.')(args);
      },
    });
    await channelCoachRuntime(p).respond(photoTurn(), []);
    expect(extract).not.toHaveBeenCalled();
    expect(seen[0]?.attachments?.[0]).toMatchObject({ type: 'image' });
    expect(seen[0]?.context).not.toHaveProperty('photoFacts');
    expect(seen[0]?.instructions).not.toContain(addendum);
  });

  it('lit: hands the facts and the addendum, and the image still reaches the model', async () => {
    const addendum = (await loadCronSkill('coach-photo-facts')).instructions;
    const toolsTurns: ChannelTurn[] = [];
    const seen: Array<{
      context: Record<string, unknown>;
      instructions: string;
      attachments?: unknown[];
    }> = [];
    const p = photoPorts({
      photoFactsEnabled: () => true,
      readPhotoFacts: async () => FLYER,
      buildTools: (incoming) => {
        toolsTurns.push(incoming);
        return [];
      },
      runAgent: async (args) => {
        seen.push({
          context: args.context as Record<string, unknown>,
          instructions: promptOf(args),
          attachments: args.attachments as unknown[],
        });
        return answering('Fall swim is Tuesdays.')(args);
      },
    });
    await channelCoachRuntime(p).respond(photoTurn(), []);
    expect(seen[0]?.context.photoFacts).toEqual({ ...FLYER, readFrom: 'image' });
    expect(seen[0]?.instructions.endsWith(`\n\n${addendum}`)).toBe(true);
    expect(seen[0]?.attachments?.[0]).toMatchObject({ type: 'image' });
    expect(toolsTurns[0]?.photoFacts).toEqual({ ...FLYER, readFrom: 'image' });
  });

  it('lit: a group turn reads nothing new and keeps its bytes', async () => {
    const addendum = (await loadCronSkill('coach-photo-facts')).instructions;
    const extract = vi.fn(async () => FLYER);
    const seen: Array<{ context: Record<string, unknown>; instructions: string }> = [];
    const p = photoPorts({
      photoFactsEnabled: () => true,
      readPhotoFacts: extract,
      runAgent: async (args) => {
        seen.push({
          context: args.context as Record<string, unknown>,
          instructions: promptOf(args),
        });
        return answering('Got it.')(args);
      },
    });
    await channelCoachRuntime(p).respond({ ...photoTurn(), audience: 'group' }, []);
    expect(extract).not.toHaveBeenCalled();
    expect(seen[0]?.context).not.toHaveProperty('photoFacts');
    expect(seen[0]?.instructions).not.toContain(addendum);
  });

  it('lit: an extract failure still attaches the image and sends no canned line', async () => {
    const extract = vi.fn(async () => {
      throw new Error('down');
    });
    const seen: Array<{ context: Record<string, unknown>; attachments?: unknown[] }> = [];
    const p = photoPorts({
      photoFactsEnabled: () => true,
      readPhotoFacts: extract,
      runAgent: async (args) => {
        seen.push({
          context: args.context as Record<string, unknown>,
          attachments: args.attachments as unknown[],
        });
        return answering('Got the flyer.')(args);
      },
    });
    const { reply } = await channelCoachRuntime(p).respond(photoTurn(), []);
    expect(extract).toHaveBeenCalled();
    expect(seen[0]?.attachments?.[0]).toMatchObject({ type: 'image' });
    expect(seen[0]?.context).not.toHaveProperty('photoFacts');
    expect(reply).toBe('Got the flyer.');
  });

  const pdf = Buffer.from('%PDF-1.7\n%%EOF\n');

  function pdfTurn() {
    return {
      ...turn('can you read this form'),
      inboundMedia: [
        { kind: 'image' as const, url: 'https://cdn.example/flyer.jpg', mime: 'image/jpeg' },
        { kind: 'file' as const, url: 'https://cdn.example/form.pdf', mime: 'application/pdf' },
      ],
    };
  }

  function pdfPorts(overrides: Partial<ChannelCoachPorts> = {}) {
    return ports({
      photoFactsEnabled: () => true,
      readInboundMedia: (parts) =>
        readInboundMedia(
          parts,
          (async () => new Response(jpeg, { status: 200 })) as unknown as typeof fetch,
          undefined,
          undefined,
          { documents: true, documentFetch: async () => new Response(pdf, { status: 200 }) },
        ),
      ...overrides,
    });
  }

  /** What the API answers for a PDF it will not read: the whole request, refused. */
  const pdfRefused = () =>
    Anthropic.APIError.generate(
      400,
      {
        type: 'error',
        error: { type: 'invalid_request_error', message: 'The PDF specified was not valid.' },
      },
      undefined,
      {},
    );

  function refusesPdfs(onCall: (args: RunAgentArgs) => Promise<void> = async () => {}) {
    const calls: Array<{
      attachments?: Array<{ type: string }>;
      context: Record<string, unknown>;
    }> = [];
    const runAgent: ChannelCoachPorts['runAgent'] = async (args) => {
      calls.push({
        attachments: args.attachments as Array<{ type: string }> | undefined,
        context: args.context as Record<string, unknown>,
      });
      await onCall(args);
      if (args.attachments?.some((block) => block.type === 'document')) throw pdfRefused();
      return answering('The flyer says Tuesdays; the form would not open.')(args);
    };
    return { calls, runAgent };
  }

  it("lit: facts read beside a PDF are the document's", async () => {
    const toolsTurns: ChannelTurn[] = [];
    const p = pdfPorts({
      readPhotoFacts: async () => FLYER,
      buildTools: (incoming) => {
        toolsTurns.push(incoming);
        return [];
      },
    });
    await channelCoachRuntime(p).respond(pdfTurn(), []);
    expect(toolsTurns[0]?.photoFacts).toEqual({ ...FLYER, readFrom: 'document' });
  });

  it('lit: a PDF the API refuses becomes an unwatched file, and the coach still answers', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const { calls, runAgent } = refusesPdfs();
    const p = pdfPorts({
      readPhotoFacts: async () => {
        throw pdfRefused();
      },
      runAgent,
    });
    const { reply } = await channelCoachRuntime(p).respond(pdfTurn(), []);
    expect(reply).toBe('The flyer says Tuesdays; the form would not open.');
    expect(calls.map((call) => call.attachments?.map((block) => block.type))).toEqual([
      ['image', 'document'],
      ['image'],
    ]);
    expect(calls[0]?.context).not.toHaveProperty('arrivedMedia');
    expect(calls[1]?.context.arrivedMedia).toEqual([{ kind: 'file' }]);
    expect(info).toHaveBeenCalledWith(
      { reason: 'provider_refused', count: 1 },
      'channel coach: inbound document unread',
    );
    info.mockRestore();
  });

  it('lit: a refusal after a tool has acted is not retried', async () => {
    const noted = defineTool({
      name: 'note_it',
      description: 'test tool',
      inputSchema: z.object({}),
      monetary: false,
      touchesChildContent: false,
      handler: async () => ({ noted: true }),
    });
    const { calls, runAgent } = refusesPdfs(async (args) => {
      await invokeTool(noted, {}, args.toolContext, args.guardDeps);
    });
    const p = pdfPorts({
      readPhotoFacts: async () => null,
      buildTools: () => [noted],
      runAgent,
    });
    await expect(channelCoachRuntime(p).respond(pdfTurn(), [])).rejects.toBeInstanceOf(
      ChannelTurnFailed,
    );
    expect(calls).toHaveLength(1);
  });
});

describe('productionChannelCoachPorts · whose voice memo is heard (VIL-495)', () => {
  const MEMO = [
    { kind: 'audio' as const, url: 'https://cdn.example/memo.m4a', mime: 'audio/x-m4a' },
  ];

  function lit() {
    vi.stubEnv('LINQ_VOICE_MEMOS_ENABLED', 'true');
    vi.stubEnv('AI_GATEWAY_API_KEY', 'gateway_test_key_not_a_secret');
    return vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (url) =>
        String(url).startsWith('https://cdn.example/')
          ? new Response(new Uint8Array([1, 2, 3]))
          : new Response(JSON.stringify({ text: 'is swim still on' })),
      );
  }

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('the runtime tells the media port who the turn is for', async () => {
    const audiences: unknown[] = [];
    const p = ports({
      readInboundMedia: async (_parts, audience) => {
        audiences.push(audience);
        return {
          blocks: [],
          unwatched: [{ kind: 'audio' }],
          contacts: [],
          contactsTruncated: false,
        };
      },
    });
    for (const audience of ['group', 'direct'] as const) {
      await channelCoachRuntime(p).respond({ ...turn(''), audience, inboundMedia: MEMO }, []);
    }
    expect(audiences).toEqual(['group', 'direct']);
  });

  it("a group member's memo is never sent to the transcriber", async () => {
    const fetchSpy = lit();
    const read = productionChannelCoachPorts({} as Database).readInboundMedia;
    const out = await read?.(MEMO, 'group');
    expect(out?.unwatched).toEqual([{ kind: 'audio' }]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("the parent's own 1:1 memo is heard (positive control)", async () => {
    const fetchSpy = lit();
    const read = productionChannelCoachPorts({} as Database).readInboundMedia;
    const out = await read?.(MEMO, 'direct');
    expect(out?.unwatched).toEqual([{ kind: 'audio', heard: 'is swim still on' }]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

describe('channelCoachRuntime · group leave (VIL-477)', () => {
  it('dark group turn: no leave verb, skill untouched', async () => {
    const seen: string[][] = [];
    const p = ports({
      loadSkill: async () => SKILL,
      runAgent: async (args) => {
        seen.push([...args.tools.map((t) => t.name), ...args.skill.meta.tools]);
        return answering('ok.')(args);
      },
    });
    const result = await channelCoachRuntime(p).respond({ ...turn(), audience: 'group' }, []);
    expect(seen[0]).not.toContain('leave_group_chat');
    expect(result.groupLeave ?? null).toBeNull();
  });

  it('lit on a 1:1 turn: still no leave verb', async () => {
    const seen: string[][] = [];
    const p = ports({
      groupLeaveEnabled: () => true,
      runAgent: async (args) => {
        seen.push(args.tools.map((t) => t.name));
        return answering('ok.')(args);
      },
    });
    const result = await channelCoachRuntime(p).respond(turn(), []);
    expect(seen[0]).not.toContain('leave_group_chat');
    expect(result.groupLeave ?? null).toBeNull();
  });

  it('lit group: the model reads the ask, writes its own goodbye, registers the leave', async () => {
    const p = ports({
      groupLeaveEnabled: () => true,
      loadSkill: async () => SKILL,
      runAgent: async (args) => {
        expect(args.skill.meta.tools).toContain('leave_group_chat');
        const leave = args.tools.find((t) => t.name === 'leave_group_chat');
        if (!leave) throw new Error('no leave verb');
        await leave.handler(
          { ask: 'Hale can you leave this group', ifLeaveFails: 'Model stay line.' } as never,
          {} as never,
        );
        return answering('Model-written goodbye.')(args);
      },
    });
    const result = await channelCoachRuntime(p).respond(
      { ...turn('Hale can you leave this group?'), audience: 'group' },
      [],
    );
    expect(result.groupLeave).toEqual({ ifLeaveFails: 'Model stay line.' });
    expect(result.reply).toContain('Model-written goodbye.');
  });

  it("lit group: a model-invented ask (not in this turn's words) registers no leave", async () => {
    const p = ports({
      groupLeaveEnabled: () => true,
      loadSkill: async () => SKILL,
      runAgent: async (args) => {
        const leave = args.tools.find((t) => t.name === 'leave_group_chat');
        if (!leave) throw new Error('no leave verb');
        await leave.handler(
          { ask: 'Hale please leave this group', ifLeaveFails: 'x' } as never,
          {} as never,
        );
        return answering('ok.')(args);
      },
    });
    const result = await channelCoachRuntime(p).respond(
      { ...turn('who is doing pickup friday'), audience: 'group' },
      [],
    );
    expect(result.groupLeave ?? null).toBeNull();
  });

  it('lit group, no ask: the model does not call it, nothing registered', async () => {
    const p = ports({
      groupLeaveEnabled: () => true,
      loadSkill: async () => SKILL,
      runAgent: answering('Sure, quieter from me.'),
    });
    const result = await channelCoachRuntime(p).respond({ ...turn(), audience: 'group' }, []);
    expect(result.groupLeave ?? null).toBeNull();
  });
});

describe('channelCoachRuntime · read_email (VIL-433)', () => {
  function emailReader(connected: boolean) {
    const reads: unknown[] = [];
    const asked: string[] = [];
    return {
      reads,
      asked,
      reader: {
        connected: async (_familyId: string, parentUserId: string) => {
          asked.push(parentUserId);
          return connected;
        },
        read: async (request: unknown) => {
          reads.push(request);
          return { read: true as const, body: 'We can set up a visit.', truncated: false };
        },
      },
    };
  }

  function seeing(seen: { tools: string[]; skillTools: string[]; instructions: string }[]) {
    return async (args: Parameters<ChannelCoachPorts['runAgent']>[0]) => {
      seen.push({
        tools: args.tools.map((t) => t.name),
        skillTools: [...args.skill.meta.tools],
        instructions: promptOf(args),
      });
      return answering('ok.')(args);
    };
  }

  it('1:1 with their own Gmail connected: lists and registers the verb, read in this thread', async () => {
    const e = emailReader(true);
    const p = ports({
      emailReader: e.reader,
      runAgent: async (args) => {
        expect(args.skill.meta.tools).toContain('read_email');
        expect(promptOf(args)).toContain('read_email');
        const tool = args.tools.find((t) => t.name === 'read_email');
        if (!tool) throw new Error('no read_email verb');
        await tool.handler({ gmailMessageId: 'gm-1' } as never, {} as never);
        return answering('They can set up a visit.')(args);
      },
    });
    await channelCoachRuntime(p).respond(turn('what did it say'), []);
    expect(e.asked).toEqual([PARENT]);
    expect(e.reads).toEqual([
      {
        familyId: FAMILY,
        parentUserId: PARENT,
        conversationId: CONVERSATION,
        gmailMessageId: 'gm-1',
      },
    ]);
  });

  it('1:1 without a connected Gmail: no verb and the skill is untouched', async () => {
    const seen: { tools: string[]; skillTools: string[]; instructions: string }[] = [];
    const e = emailReader(false);
    await channelCoachRuntime(ports({ emailReader: e.reader, runAgent: seeing(seen) })).respond(
      turn('what did it say'),
      [],
    );
    expect(e.asked).toEqual([PARENT]);
    expect(seen[0]?.tools).not.toContain('read_email');
    expect(seen[0]?.skillTools).not.toContain('read_email');
    expect(seen[0]?.instructions).not.toContain('read_email');
  });

  /** VIL-615: the runtime applies the taint to the whole turn's tool set, so a write
   * the model reaches for after reading the email never runs. Each call goes through the
   * real `invokeTool`, where the refusal lands before the audit row (VIL-616). */
  function draftingTurn(order: 'read_first' | 'write_first') {
    const e = emailReader(true);
    const drafted: string[] = [];
    const outcomes: string[] = [];
    const propose: RegisteredTool = {
      name: 'propose_calendar_add',
      description: 'x',
      inputSchema: { parse: (v: unknown) => v } as never,
      monetary: false,
      touchesChildContent: false,
      handler: async () => {
        drafted.push('propose_calendar_add');
        return { drafted: true };
      },
    };
    const p = ports({
      emailReader: e.reader,
      buildTools: () => [propose],
      runAgent: async (args) => {
        const call = async (name: string, input: unknown) => {
          const tool = args.tools.find((t) => t.name === name);
          if (!tool) throw new Error(`no ${name}`);
          await invokeTool(tool, input, { familyId: 'fam', actor: 'parent' }, args.guardDeps).then(
            () => outcomes.push(`${name}:ran`),
            (err: unknown) => outcomes.push(`${name}:${(err as { rail?: string }).rail}`),
          );
        };
        const steps: [string, unknown][] = [
          ['read_email', { gmailMessageId: 'gm-1' }],
          ['propose_calendar_add', {}],
        ];
        for (const [name, input] of order === 'read_first' ? steps : steps.reverse())
          await call(name, input);
        return answering('Picture day is Friday.')(args);
      },
    });
    return { p, drafted, outcomes };
  }

  it('a write after read_email returned text is refused for the rest of the turn', async () => {
    const t = draftingTurn('read_first');
    const result = await channelCoachRuntime(t.p).respond(turn('what did it say'), []);
    expect(t.outcomes).toEqual(['read_email:ran', 'propose_calendar_add:untrusted_content']);
    expect(t.drafted).toEqual([]);
    expect(result.reply).toBe('Picture day is Friday.');
    // VIL-616: the router marks the thread row this reply lands in.
    expect(result.emailRead).toBe(true);
  });

  it('a write before the email was read still runs (positive control)', async () => {
    const t = draftingTurn('write_first');
    await channelCoachRuntime(t.p).respond(turn('add picture day, then what did it say'), []);
    expect(t.outcomes).toEqual(['propose_calendar_add:ran', 'read_email:ran']);
    expect(t.drafted).toEqual(['propose_calendar_add']);
  });

  it('a turn that never read an email does not mark its reply', async () => {
    const e = emailReader(true);
    const result = await channelCoachRuntime(
      ports({ emailReader: e.reader, runAgent: answering('Swim is at 4.') }),
    ).respond(turn('when is swim'), []);
    expect(result.emailRead).toBe(false);
  });

  it('a group turn never offers it, even when the parent has Gmail connected', async () => {
    const seen: { tools: string[]; skillTools: string[]; instructions: string }[] = [];
    const e = emailReader(true);
    await channelCoachRuntime(ports({ emailReader: e.reader, runAgent: seeing(seen) }))
      .respond({ ...turn('what did the daycare say'), audience: 'group' }, [])
      .catch(() => undefined);
    expect(e.asked).toEqual([]);
    expect(seen[0]?.tools ?? []).not.toContain('read_email');
    expect(seen[0]?.skillTools ?? []).not.toContain('read_email');
  });
});

describe('find reasoning stays off the reply (VIL-524)', () => {
  const send = async () => ({ verdict: 'send' as const });

  it('does not append the private skill or call the judge on a calendar edit', async () => {
    let instructions = '';
    let judged = 0;
    const p = ports({
      judgeFindReply: async () => {
        judged += 1;
        return { verdict: 'withhold' };
      },
      runAgent: async (args) => {
        instructions = promptOf(args);
        return answering('You and Sam share one page for the swim signup.')(args);
      },
    });
    const { reply } = await channelCoachRuntime(p).respond(turn('move swim to tuesday'), []);
    expect(instructions).not.toContain('Keep the finding to yourself');
    expect(judged).toBe(0);
    expect(reply).toBe('You and Sam share one page for the swim signup.');
  });

  it('appends the private skill on a nearby-find ask and sends the draft unchanged', async () => {
    const draft = 'All three finds are at the library: Storytime Saturday at 10.';
    let instructions = '';
    const p = ports({
      judgeFindReply: send,
      runAgent: async (args) => {
        instructions = promptOf(args);
        return answering(draft)(args);
      },
    });
    const { reply } = await channelCoachRuntime(p).respond(turn("what's on this weekend"), []);
    expect(instructions).toContain('Keep the finding to yourself');
    expect(instructions).toContain('Nearby finds');
    expect(reply).toBe(draft);
  });

  it('sends nothing when the judge says the whole reply is reasoning', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const draft = 'All three finds share one page…';
    const p = ports({
      judgeFindReply: async () => ({ verdict: 'withhold' }),
      runAgent: answering(draft),
    });
    const failure = await channelCoachRuntime(p)
      .respond(turn("what's on this weekend"), [])
      .then(
        () => null,
        (err: unknown) => err,
      );
    // A failed turn (router keeps the drafts receipt + failed ledger), never the draft.
    expect(failure).toBeInstanceOf(ChannelTurnFailed);
    const thrown = failure as ChannelTurnFailed;
    expect(thrown.message).not.toContain(draft);
    expect(String(thrown.cause ?? '')).not.toContain(draft);
    expect(thrown.draftedActionIds).toEqual([]);
    expect(p.recorded).toEqual([expect.objectContaining({ status: 'failed' })]);
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'find_reasoning' }),
      expect.any(String),
    );
    error.mockRestore();
  });

  it('judges a turn that handed over a find, whatever language the ask was in', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    let judged = 0;
    const p = ports({
      buildTools: (_t, _d, _o, _s, _p, _w, offered) => {
        offered.recordLinks([
          { url: 'https://example.org/storytime', title: 'Storytime' } as never,
        ]);
        return [];
      },
      judgeFindReply: async () => {
        judged += 1;
        return { verdict: 'withhold' };
      },
      runAgent: answering("J'ai trouvé trois activités sur la même page."),
    });
    const failure = await channelCoachRuntime(p)
      .respond(turn("qu'est-ce qu'on peut faire samedi avec les petits?"), [])
      .then(
        () => null,
        (err: unknown) => err,
      );
    expect(judged).toBe(1);
    expect(failure).toBeInstanceOf(ChannelTurnFailed);
    error.mockRestore();
  });

  it("the judge reads the draft with a teen's name already redacted", async () => {
    const drafts: string[] = [];
    const p = ports({
      judgeFindReply: async (draft) => {
        drafts.push(draft);
        return { verdict: 'send' };
      },
      runAgent: answering('Nora and Sam can do Storytime Saturday at 10.'),
    });
    await channelCoachRuntime(p).respond(turn("what's on this weekend"), []);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).not.toContain('Nora');
    // POSITIVE CONTROL: the rest of the draft reaches the judge as written.
    expect(drafts[0]).toContain('Sam can do Storytime Saturday at 10.');
  });

  it('production wires the model judge, not the pass-through', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    const gate = await productionChannelCoachPorts({} as Database).judgeFindReply(
      'EarlyON Saturday at 10.',
    );
    expect(gate).toEqual({ verdict: 'unjudged', reason: 'client_unavailable' });
  });

  it('the scripted pass-through sends the draft and names that', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const draft = 'EarlyON Saturday at 10.';
    const p = ports({ judgeFindReply: findReplyNotJudged, runAgent: answering(draft) });
    const { reply } = await channelCoachRuntime(p).respond(turn("what's on this weekend"), []);
    expect(reply).toBe(draft);
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'not_configured' }),
      expect.any(String),
    );
    error.mockRestore();
  });

  it('sends nothing when the judge does not run', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const draft = 'EarlyON Saturday at 10.';
    const p = ports({
      judgeFindReply: async () => ({ verdict: 'unjudged', reason: 'judge_failed' }),
      runAgent: answering(draft),
    });
    const failure = await channelCoachRuntime(p)
      .respond(turn("what's on this weekend"), [])
      .then(
        () => null,
        (err: unknown) => err,
      );
    expect(failure).toBeInstanceOf(ChannelTurnFailed);
    const thrown = failure as ChannelTurnFailed;
    expect(thrown.message).not.toContain(draft);
    expect(String(thrown.cause ?? '')).not.toContain(draft);
    expect(thrown.draftedActionIds).toEqual([]);
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'judge_failed' }),
      expect.any(String),
    );
    error.mockRestore();
  });
});

/**
 * VIL-303 · the plumbing of a stale no: which verbs a turn gets, what context it
 * carries, and what rides out. Whether the model calls them is the eval's
 * (run-coach-capability-correction-eval.mjs).
 */
describe('deferred capabilities', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function lightEverything() {
    vi.stubEnv('AUTHORIZED_SIGNUP_ENABLED', 'on');
    vi.stubEnv('WATCHED_SPOTS_ENABLED', 'true');
    vi.stubEnv('F14_ENABLED', 'true');
  }

  async function run(
    options: {
      audience?: ChannelTurn['audience'];
      owed?: { capability: 'sign_up' | 'spot_watch'; toldOn: string }[];
      call?: { tool: string; capability: string }[];
    } = {},
  ) {
    const seen: { tools: string[]; listed: string[]; context: unknown; instructions: string }[] =
      [];
    const p = ports({
      ...(options.owed ? { loadOwedCorrections: async () => options.owed ?? [] } : {}),
      runAgent: async (args) => {
        seen.push({
          tools: args.tools.map((tool) => tool.name),
          listed: args.skill.meta.tools,
          context: args.context,
          instructions: promptOf(args),
        });
        for (const call of options.call ?? []) {
          const tool = args.tools.find((t) => t.name === call.tool);
          await tool?.handler({ capability: call.capability }, { familyId: FAMILY, actor: PARENT });
        }
        return answering('ok.')(args);
      },
    });
    const result = await channelCoachRuntime(p).respond(
      { ...turn(), audience: options.audience ?? 'direct' },
      [],
    );
    return { result, seen: seen[0] };
  }

  it('offers the declined verb with only the dark capabilities, and carries what it noted', async () => {
    vi.stubEnv('AUTHORIZED_SIGNUP_ENABLED', 'on');
    const { result, seen } = await run({
      call: [{ tool: 'note_capability_declined', capability: 'spot_watch' }],
    });

    expect(seen?.tools).toContain('note_capability_declined');
    expect(seen?.listed).toContain('note_capability_declined');
    expect(seen?.tools).not.toContain('note_capability_correction');
    expect(result.capabilityNotes).toEqual({ declined: ['spot_watch'], corrected: [] });
  });

  it('cannot note a no about a capability that is already lit', async () => {
    vi.stubEnv('AUTHORIZED_SIGNUP_ENABLED', 'on');
    const registered: RegisteredTool[] = [];
    const p = ports({
      runAgent: async (args) => {
        registered.push(...args.tools);
        return answering('ok.')(args);
      },
    });
    await channelCoachRuntime(p).respond(turn(), []);

    const verb = registered.find((tool) => tool.name === 'note_capability_declined');
    expect(verb?.inputSchema.safeParse({ capability: 'spot_watch' }).success).toBe(true);
    expect(verb?.inputSchema.safeParse({ capability: 'sign_up' }).success).toBe(false);
  });

  it('offers no declined verb once every capability is lit, and none on a group turn', async () => {
    const dark = await run();
    expect(dark.seen?.tools).toContain('note_capability_declined');
    expect((await run({ audience: 'group' })).seen?.tools).not.toContain(
      'note_capability_declined',
    );
    lightEverything();
    expect((await run()).seen?.tools).not.toContain('note_capability_declined');
    expect((await run()).result.capabilityNotes).toBeNull();
  });

  it('carries an owed correction as context, with its addendum and verb', async () => {
    lightEverything();
    const addendum = (await loadCronSkill('coach-capability-correction')).instructions;
    const owed = [{ capability: 'sign_up' as const, toldOn: '2026-10-02' }];
    const { result, seen } = await run({
      owed,
      call: [{ tool: 'note_capability_correction', capability: 'sign_up' }],
    });

    expect(seen?.context).toEqual(expect.objectContaining({ capabilityCorrections: owed }));
    expect(seen?.instructions.endsWith(`\n\n${addendum}`)).toBe(true);
    expect(seen?.listed).toContain('note_capability_correction');
    expect(result.capabilityNotes).toEqual({ declined: [], corrected: ['sign_up'] });

    const none = await run({ owed: [] });
    expect(none.seen?.context).not.toHaveProperty('capabilityCorrections');
    expect(none.seen?.instructions).not.toContain(addendum);
    expect(none.seen?.tools).not.toContain('note_capability_correction');

    const group = await run({ owed, audience: 'group' });
    expect(group.seen?.context).not.toHaveProperty('capabilityCorrections');
    expect(group.seen?.tools).not.toContain('note_capability_correction');
  });
});
