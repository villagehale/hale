import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type RegisteredTool, type Skill, invokeTool } from '@hale/agent';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type ChannelTurn, draftsFromFailure } from '~/lib/channel/router/coach-runtime';
import { smsSegments } from '~/lib/channel/sms-segments';
import { watchForOpeningTool } from '~/lib/channel/spots/tool';
import { type ChannelCoachPorts, channelCoachRuntime } from './runtime';

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

const FAMILY = '11111111-1111-4111-8111-111111111111';
const PARENT = '22222222-2222-4222-8222-222222222222';
const CONVERSATION = '33333333-3333-4333-8333-333333333333';
const NOW = new Date('2026-07-30T12:00:00.000Z');
const LINK = 'https://app.villagehale.com';
const WATCH = {
  id: '44444444-4444-4444-8444-444444444444',
  town: 'King',
  programs: 'Winter 2027',
  sourceUrl: 'https://www.king.ca/recreation',
  optIn: 'opted_in' as const,
  outcome: null,
};

function readThenAnswer(answer: string, ids = [WATCH.id]): ChannelCoachPorts['runAgent'] {
  return async (args) => {
    const tool = args.tools.find((tool) => tool.name === 'read_registration_page');
    if (!tool) throw new Error('registration read tool missing');
    for (const watchId of ids)
      await invokeTool(tool, { watchId }, args.toolContext, args.guardDeps);
    return answering(answer)(args);
  };
}

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
      return { question: input.question, transcript: input.transcript } as never;
    },
    loadChildren: async () => [TEEN],
    loadRegistrationWatches: async () => [],
    readRegistrationWatch: async () => null,
    buildTools: () => [] as RegisteredTool[],
    // Nothing nearby by default: the surface flag is off for months, so silence is the
    // ordinary answer and the cases that exercise it override this.
    nearbySaid: async () => null,
    guardDeps: { async writeAudit() {} },
    // Never reached: `runAgent` is injected below, and it is the only consumer.
    client: () => ({ messages: {} }) as never,
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
  it('loads watch metadata on every turn, without reading pages before the model chooses', async () => {
    let reads = 0;
    let lists = 0;
    let instructions = '';
    const p = ports({
      loadRegistrationWatches: async () => {
        lists++;
        return [WATCH];
      },
      readRegistrationWatch: async () => {
        reads++;
        return null;
      },
      runAgent: async (args) => {
        instructions = args.skill.instructions;
        expect(args.context).toHaveProperty('registrationWatches', [WATCH]);
        expect(args.context).not.toHaveProperty('registrationWindows');
        expect(args.skill.meta.tools).toContain('read_registration_page');
        expect(reads).toBe(0);
        return answering('Thanks.')(args);
      },
    });
    const ordinary = await channelCoachRuntime(p).respond(turn('How do I help with bedtime?'), []);
    expect(ordinary.reply).toBe('Thanks.');
    await channelCoachRuntime(p).respond(turn('Cancel Thursday swim'), []);
    expect(reads).toBe(0);
    expect(lists).toBe(2);
    await channelCoachRuntime(p).respond(turn('When does registration open?'), []);
    expect(reads).toBe(0);
    expect(lists).toBe(3);
    expect(instructions).toContain('Registration live truth');
  });
  it.each(['When do registrations open?', 'When can I enroll?', 'What time now?'])(
    'lets the model read a tracked page for %s without a keyword gate',
    async (question) => {
      let reads = 0;
      const p = ports({
        loadTranscript: async () => [{ role: 'assistant', content: 'Registration opens Sep 1.' }],
        loadRegistrationWatches: async () => [WATCH],
        readRegistrationWatch: async (familyId, watchId) => {
          expect(familyId).toBe(FAMILY);
          expect(watchId).toBe(WATCH.id);
          reads++;
          return {
            town: WATCH.town,
            programs: WATCH.programs,
            opensFor: '2026-11-24 (opening time not published) America/Toronto',
            residentsFirst: false,
            generalOpens: null,
            ageApproximate: false,
            watching: true,
            sourceUrl: WATCH.sourceUrl,
          };
        },
        runAgent: readThenAnswer('Registration opens Nov 24, 2026 (America/Toronto).'),
      });
      const result = await channelCoachRuntime(p).respond(turn(question), []);
      expect(reads).toBe(1);
      expect(result.reply).toContain(WATCH.sourceUrl);
    },
  );
  it('answers a turn with the post-processed reply', async () => {
    const { reply } = await channelCoachRuntime(ports()).respond(turn(), []);

    expect(reply).toBe('Move swim to Tue 4:30? YES to confirm.');
  });

  it('a held registration answer retains the source even when the model omits its link', async () => {
    const sourceUrl = 'https://www.king.ca/recreation';
    const p = ports({
      loadRegistrationWatches: async () => [WATCH],
      readRegistrationWatch: async () => ({
        town: 'King',
        programs: 'Winter 2027',
        opensFor: 'Current date could not be verified. Do not use a cached date.',
        residentsFirst: false,
        generalOpens: null,
        ageApproximate: false,
        watching: true,
        reminderState: 'paused',
        sourceUrl,
      }),
      runAgent: readThenAnswer(
        "I couldn't verify the current date. Date reminders are paused while I check again.",
      ),
    });
    const { reply } = await channelCoachRuntime(p).respond(
      turn('When does registration open?'),
      [],
    );
    expect(reply).toContain("couldn't verify");
    expect(reply).toContain(sourceUrl);
    expect(reply).not.toMatch(/\b(?:2026|2027|midnight|09:00)\b/);
  });

  it('keeps a freshly read partial registration date, note and source in the final reply', async () => {
    const sourceUrl = 'https://example.org/register';
    const note = 'The registration year is not established by this page.';
    const p = ports({
      loadRegistrationWatches: async () => [{ ...WATCH, sourceUrl }],
      readRegistrationWatch: async () => ({
        town: 'Course operator',
        programs: 'Swim registration',
        opensFor: 'The full date could not be verified.',
        residentsFirst: false,
        generalOpens: null,
        ageApproximate: false,
        watching: true,
        reminderState: 'paused',
        minuteReminderAvailable: false,
        sourceUrl,
        partialDates: [
          {
            kind: 'unclassified_open',
            dateText: 'December 7',
            note,
            evidence: ['Registration opens December 7.'],
          },
        ],
      }),
      runAgent: readThenAnswer('The full date is unconfirmed; precise date reminders are paused.'),
    });
    const { reply } = await channelCoachRuntime(p).respond(
      turn('When does registration open?'),
      [],
    );
    expect(reply).toContain('December 7');
    expect(reply).toContain(note);
    expect(reply).toContain(sourceUrl);
    expect(reply).not.toContain('2026-12-07');
  });

  it.each([false, true])(
    'preserves the full long answer and eligibility beside another draft (draft=%s)',
    async (drafted) => {
      const sourceUrl =
        'https://www.markham.ca/sports-recreation-fitness/sports-recreation-programs/registration-and-general-information';
      const p = ports({
        buildTools: (_turn, onDraft) => {
          if (drafted) onDraft('another-action');
          return [];
        },
        loadRegistrationWatches: async () => [WATCH],
        readRegistrationWatch: async () => ({
          town: 'Markham',
          programs: '2026 Fall Programs, Swim Lessons and Winter Break Camps',
          opensFor: 'No opening date confirmed for this household (eligibility unconfirmed).',
          residentsFirst: false,
          generalOpens: null,
          unclassifiedOpens: '2026-08-11 at 06:30 America/Toronto',
          ageApproximate: false,
          watching: true,
          reminderState: 'paused',
          sourceUrl,
        }),
        runAgent: readThenAnswer(
          `Swim change drafted for approval. The page lists 2026-08-11 at 06:30 America/Toronto for Fall Programs, Swim Lessons and Winter Break Camps. ${'Please check the details. '.repeat(5)} Resident/non-resident eligibility is unconfirmed. Date reminders are paused.`,
        ),
      });
      const { reply } = await channelCoachRuntime(p).respond(turn('When can I register?'), []);
      expect(reply).toContain('2026-08-11 at 06:30 America/Toronto');
      if (drafted) {
        expect(reply).toContain('Swim change drafted for approval.');
        expect(reply).toContain('Markham:');
        expect(reply).toContain('resident/non-resident eligibility unconfirmed.');
        expect(reply).toContain(sourceUrl);
        return;
      }
      expect(reply).toContain('resident/non-resident eligibility unconfirmed');
      expect(reply).toContain('Date reminders are paused.');
      expect(reply).toContain(sourceUrl);
      expect(reply).not.toContain('...');
      expect(reply).toContain('Please check the details. '.repeat(5).trim());
    },
  );

  it.each(['active', 'awaiting_confirmation'] as const)(
    'a verified registration answer retains its source when the watch is %s',
    async (reminderState) => {
      const sourceUrl =
        'https://www.richmondhill.ca/en/things-to-do/Community-Recreation-Guide.aspx';
      const p = ports({
        loadRegistrationWatches: async () => [{ ...WATCH, sourceUrl }],
        readRegistrationWatch: async () => ({
          town: 'Richmond Hill',
          programs: 'Winter 2026-2027',
          opensFor: '2026-11-24 (opening time not published) America/Toronto',
          residentsFirst: true,
          generalOpens: null,
          ageApproximate: false,
          watching: reminderState === 'active',
          reminderState,
          sourceUrl,
        }),
        runAgent: readThenAnswer(
          'Resident registration opens Nov 24, 2026 (America/Toronto). Opening time not published.',
        ),
      });
      const { reply } = await channelCoachRuntime(p).respond(
        turn('Could you recheck the official page for resident registration?'),
        [],
      );
      expect(reply).toContain('Nov 24, 2026');
      expect(reply.endsWith(sourceUrl)).toBe(true);
    },
  );

  it('retains all live registration sources once, not just the first watch', async () => {
    const sourceUrls = ['https://www.king.ca/recreation', 'https://www.richmondhill.ca/recreation'];
    const p = ports({
      loadRegistrationWatches: async () =>
        sourceUrls.map((sourceUrl, index) => ({
          ...WATCH,
          id: `44444444-4444-4444-8444-${String(index).padStart(12, '0')}`,
          sourceUrl,
        })),
      readRegistrationWatch: async (_familyId, watchId) => ({
        town: 'tracked course',
        programs: 'Winter 2027',
        opensFor: '2026-11-24 (opening time not published) America/Toronto',
        residentsFirst: false,
        generalOpens: null,
        ageApproximate: false,
        watching: true,
        reminderState: 'active',
        sourceUrl: sourceUrls[Number(watchId.slice(-1))],
      }),
      runAgent: readThenAnswer(
        `These registrations open Nov 24, 2026 (America/Toronto). Sources: ${sourceUrls.join(' ')}. Opening times are unpublished.`,
        sourceUrls.map(
          (_url, index) => `44444444-4444-4444-8444-${String(index).padStart(12, '0')}`,
        ),
      ),
    });
    const { reply } = await channelCoachRuntime(p).respond(
      turn('When does registration open for these courses?'),
      [],
    );
    for (const sourceUrl of sourceUrls) {
      expect(reply.split(sourceUrl)).toHaveLength(2);
    }
    expect(reply).not.toContain('undefined');
    expect(reply).toContain('Opening times are unpublished.');
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

  it('returns a long answer in full without a segment cap', async () => {
    const long = Array.from({ length: 12 }, (_, i) => `Sentence number ${i} about swim.`).join(' ');
    const p = ports({ runAgent: answering(long) });

    const { reply } = await channelCoachRuntime(p).respond(turn(), []);

    expect(smsSegments(reply)).toBeGreaterThan(2);
    expect(reply).toBe(long);
    expect(reply).not.toContain(LINK);
    expect(reply.startsWith('Sentence number 0')).toBe(true);
  });

  it('keeps a long complete answer without spending a shorter-rewrite call', async () => {
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

  it('does not fail a turn solely because the answer is long', async () => {
    const long = `${'Please sit with him through a boring bedtime '.repeat(8)}tonight`;
    const p = ports({
      runAgent: answering(long),
      client: () =>
        ({
          messages: {
            create: async () => ({ content: [{ type: 'text', text: long }] }),
          },
        }) as never,
    });

    await expect(channelCoachRuntime(p).respond(turn(), [])).resolves.toMatchObject({
      reply: long,
    });
    expect(p.recorded).toEqual([expect.objectContaining({ status: 'completed' })]);
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
      'channel coach: agent truncated without a complete answer (1 re-ask)',
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
