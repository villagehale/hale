import type { AgentClient } from '@hale/agent';
import type { RegistrationSourceState } from '@hale/db';
import { schema } from '@hale/db';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FamilyTextRecipient } from '~/lib/channel/family-recipients';
import { FakeTransport } from '~/lib/channel/intake/transport';
import { NUDGE_OPT_OUT } from '~/lib/channel/nudge/shell';
import { threadProactiveMessage } from '~/lib/channel/thread';
import { encryptString } from '~/lib/crypto/string-cipher';
import type { FetchPage } from '~/lib/registration/fetch';
import { registrationReminderFixture } from '~/lib/testing/registration-reminder';
import { isStage, structuredReply } from '~/lib/testing/structured-reply';
import { resolveFamilyOpen } from '../match-registration-windows';
import { createRegistrationReader } from '../read';
import type { RegistrationReader } from '../read';
import { composeRegistrationReminder } from './compose';
import { decideRegistrationRefresh } from './refresh';
import {
  type LiveSequence,
  type SequenceRunDeps,
  defaultSequenceRunDeps,
  runRegistrationSequenceCron,
} from './run.js';
import { GO_LEAD_MINUTES } from './schedule.js';
import type { SequenceChild } from './shortlist.js';

/**
 * VIL-242 · M7 — the registration sequence sweep.
 *
 * The properties under test are the ones a re-fired cron, a moved municipal date or a
 * declined shortlist would break:
 *
 *   - a leg is idempotent per (family, window, leg) at the ledger, so a tick that runs
 *     twice inside one interval sends once;
 *   - the two urgent legs cross quiet hours and nothing else does;
 *   - a moved `open_at` re-anchors the whole ladder, because every leg is computed from
 *     the LIVE window row at send time rather than materialized;
 *   - dark by default: unarmed, the sweep does not even select a family.
 */

const TZ = 'America/Toronto';
/** Tuesday 15 Sept 2026, 06:30 Toronto. */
const OPEN_AT = new Date('2026-09-15T10:30:00.000Z');
/** 10:00 Toronto on 5 Sept — inside the family's shortlist slot, 10 days out. */
const PROPOSAL_TICK = new Date('2026-09-05T14:00:00.000Z');
/** 10:00 Toronto on 8 Sept — inside the heads-up interval. */
const HEADS_UP_TICK = new Date('2026-09-08T14:00:00.000Z');
/** 19:00 Toronto on 14 Sept — the battle-plan slot, inside quiet hours it is not. */
const BATTLE_PLAN_TICK = new Date('2026-09-14T23:00:00.000Z');
/** 06:20 Toronto on 15 Sept — inside quiet hours, inside the go interval. */
const GO_TICK = new Date('2026-09-15T10:20:00.000Z');

function win(overrides: Partial<RegistrationSourceState> = {}): RegistrationSourceState {
  return {
    id: 'w-1',
    municipality: 'richmond_hill',
    programDomain: 'rec_program',
    cycleLabel: 'Fall 2026',
    previewAt: null,
    residentOpenAt: null,
    openAt: OPEN_AT,
    residentPriorityDays: null,
    waitlistResponseHours: 36,
    ageMinMonths: 36,
    ageMaxMonths: 72,
    sourceUrl: 'https://www.richmondhill.ca/en/things-to-do/Community-Recreation-Guide.aspx',
    verifiedAt: new Date('2026-07-30T04:00:00.000Z'),
    notes: null,
    createdAt: PROPOSAL_TICK,
    updatedAt: PROPOSAL_TICK,
    ...overrides,
  } as RegistrationSourceState;
}

/** Maya, 4 years old on the proposal tick — squarely inside the 3-to-6 band. */
const CHILDREN: SequenceChild[] = [
  { id: 'child-1', name: 'Maya', dateOfBirth: '2022-05-01', dobPrecision: 'exact' },
];

function live(overrides: Partial<LiveSequence> = {}): LiveSequence {
  return {
    sequenceId: 'seq-1',
    familyId: 'fam-1',
    parentUserId: 'user-1',
    timeZone: TZ,
    areaCoarse: 'L4B',
    window: win(),
    optIn: 'opted_in',
    outcome: null,
    waitlistPosition: null,
    waitlistStartedAt: null,
    // VIL-338 — unbound is the default, and it is the state the thirteen non-portal
    // municipalities are in forever.
    courseUrl: null,
    courseOpensAt: null,
    readinessReady: null,
    ...overrides,
  };
}

interface Harness {
  deps: SequenceRunDeps;
  transport: FakeTransport;
  writes: Array<{ table: unknown; payload: Record<string, unknown> }>;
  dedupeKeys: Set<string>;
  /** MEM-10 · promises opened, and promises closed, in call order. */
  promised: Array<{ kind: string; summary: string; dueAt: Date; channelMessageId: string | null }>;
  kept: Array<{ kind: string; channelMessageId: string | null }>;
  /** Every leg that landed in the parent's own text thread (lib/channel/thread.ts). */
  threaded: Array<{ familyId: string; parentUserId: string; body: string }>;
}

function harness(
  options: {
    sequences?: LiveSequence[];
    children?: SequenceChild[];
    /** What the reconciliation gate says about the wire body (VIL-293). Empty is the
     * ordinary answer: a leg's claim is matched by the live sequence sending it. */
    unbacked?: Awaited<ReturnType<SequenceRunDeps['refuseUnbackedSend']>>;
    enrolled?: boolean;
    consented?: boolean;
    /** The family's textable parent seats. One primary parent unless a test says
     * otherwise (channel/family-recipients.ts is the prod reader). */
    recipients?: FamilyTextRecipient[];
    /** Per-parent watch consent, for the households where the two seats differ. */
    consentedFor?: (parentUserId: string) => boolean;
    /** Per-parent enrolment, same reason. */
    enrolledFor?: (parentUserId: string) => boolean;
    /** Per-parent numbers, so a two-parent household's sends are tellable apart. */
    phones?: Record<string, string>;
    transport?: FakeTransport;
    /** VIL-338 · the send-time course read. Absent means "this test's sequences are
     * unbound", and the default THROWS so a read nobody expected is a failure rather
     * than a quietly empty page. */
    fetchBody?: FetchPage;
  } = {},
): Harness {
  const writes: Harness['writes'] = [];
  const dedupeKeys = new Set<string>();
  const promised: Harness['promised'] = [];
  const kept: Harness['kept'] = [];
  const threaded: Harness['threaded'] = [];
  const transport = options.transport ?? new FakeTransport();
  const sequences = options.sequences ?? [];
  for (const sequence of sequences) {
    sequence.courseOpensAt ??= sequence.window
      ? resolveFamilyOpen(sequence.window, sequence.areaCoarse).opensForFamilyAt
      : null;
  }
  const courseRead = createRegistrationReader({
    fetchBody:
      options.fetchBody ??
      (async () => {
        throw new Error('unexpected course read');
      }),
    extract: async () => {
      throw new Error('unexpected extraction');
    },
  });
  // Synthetic published dates are independent fixtures; portal clocks use the real parser.
  const read: RegistrationReader = async (target, now) => {
    if (target.sourceUrl.includes('perfectmind.com')) return courseRead(target, now);
    const source = sequences.find(
      (sequence) => sequence.window?.sourceUrl === target.sourceUrl,
    )?.window;
    if (!source) throw new Error('missing published-source fixture');
    const date = (kind: 'resident_open' | 'general_open', at: Date) => {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: TZ,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }).formatToParts(at);
      const part = (name: string) => parts.find((value) => value.type === name)?.value;
      return {
        kind,
        date: `${part('year')}-${part('month')}-${part('day')}`,
        time:
          part('hour') === '00' && part('minute') === '00'
            ? null
            : `${part('hour')}:${part('minute')}`,
        evidence: ['synthetic published fixture'],
      };
    };
    return {
      sourceUrl: target.sourceUrl,
      checkedAt: now,
      timeZone: TZ,
      reader: 'ai',
      status: 'verified',
      dates: [
        ...(source.residentOpenAt ? [date('resident_open', source.residentOpenAt)] : []),
        date('general_open', source.openAt),
      ],
    };
  };

  const deps: SequenceRunDeps = {
    compose: registrationReminderFixture,
    live: {
      read,
      readForSend: read,
      claimDue: async () => [],
      refresh: async (_database, input) => {
        const sequence = sequences.find((row) => row.sequenceId === input.sequenceId);
        if (!sequence) return false;
        const decision = decideRegistrationRefresh(
          {
            anchor: sequence.courseOpensAt,
            pending: sequence.pendingChange ?? null,
            pausedAt: sequence.pausedAt ?? null,
            reviewApproved: false,
          },
          input.reading,
          input.resident,
          input.now,
        );
        sequence.courseOpensAt = decision.anchor;
        sequence.pausedAt = decision.paused ? input.now : null;
        sequence.pendingChange = decision.pending;
        return true;
      },
      reload: async (_database, id) => sequences.find((row) => row.sequenceId === id) ?? null,
      claimSend: async () => 1,
      releaseSend: async () => {},
      draftReview: async () => {},
      acknowledgeChange: async (_database, sequence) => {
        if (sequence.pendingChange) sequence.pendingChange.notified = true;
      },
    },
    refuseUnbackedSend: async () => options.unbacked ?? [],
    loadChildren: async () => options.children ?? CHILDREN,
    loadLiveSequences: async () => options.sequences ?? [],
    /** SEAM: prod reads family_members ⋈ users ⋈ parent_channels
     * (channel/family-recipients.ts). The default is the ONE parent the fixture's own
     * row names, per family — a constant here would text one household's parent about
     * another's window the moment a case has two families. */
    loadRecipients: async (_db, familyId) =>
      options.recipients ?? [
        {
          parentUserId:
            (options.sequences ?? []).find((sequence) => sequence.familyId === familyId)
              ?.parentUserId ?? 'user-1',
          timeZone: TZ,
          role: 'primary_parent',
        },
      ],
    buildGate: () => ({
      channelEnrolled: async (parentUserId) =>
        options.enrolledFor?.(parentUserId) ?? options.enrolled ?? true,
      watchConsentGranted: async (parentUserId) =>
        options.consentedFor?.(parentUserId) ?? options.consented ?? true,
      countProactiveSends: async () => 0,
      proactiveSentSince: async () => false,
      parentTimeZone: async (parentUserId) =>
        (options.recipients ?? []).find((r) => r.parentUserId === parentUserId)?.timeZone ?? TZ,
    }),
    dedupeActive: async (_db, key) => dedupeKeys.has(key),
    resolveSendablePhone: async (_db, parentUserId) =>
      options.phones?.[parentUserId] ?? '+14165550100',
    recordSend: async (_db, write) => {
      writes.push({
        table: schema.channelMessages,
        payload: write as unknown as Record<string, unknown>,
      });
      dedupeKeys.add(write.dedupeKey);
      return `msg-${writes.length}`;
    },
    audit: async (_db, row) => {
      writes.push({ table: schema.auditLog, payload: row as unknown as Record<string, unknown> });
    },
    transport,
    // MEM-10 · the ledger seam. Recorded rather than executed: the writer's own contract
    // is unit-tested in lib/commitments/ledger.test.ts, and what this ladder owes is
    // that the promise is opened by the leg that SAYS it and closed by the leg that
    // KEEPS it — with the message id each time.
    recordCommitment: async (_db, input) => {
      promised.push({
        kind: input.kind,
        summary: input.summary,
        dueAt: input.dueAt,
        channelMessageId: input.channelMessageId,
      });
      return { status: 'recorded', commitmentId: `commitment-${promised.length}` };
    },
    fulfillCommitment: async (_db, input) => {
      kept.push({ kind: input.kind, channelMessageId: input.channelMessageId });
      return { status: 'closed', commitmentIds: ['commitment-1'] };
    },
    threadMessage: async (_db, input) => {
      threaded.push(input);
      return 'conv-1';
    },
    fetchBody:
      options.fetchBody ??
      (async (url) => {
        throw new Error(`unexpected course read: ${url}`);
      }),
  };

  return {
    deps,
    transport,
    writes,
    dedupeKeys,
    promised,
    kept,
    threaded,
  };
}

function db() {
  return {} as never;
}

function auditActions(writes: Harness['writes']): string[] {
  return writes
    .filter((w) => w.table === schema.auditLog)
    .map((w) => String(w.payload.actionTaken));
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the D21 dark-launch flag', () => {
  it('does nothing at all when neither the flag nor the allowlist is armed', async () => {
    const h = harness({ sequences: [live()] });
    const result = await runRegistrationSequenceCron(db(), h.deps, PROPOSAL_TICK);
    expect(result.enabled).toBe(false);
    expect(result.proposed).toBe(0);
    expect(h.transport.sent).toHaveLength(0);
  });

  it('reads F14_ENABLED strictly, so a stored trailing newline stays OFF', async () => {
    // `vercel env add` from a piped echo stores 'true\n'.
    vi.stubEnv('F14_ENABLED', 'true\n');
    const h = harness({ sequences: [live()] });
    expect((await runRegistrationSequenceCron(db(), h.deps, PROPOSAL_TICK)).enabled).toBe(false);
  });

  it('runs for an allowlisted family while the flag is off', async () => {
    vi.stubEnv('F14_FAMILY_ALLOWLIST', 'fam-1');
    const h = harness({ sequences: [live()] });
    const result = await runRegistrationSequenceCron(db(), h.deps, PROPOSAL_TICK);
    expect(result.enabled).toBe(true);
    expect(result.proposed).toBe(0);
  });
});

describe('the legs', () => {
  it('sends the actual structured writer output after its live read, without a template', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    const h = harness({ sequences: [live()] });
    const create = vi.fn(async (request: { messages: { content: string }[] }) => {
      if (isStage(request, 'registration_message_dates', 'openings')) {
        return structuredReply(request, 'registration_message_dates', {
          openings: [
            {
              date: '2026-09-15',
              time: '06:30',
              timeZone: 'America/Toronto',
              weekday: null,
              confidence: 'high',
              evidence: {
                date: '2026-09-15',
                time: '06:30',
                timeZone: 'America/Toronto',
                weekday: null,
              },
            },
          ],
        });
      }
      const context = JSON.parse(request.messages[0]!.content);
      expect(context.opening).toEqual({
        date: '2026-09-15',
        time: '06:30',
        timeZone: 'America/Toronto',
        timePublished: true,
      });
      return structuredReply(request, 'registration_reminder', {
        message:
          "Freshly checked: 2026-09-15 at 06:30 America/Toronto. I'll send your evening-before plan.",
      });
    });
    const client = { messages: { create } } as unknown as AgentClient;
    h.deps.compose = (input) => composeRegistrationReminder(input, client);
    const result = await runRegistrationSequenceCron(db(), h.deps, HEADS_UP_TICK);
    expect(result.sent).toBe(1);
    expect(create).toHaveBeenCalledTimes(2);
    expect(h.transport.bodies()[0]).toBe(
      `Freshly checked: 2026-09-15 at 06:30 America/Toronto. I'll send your evening-before plan.\n${win().sourceUrl}`,
    );
  });
  it('defers a failed writer without a send, ledger write or deterministic fallback', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    const h = harness({ sequences: [live()] });
    h.deps.compose = async () => null;
    const result = await runRegistrationSequenceCron(db(), h.deps, HEADS_UP_TICK);
    expect(result.sent).toBe(0);
    expect(result.failed).toBe(1);
    expect(h.transport.bodies()).toEqual([]);
    expect(h.writes).toEqual([]);
    expect(h.promised).toEqual([]);
  });

  it('rechecks withdrawal after AI writing, before transport', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    const sequence = live();
    const h = harness({ sequences: [sequence] });
    h.deps.compose = async () => {
      sequence.optIn = 'declined';
      return 'Generated reminder';
    };
    const result = await runRegistrationSequenceCron(db(), h.deps, HEADS_UP_TICK);
    expect(result.sent).toBe(0);
    expect(h.transport.bodies()).toEqual([]);
  });
  it('sends the heads-up without an opt-out line', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    const h = harness({ sequences: [live({ optIn: 'pending' })] });
    const result = await runRegistrationSequenceCron(db(), h.deps, HEADS_UP_TICK);

    expect(result.sent).toBe(1);
    const body = h.transport.bodies()[0] as string;
    expect(body).toContain('2026-09-15 at 06:30 America/Toronto');
    expect(body).toContain(win().sourceUrl);
    expect(body).not.toContain(NUDGE_OPT_OUT);
    expect(body).not.toContain('STOP to opt out.');
  });

  it("puts the leg in the parent's own text thread, so their reply has an antecedent", async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    // The whole ladder is a conversation: the heads-up asks for a YES, the battle plan
    // is answered the morning of. `channel_messages` stores no body (rule #1), so a leg
    // that skips this is a question the coach can never see the parent answering.
    const h = harness({ sequences: [live({ optIn: 'pending' })] });
    await runRegistrationSequenceCron(db(), h.deps, HEADS_UP_TICK);

    expect(h.threaded).toHaveLength(1);
    expect(h.threaded[0]).toMatchObject({ familyId: 'fam-1', parentUserId: 'user-1' });
    expect(h.threaded[0]?.body).toContain(win().sourceUrl);
    expect(h.transport.bodies()[0]).toContain(h.threaded[0]?.body ?? ' ');
  });

  it('threads the composed leg, and the wire does not add an opt-out line', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    const h = harness({ sequences: [live({ optIn: 'pending' })] });
    await runRegistrationSequenceCron(db(), h.deps, HEADS_UP_TICK);

    const wire = h.transport.bodies()[0] ?? '';
    expect(wire).not.toContain(NUDGE_OPT_OUT);
    expect(h.threaded[0]?.body).not.toContain(NUDGE_OPT_OUT);
    expect(wire).toContain(h.threaded[0]?.body ?? ' ');
  });

  it('threads nothing when the leg never reached a transport', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    // The positive control for the two above: a held leg is not something Hale said.
    const h = harness({ sequences: [live({ optIn: 'pending' })], enrolled: false });
    await runRegistrationSequenceCron(db(), h.deps, HEADS_UP_TICK);

    expect(h.transport.sent).toHaveLength(0);
    expect(h.threaded).toEqual([]);
  });

  it('writes the ledger row under its own category and its audit row (rule #6)', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    const h = harness({ sequences: [live()] });
    await runRegistrationSequenceCron(db(), h.deps, HEADS_UP_TICK);

    const ledger = h.writes.filter((w) => w.table === schema.channelMessages);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.payload).toMatchObject({
      familyId: 'fam-1',
      parentUserId: 'user-1',
      channel: 'sms',
      category: 'registration_sequence',
      templateKey: 'registration_sequence:heads_up',
      status: 'queued',
    });
    // Never the rendered body (rule #1).
    expect(ledger[0]?.payload.body).toBeUndefined();
    expect(auditActions(h.writes)).toContain('registration_sequence_leg_sent');
  });

  it('is idempotent per (family, window, leg) under a double cron fire', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    const h = harness({ sequences: [live()] });
    await runRegistrationSequenceCron(db(), h.deps, HEADS_UP_TICK);
    // The same interval, five minutes later: the ladder is still due, the ledger says
    // it already went.
    const second = await runRegistrationSequenceCron(
      db(),
      h.deps,
      new Date(HEADS_UP_TICK.getTime() + 5 * 60_000),
    );
    expect(second).toMatchObject({ sent: 0, deduped: 1 });
    expect(h.transport.sent).toHaveLength(1);
    expect([...h.dedupeKeys]).toEqual(['registration_sequence:fam-1:w-1:heads_up:user-1']);
  });

  /**
   * MEM-10 · the ladder is the one surface whose copy contains an explicit, dated
   * promise, and these three cases are the whole contract: it is opened by the sentence
   * that makes it, never by the one that merely invites, and closed by the message that
   * delivers.
   */
  it('opens the plan promise when the heads-up actually promises one', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    const h = harness({ sequences: [live({ optIn: 'opted_in' })] });

    await runRegistrationSequenceCron(db(), h.deps, HEADS_UP_TICK);

    // Due where "the evening before" stops being possible: the go leg's start, derived
    // from the window's open and GO_LEAD_MINUTES rather than from what the code emitted.
    expect(h.promised).toEqual([
      {
        kind: 'registration_plan',
        summary: 'Richmond Hill Fall 2026 recreation programs: your plan, the evening before.',
        dueAt: new Date(OPEN_AT.getTime() - GO_LEAD_MINUTES * 60_000),
        channelMessageId: 'msg-1',
      },
    ]);
    // The body the family read is the sentence the row is holding Hale to.
    expect(h.transport.bodies()[0]).toContain("I'll send a reminder the evening before.");
  });

  it('promises nothing to a household it is still asking to approve', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    const h = harness({ sequences: [live({ optIn: 'pending' })] });

    await runRegistrationSequenceCron(db(), h.deps, HEADS_UP_TICK);

    // The same leg, a different sentence: this one invites an approval, in the thread.
    // Recording a debt against it would report a broken promise Hale never made.
    expect(h.transport.bodies()[0]).toContain('Confirm the reminder plan in your approvals');
    expect(h.promised).toEqual([]);
  });

  it('closes the plan promise with the battle plan that kept it', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    const h = harness({ sequences: [live()] });

    await runRegistrationSequenceCron(db(), h.deps, BATTLE_PLAN_TICK);

    expect(h.kept).toEqual([{ kind: 'registration_plan', channelMessageId: 'msg-1' }]);
    expect(h.promised).toEqual([]);
  });

  it("closes the coach's registration WATCH with the go leg that kept it (VIL-293)", async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    const h = harness({ sequences: [live()] });

    await runRegistrationSequenceCron(db(), h.deps, GO_TICK);

    // The go leg is the text fifteen minutes before the doors open — the thing the coach
    // actually promised. Not the heads-up, not the battle plan.
    expect(h.kept).toEqual([{ kind: 'registration_watch', channelMessageId: 'msg-1' }]);
  });

  it('refuses a leg whose wire body claims a row that does not exist (VIL-293)', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    const h = harness({ sequences: [live()], unbacked: ['no_registration_watch'] });

    const result = await runRegistrationSequenceCron(db(), h.deps, GO_TICK);

    expect(result).toMatchObject({ sent: 0, refused: 1, failed: 0 });
    expect(h.transport.sent).toEqual([]);
    expect(h.kept).toEqual([]);
  });

  it('withholds the battle plan from a family that has not approved the shortlist', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    const h = harness({ sequences: [live({ optIn: 'pending' })] });
    const result = await runRegistrationSequenceCron(db(), h.deps, BATTLE_PLAN_TICK);
    expect(result.sent).toBe(0);
    expect(h.transport.sent).toHaveLength(0);
  });

  it('says nothing at all to a family that declined the shortlist', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    for (const tick of [HEADS_UP_TICK, BATTLE_PLAN_TICK, GO_TICK]) {
      const h = harness({ sequences: [live({ optIn: 'declined' })] });
      await runRegistrationSequenceCron(db(), h.deps, tick);
      expect(h.transport.sent).toHaveLength(0);
    }
  });

  it('crosses quiet hours for the go leg, which is worthless late', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    // 06:20 Toronto is inside the 21:00-08:00 proactive quiet window.
    const h = harness({ sequences: [live()] });
    const result = await runRegistrationSequenceCron(db(), h.deps, GO_TICK);
    expect(result.sent).toBe(1);
    expect(h.transport.bodies()[0]).toContain(
      'https://www.richmondhill.ca/en/things-to-do/Community-Recreation-Guide.aspx',
    );
  });

  it('holds a non-urgent leg inside quiet hours and sends it on the next tick after', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    // 21:30 Toronto on 8 Sept: past the heads-up slot so the leg IS due, and inside
    // quiet hours so it is held. The interval is days wide, so the hold is a deferral
    // rather than a lost message — which is the whole reason legs are intervals.
    const h = harness({ sequences: [live()] });
    const held = await runRegistrationSequenceCron(
      db(),
      h.deps,
      new Date('2026-09-09T01:30:00.000Z'),
    );
    expect(held.held.quiet_hours).toBe(1);
    expect(h.transport.sent).toHaveLength(0);

    const later = await runRegistrationSequenceCron(
      db(),
      h.deps,
      new Date('2026-09-09T14:00:00.000Z'),
    );
    expect(later.sent).toBe(1);
  });

  it('sends nothing to a family that pressed STOP', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    const h = harness({ sequences: [live()], enrolled: false });
    const result = await runRegistrationSequenceCron(db(), h.deps, HEADS_UP_TICK);
    expect(result.held.not_enrolled).toBe(1);
    expect(h.transport.sent).toHaveLength(0);
  });

  it('re-anchors the whole ladder when a municipality MOVES the date', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    // The window that was due to open on 15 Sept now opens on 22 Sept. Nothing is
    // materialized, so the ladder simply recomputes: what was the heads-up tick is
    // now a week too early and nothing is due.
    const moved = live({ window: win({ openAt: new Date('2026-09-22T10:30:00.000Z') }) });
    const h = harness({ sequences: [moved] });
    const result = await runRegistrationSequenceCron(db(), h.deps, HEADS_UP_TICK);
    expect(result.sent).toBe(0);

    const onTime = await runRegistrationSequenceCron(
      db(),
      h.deps,
      new Date('2026-09-15T14:00:00.000Z'),
    );
    expect(onTime.sent).toBe(1);
  });

  it('anchors the whole ladder on the RESIDENT date for a resident family', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    // Richmond Hill opens to residents a week early. L4B resolves to Richmond Hill
    // alone, so this family registers on the 8th — anchoring the ladder on the general
    // date would send them the go leg a week after they could have registered.
    const resident = live({
      areaCoarse: 'L4B',
      window: win({
        residentOpenAt: new Date('2026-09-08T10:30:00.000Z'),
        residentPriorityDays: 7,
      }),
    });
    const h = harness({ sequences: [resident] });

    // 06:20 Toronto on the 8th: the go leg for the RESIDENT date.
    const result = await runRegistrationSequenceCron(
      db(),
      h.deps,
      new Date('2026-09-08T10:20:00.000Z'),
    );
    expect(result.sent).toBe(1);
    expect([...h.dedupeKeys]).toEqual(['registration_sequence:fam-1:w-1:go:user-1']);
  });

  it('anchors on the general date for a family whose FSA is not that town', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    // L3P is Markham, not Richmond Hill: no head start, so nothing is due on the 8th.
    const nonResident = live({
      areaCoarse: 'L3P',
      window: win({
        residentOpenAt: new Date('2026-09-08T10:30:00.000Z'),
        residentPriorityDays: 7,
      }),
    });
    const h = harness({ sequences: [nonResident] });
    const result = await runRegistrationSequenceCron(
      db(),
      h.deps,
      new Date('2026-09-08T10:20:00.000Z'),
    );
    expect(result.sent).toBe(0);
  });

  it('asks the check-in question four hours after the open', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    const h = harness({ sequences: [live()] });
    await runRegistrationSequenceCron(db(), h.deps, new Date('2026-09-15T14:30:00.000Z'));
    expect(h.transport.bodies()[0]).toContain('How did');
  });

  it('runs the waitlist guards off the parent’s reported clock', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    const waitlisted = live({
      outcome: 'waitlisted',
      waitlistPosition: 15,
      waitlistStartedAt: new Date('2026-09-15T15:00:00.000Z'),
    });
    const h = harness({ sequences: [waitlisted] });
    // Half of Richmond Hill's 36h from 11:00 on the 15th is 05:00 on the 16th — inside
    // quiet hours, so it defers; 10:00 local is the first tick that may send.
    const result = await runRegistrationSequenceCron(
      db(),
      h.deps,
      new Date('2026-09-16T14:00:00.000Z'),
    );
    expect(result.sent).toBe(1);
    expect(h.transport.bodies()[0]).toContain('36h');
    expect([...h.dedupeKeys]).toEqual(['registration_sequence:fam-1:w-1:waitlist_half:user-1']);
  });

  it('is quiet on a tick where no leg is due — the common case', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    const h = harness({ sequences: [live()] });
    const result = await runRegistrationSequenceCron(
      db(),
      h.deps,
      new Date('2026-09-01T14:00:00.000Z'),
    );
    expect(result).toMatchObject({ sent: 0, quiet: 1 });
    expect(h.writes).toEqual([]);
  });

  it('wires the shared outbound transport into the default deps (VIL-260)', async () => {
    // VIL-262 made the dep non-nullable, so "a transport is wired" is now a type-level
    // fact. What is still worth asserting is WHICH one: the REAL outbound leg, which
    // refuses by naming its missing credentials rather than silently reporting a leg
    // nobody sent.
    const { transport, threadMessage } = defaultSequenceRunDeps();
    // And WHICH threader: a port declared but wired to a stub is the same silent
    // no-op the non-nullable type was meant to make unexpressible.
    expect(threadMessage).toBe(threadProactiveMessage);
    vi.stubEnv('LINQ_API_KEY', '');
    vi.stubEnv('LINQ_FROM_E164', '');
    await expect(
      transport.send({ to: '+14165550100', body: 'never leaves: no credentials' }),
    ).rejects.toThrow(/not_configured/);
  });

  it('writes the ledger row and the audit row for the leg it sent', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    const h = harness({ sequences: [live()] });
    const result = await runRegistrationSequenceCron(db(), h.deps, HEADS_UP_TICK);

    expect(result.sent).toBe(1);
    expect(h.transport.sent).toHaveLength(1);
    const ledger = h.writes.filter((w) => w.table === schema.channelMessages);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.payload).toMatchObject({
      channel: 'sms',
      category: 'registration_sequence',
      status: 'queued',
      templateKey: 'registration_sequence:heads_up',
      dedupeKey: 'registration_sequence:fam-1:w-1:heads_up:user-1',
    });
    expect(
      h.writes.filter((w) => w.table === schema.auditLog).map((w) => String(w.payload.actionTaken)),
    ).toContain('registration_sequence_leg_sent');
  });

  it('lets one family’s bad data fail without silencing the next family', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    const h = harness({
      sequences: [live(), live({ sequenceId: 'seq-2', familyId: 'fam-2', parentUserId: 'user-2' })],
    });
    const boom: SequenceRunDeps = {
      ...h.deps,
      resolveSendablePhone: async (_db, parentUserId) => {
        if (parentUserId === 'user-1') throw new Error('bad row');
        return '+14165550101';
      },
    };
    const result = await runRegistrationSequenceCron(db(), boom, HEADS_UP_TICK);
    expect(result.failed).toBe(1);
    expect(result.sent).toBe(1);
  });
});

/**
 * VIL-262 — the reader this sweep sends through carries the whole predicate.
 *
 * There were two readers that resolved a parent's number, and the weaker one (no
 * `verified_at IS NOT NULL`) was the one this sweep used. Nothing went wrong only
 * because the gate's enrolment check happened to run BEFORE it — correctness that
 * lives in the call order is correctness one refactor away from being gone.
 *
 * So these cases delete the ordering protection on purpose: the gate is told the
 * parent is enrolled and consenting, which is the state a stale or reordered check
 * would produce, and the reader must still refuse. This class is the one with the
 * quiet-hours exemption, so a leg reaching a revoked number would arrive at 6am.
 */
describe('runRegistrationSequenceCron — the send-side reader (VIL-262)', () => {
  const KEY = Buffer.alloc(32, 7).toString('base64');

  /** Just enough of a Drizzle handle for the reader's one indexed read — and it hands
   * the row back REGARDLESS of the predicate, so what refuses below is the reader's
   * own check on the columns, not a WHERE clause a fake cannot execute. */
  function channelDb(row: Record<string, unknown>) {
    return {
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [row] }) }) }),
    } as never;
  }

  it.each([
    ['unverified', { verifiedAt: null, revokedAt: null }],
    ['revoked — the parent texted STOP', { verifiedAt: HEADS_UP_TICK, revokedAt: HEADS_UP_TICK }],
  ])('texts nothing to a %s channel, with the gate saying enrolled', async (_label, state) => {
    vi.stubEnv('F14_ENABLED', 'true');
    vi.stubEnv('APP_ENCRYPTION_KEY', KEY);
    const h = harness({ sequences: [live()], enrolled: true, consented: true });
    const { resolveSendablePhone } = defaultSequenceRunDeps();

    const result = await runRegistrationSequenceCron(
      channelDb({ phoneE164Encrypted: encryptString('+14165550100'), ...state }),
      { ...h.deps, resolveSendablePhone },
      HEADS_UP_TICK,
    );

    expect(h.transport.sent).toEqual([]);
    expect(result.sent).toBe(0);
    // Loudly, not quietly: no number for a parent the gate cleared is a contradiction,
    // and a swept-under skip would read as a sequence with no leg due.
    expect(result.failed).toBe(1);
  });
});

/**
 * VIL-338 · the bound course — the half of the ladder that reads a page at send time.
 *
 * Everything below turns on one decision: for a household that pasted a course link,
 * the COURSE PAGE is the system of record and the M1 window row is a hand-read of a
 * seasonal info page. So the ladder anchors on `course_opens_at`, re-reads the page at
 * the two legs that speak about the course, and every failure of that read has its own
 * true sentence rather than a suppression. The thirteen municipalities with no readable
 * portal must come out of all of it byte-identical, which is what makes the ticket safe
 * to merge dark.
 */
const MARKHAM_COURSE =
  'https://cityofmarkham.perfectmind.com/Clients/BookMe4LandingPages/CoursesLandingPage?widgetId=bfd08479-60d6-43d9-b586-5b4c8305a003&courseId=961140fe-0866-460f-9973-7c42cbe0a928';
const MARKHAM_COURSE_ID = '961140fe-0866-460f-9973-7c42cbe0a928';
/** The sign-in-and-return link Hale rebuilds from the stored URL — what the go leg taps. */
const MARKHAM_SIGN_IN = `https://cityofmarkham.perfectmind.com/Clients/MemberRegistration/MemberSignIn?returnUrl=${encodeURIComponent(MARKHAM_COURSE)}`;

/** A PerfectMind course page's real shape: the record lives in a `var eventInfo` object
 * literal inside a <script> block, which is why the ladder reads BYTES and not text. */
function coursePage(overrides: Record<string, unknown> = {}): string {
  const model = {
    EventId: MARKHAM_COURSE_ID,
    IsFull: false,
    SpotsLeft: 6,
    MaximumCapacity: 12,
    IsRegistrationClosed: false,
    IsFutureRegistration: true,
    OnlineRegistration: true,
    CanNotBook: true,
    IsWaitListAvailable: false,
    WaitListSpotsLeft: 0,
    EventName: 'LEGO Builders',
    CourseId: '344301',
    StartDay: 'Sat',
    StartTime: '9:00 AM',
    StartDateValue: '2026-09-26T09:00',
    // 06:30 Toronto on 15 Sept — the same instant as OPEN_AT, so a page that agrees
    // with the anchor is the DEFAULT and every drift below is a named override.
    PublicRegistrationStartDateValue: '2026-09-15T06:30',
    ...overrides,
  };
  return `<html><body><script>\r\n  var eventInfo = $.extend(true, {}, {\r\n    BackAction: { Url: '/Clients/BookMe4' }\r\n  }, ${JSON.stringify(model)});\r\n</script></body></html>`;
}

/** Markham's window — the one municipality in these tests with a readable portal. */
function markhamWindow(overrides: Partial<RegistrationSourceState> = {}): RegistrationSourceState {
  return win({ municipality: 'markham', ...overrides });
}

/** A live sequence with a course bound: the URL and the page's own clock, which is
 * what the CHECK constraint makes inseparable. */
function bound(overrides: Partial<LiveSequence> = {}): LiveSequence {
  return live({
    areaCoarse: 'L3R',
    window: markhamWindow(),
    courseUrl: MARKHAM_COURSE,
    courseOpensAt: OPEN_AT,
    ...overrides,
  });
}

function auditAfter(writes: Harness['writes'], actionTaken: string): Record<string, unknown> {
  const row = writes.find(
    (w) => w.table === schema.auditLog && w.payload.actionTaken === actionTaken,
  );
  if (!row) throw new Error(`no ${actionTaken} audit row`);
  return row.payload.after as Record<string, unknown>;
}

describe('VIL-338 · the bound course is read at send time', () => {
  it('composes the go leg from THIS tick and carries the portal’s own sign-in link', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    const pages: string[] = [];
    const h = harness({
      sequences: [bound({ readinessReady: true })],
      fetchBody: async (url) => {
        pages.push(url);
        return coursePage();
      },
    });

    const result = await runRegistrationSequenceCron(db(), h.deps, GO_TICK);

    expect(result).toMatchObject({ sent: 1, read: 1, readSkipped: 0 });
    expect(result.prep.prepared).toBe(1);
    // The page it read is the stored sanitized URL and nothing else went to the network.
    expect(pages).toEqual([MARKHAM_COURSE, MARKHAM_COURSE]);
    const body = h.transport.bodies()[0] as string;
    expect(body).toContain(MARKHAM_SIGN_IN);
    expect(body).toContain('You told me the setup is done.');
    // The flagship text is still what closes the coach's own watch promise.
    expect(h.kept).toEqual([{ kind: 'registration_watch', channelMessageId: 'msg-1' }]);
    // The provenance the founder reads the morning back from — never the body (rule #1).
    expect(auditAfter(h.writes, 'registration_sequence_leg_sent')).toMatchObject({
      leg: 'go',
      prep: 'prepared',
      driftMinutes: 0,
    });
  });

  it('reads nothing for a portal household with no course bound, and says today’s sentence', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    const h = harness({
      sequences: [live({ areaCoarse: 'L3R', window: markhamWindow() })],
      fetchBody: async () => {
        throw new Error('a household with no bound course must never be read for');
      },
    });

    const result = await runRegistrationSequenceCron(db(), h.deps, GO_TICK);

    expect(result).toMatchObject({ sent: 1, read: 0, failed: 0 });
    const body = h.transport.bodies()[0] as string;
    expect(body).toContain(win().sourceUrl);
    expect(body).not.toContain('MemberSignIn');
    // The one thing a portal household has that the other thirteen do not.
    expect(body).toContain('You have not told me the setup is done');
    // And the trail says WHICH kind of morning this was. A Markham household with
    // nothing bound is a household that could paste a link tomorrow; a Richmond Hill one
    // never can, and a founder reading the two rows has to be able to tell them apart.
    // Kills omitting `prep` on the leg that had a portal and no course to read.
    expect(result.prep.unbound).toBe(1);
    expect(auditAfter(h.writes, 'registration_sequence_leg_sent')).toMatchObject({
      leg: 'go',
      prep: 'unbound',
    });

    // The positive control the assertion above needs: the thirteen towns with no
    // readable portal write the row they always wrote. Kills stamping every unbound leg
    // `unbound`, which would say a town with no portal at all was one paste away from one.
    const town = harness({ sequences: [live()] });
    await runRegistrationSequenceCron(db(), town.deps, GO_TICK);
    expect(auditAfter(town.writes, 'registration_sequence_leg_sent')).not.toHaveProperty('prep');
  });

  it('also uses verified dates and source links for nonportal municipalities', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    for (const tick of [HEADS_UP_TICK, BATTLE_PLAN_TICK, GO_TICK]) {
      const h = harness({ sequences: [live()] });
      expect((await runRegistrationSequenceCron(db(), h.deps, tick)).sent).toBe(1);
      expect(h.threaded[0]?.body).toContain('2026-09-15 at 06:30 America/Toronto');
      expect(h.threaded[0]?.body).toContain(win().sourceUrl);
    }
  });

  it('anchors the whole ladder on the page’s clock, not the M1 row’s', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    // The Thornhill shape: the M1 row carries Markham's RESIDENT morning and this
    // household opens on the public one, a day later. Anchoring on the row would fire
    // the flagship text twenty-four hours early, on a morning nobody can register on.
    const nextDay = new Date(OPEN_AT.getTime() + 86_400_000);
    const sequence = bound({ courseOpensAt: nextDay });

    const early = harness({ sequences: [sequence], fetchBody: async () => coursePage() });
    const earlyResult = await runRegistrationSequenceCron(db(), early.deps, GO_TICK);
    // The M1 row's own morning is not this ladder's any more: at 06:20 on the 15th this
    // household is still a day from the bound open, so nothing is read, nothing is sent
    // and the go key is untouched. Anchor on the row instead and the flagship text goes
    // out twenty-four hours early, on a morning nobody can register on.
    expect(earlyResult).toMatchObject({ sent: 0, read: 0 });
    expect([...early.dedupeKeys]).toEqual([]);

    const onTime = harness({
      sequences: [sequence],
      fetchBody: async () => coursePage({ PublicRegistrationStartDateValue: '2026-09-16T06:30' }),
    });
    const result = await runRegistrationSequenceCron(
      db(),
      onTime.deps,
      new Date(GO_TICK.getTime() + 86_400_000),
    );
    expect(result.sent).toBe(1);
    expect(onTime.transport.bodies()[0]).toContain(MARKHAM_SIGN_IN);
  });

  it('holds a later page clock for fresh approval instead of sending the old plan', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    const sequence = bound();
    const h = harness({
      sequences: [sequence],
      fetchBody: async () => coursePage({ PublicRegistrationStartDateValue: '2026-09-15T07:30' }),
    });
    expect((await runRegistrationSequenceCron(db(), h.deps, BATTLE_PLAN_TICK)).sent).toBe(0);
    expect(sequence.pausedAt).toEqual(BATTLE_PLAN_TICK);
    expect(sequence.pendingChange?.kind).toBe('later');
    expect(sequence.courseOpensAt).toEqual(OPEN_AT);
    const notice = await runRegistrationSequenceCron(db(), h.deps, BATTLE_PLAN_TICK);
    expect(notice.sent).toBe(1);
    expect(h.transport.bodies()[0]).toContain(MARKHAM_COURSE);
    expect(h.transport.bodies()[0]).toContain('07:30');
    expect(h.kept).toEqual([]);
  });

  it('reanchors an earlier clock and notifies rather than sending the obsolete go leg', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    const sequence = bound();
    const h = harness({
      sequences: [sequence],
      fetchBody: async () => coursePage({ PublicRegistrationStartDateValue: '2026-09-15T05:30' }),
    });
    expect((await runRegistrationSequenceCron(db(), h.deps, GO_TICK)).sent).toBe(0);
    expect(sequence.courseOpensAt).toEqual(new Date('2026-09-15T09:30:00Z'));
    expect(sequence.pendingChange?.kind).toBe('earlier');
    expect(sequence.pausedAt).toBeNull();
    await runRegistrationSequenceCron(db(), h.deps, HEADS_UP_TICK);
    expect(h.transport.bodies()[0]).toContain(MARKHAM_COURSE);
    expect(h.transport.bodies()[0]).toContain('05:30');
    expect(h.kept).toEqual([]);
  });

  it.each([GO_TICK, BATTLE_PLAN_TICK])(
    'pauses an unreadable date and sends a link-only notice at %s',
    async (tick) => {
      vi.stubEnv('F14_ENABLED', 'true');
      const sequence = bound();
      const h = harness({
        sequences: [sequence],
        fetchBody: async () => {
          throw new Error('HTTP 503');
        },
      });
      expect((await runRegistrationSequenceCron(db(), h.deps, tick)).sent).toBe(0);
      expect(sequence.pendingChange?.kind).toBe('unavailable');
      expect(sequence.pausedAt).toEqual(tick);
      const noticeTick = new Date('2026-09-15T14:00:00Z');
      expect((await runRegistrationSequenceCron(db(), h.deps, noticeTick)).sent).toBe(1);
      expect(h.transport.bodies()[0]).toContain(MARKHAM_COURSE);
      expect(h.transport.bodies()[0]).toContain("couldn't verify");
      expect(h.transport.bodies()[0]).not.toContain('06:30');
      expect(h.kept).toEqual([]);
    },
  );

  it.each([
    ['prepared', { IsRegistrationClosed: true }, 'portal opens 6:30 a.m.'],
    [
      'age_ineligible',
      { MinAge: 9, MaxAge: 12, AgeRestrictions: '9 to 12 y 11m' },
      '9 to 12 y 11m',
    ],
  ])('preserves the %s course verdict with a verified clock', async (fate, changes, sentence) => {
    vi.stubEnv('F14_ENABLED', 'true');
    const h = harness({ sequences: [bound()], fetchBody: async () => coursePage(changes) });
    const result = await runRegistrationSequenceCron(db(), h.deps, GO_TICK);
    expect(result).toMatchObject({ sent: 1, failed: 0 });
    expect(result.prep[fate as keyof typeof result.prep]).toBe(1);
    expect(h.transport.bodies()[0]).toContain(sentence);
  });

  it('shares date and preparation reads across households on the same course', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    let gets = 0;
    const h = harness({
      sequences: [
        bound(),
        bound({ sequenceId: 'seq-2', familyId: 'fam-2', parentUserId: 'user-2' }),
      ],
      fetchBody: async () => {
        gets += 1;
        return coursePage();
      },
    });
    vi.stubEnv('F14_FAMILY_ALLOWLIST', 'fam-1,fam-2');

    const result = await runRegistrationSequenceCron(db(), h.deps, GO_TICK);

    expect(result).toMatchObject({ sent: 2, read: 1 });
    expect(gets).toBe(2);
  });

  it('spends its wall budget once and says so, while every family is still texted', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    // The bound leg's read is bounded by WALL TIME, not by a count: phase B is serial
    // and the go interval is fifteen minutes wide. Past the budget the leg still sends —
    // with the page_unreadable sentence and the deep link, which is strictly better than
    // a family that hears nothing because five other families' pages were slow.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(GO_TICK);
      const sequences = Array.from({ length: 3 }, (_unused, index) =>
        bound({
          sequenceId: `seq-${index}`,
          familyId: `fam-${index}`,
          parentUserId: `user-${index}`,
          // A distinct page each, so the run's cache cannot collapse them — the
          // widget, never the course id, which the read checks the page's own EventId
          // against.
          courseUrl: MARKHAM_COURSE.replace('widgetId=bfd08479', `widgetId=bfd0847${index}`),
        }),
      );
      const h = harness({
        sequences,
        fetchBody: async () => {
          vi.setSystemTime(new Date(Date.now() + 31_000));
          return coursePage();
        },
      });
      vi.stubEnv('F14_FAMILY_ALLOWLIST', 'fam-0,fam-1,fam-2');

      const result = await runRegistrationSequenceCron(db(), h.deps, GO_TICK);

      expect(result).toMatchObject({ sent: 3, read: 1, readSkipped: 2 });
      expect(result.prep.page_unreadable).toBe(2);
      expect(h.transport.sent).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('still texts a bound household whose children no longer fit the M1 band', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    // The parent picked THIS course and Hale read THIS page; the M1 band is a hand-read
    // of a season info page and has nothing to say about it. Silence here would be the
    // ladder losing the morning to reference data — so the leg goes, and the fact that
    // no band admits anybody is counted by its own name rather than as "nothing due".
    const h = harness({
      sequences: [bound()],
      children: [{ id: 'child-1', name: 'Ada', dateOfBirth: '2012-05-01', dobPrecision: 'exact' }],
      fetchBody: async () => coursePage(),
    });

    const result = await runRegistrationSequenceCron(db(), h.deps, GO_TICK);

    expect(result).toMatchObject({ sent: 1, noFit: 1, quiet: 0 });
    expect(h.transport.bodies()[0]).toContain(MARKHAM_SIGN_IN);
    expect(h.kept).toEqual([{ kind: 'registration_watch', channelMessageId: 'msg-1' }]);
  });

  it('still says nothing about an UNBOUND window no child fits any more', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    // The positive control for the case above: with no course bound there is no page to
    // speak from, and the M1 band is all Hale has — so silence is still the honest answer.
    const h = harness({
      sequences: [live()],
      children: [{ id: 'child-1', name: 'Ada', dateOfBirth: '2012-05-01', dobPrecision: 'exact' }],
    });

    const result = await runRegistrationSequenceCron(db(), h.deps, GO_TICK);

    expect(result).toMatchObject({ sent: 0, quiet: 1, noFit: 0 });
  });

  it('still asks a bound no-fit household how it went, and still guards its waitlist', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    // The same birthday that crossed the band ceiling before the morning is still across
    // it after. A household that got the go text is owed the question that follows it,
    // and the two legs after the morning never named who the window fits: "How did X go?"
    // and a clock the parent's own message started. Kills scoping the bound exemption to
    // the two legs that read the page, which leaves this ladder ending mid-sentence.
    const aged: SequenceChild[] = [
      { id: 'child-1', name: 'Ada', dateOfBirth: '2012-05-01', dobPrecision: 'exact' },
    ];

    const checkIn = harness({
      sequences: [bound()],
      children: aged,
      fetchBody: async () => coursePage(),
    });
    const checkInResult = await runRegistrationSequenceCron(
      db(),
      checkIn.deps,
      new Date('2026-09-15T14:30:00.000Z'),
    );
    expect(checkInResult).toMatchObject({ sent: 1, noFit: 1, quiet: 0, read: 0 });
    expect(checkIn.transport.bodies()[0]).toContain('How did');

    const guard = harness({
      sequences: [
        bound({
          outcome: 'waitlisted',
          waitlistPosition: 15,
          waitlistStartedAt: new Date('2026-09-15T15:00:00.000Z'),
        }),
      ],
      children: aged,
    });
    const guardResult = await runRegistrationSequenceCron(
      db(),
      guard.deps,
      new Date('2026-09-16T14:00:00.000Z'),
    );
    expect(guardResult).toMatchObject({ sent: 1, noFit: 1 });
    expect(guard.transport.bodies()[0]).toContain('36h');

    // The other half of the rule, and the positive control for both: the two legs that
    // DO name who fits stay quiet for this household, bound or not — a heads-up "for
    // Ada" about a band Ada has aged out of is the sentence the silence exists for.
    const headsUp = harness({ sequences: [bound()], children: aged });
    const headsUpResult = await runRegistrationSequenceCron(db(), headsUp.deps, HEADS_UP_TICK);
    expect(headsUpResult).toMatchObject({ sent: 0, quiet: 1, noFit: 0 });
  });

  it('sends the readiness checklist to an approved portal household, and only there', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    // 10:00 Toronto on 12 Sept — three days out, inside the readiness interval.
    const READINESS_TICK = new Date('2026-09-12T14:00:00.000Z');
    const portal = harness({ sequences: [live({ areaCoarse: 'L3R', window: markhamWindow() })] });
    const portalResult = await runRegistrationSequenceCron(db(), portal.deps, READINESS_TICK);

    expect(portalResult.sent).toBe(1);
    expect(portal.transport.bodies()[0]).toContain('a Markham portal account');
    expect([...portal.dedupeKeys]).toEqual(['registration_sequence:fam-1:w-1:readiness:user-1']);

    // Richmond Hill sits in the same hours and still reads the heads-up, whose key was
    // spent days ago — every tick in the old tail is `deduped`, exactly as today.
    const town = harness({ sequences: [live()] });
    const townResult = await runRegistrationSequenceCron(db(), town.deps, READINESS_TICK);
    expect(townResult.sent).toBe(1);
    expect(town.transport.bodies()[0]).toContain('2026-09-15 at 06:30 America/Toronto');
    expect([...town.dedupeKeys]).toEqual(['registration_sequence:fam-1:w-1:heads_up:user-1']);
  });

  it('wires the real page fetcher into the default deps (rule #11)', async () => {
    // The read is an EFFECT, and WHICH one matters: the bare GET with no User-Agent
    // (the measured Akamai 403) and `redirect: 'error'` (a Queue-it hop is a failure,
    // not a page). A dep declared and wired to something friendlier would send the
    // sentence "I read the page" about bytes from an origin nobody approved.
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(coursePage(), { status: 200 }));
    try {
      const { fetchBody } = defaultSequenceRunDeps();
      await fetchBody(MARKHAM_COURSE);
      expect(fetchSpy).toHaveBeenCalledWith(
        MARKHAM_COURSE,
        expect.objectContaining({
          redirect: 'error',
          headers: { Accept: 'text/html,application/xhtml+xml' },
        }),
      );
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

/**
 * VIL-347 · THE 23:45 TEXT. Oakville publishes a non-resident DATE and no hour ("14 days
 * after Oakville resident registration begins"), so the row stores the start of that
 * local day — the date-only rule every such row follows. The go leg fires fifteen
 * minutes before its anchor and is one of the two legs exempt from quiet hours, so a
 * start-of-day anchor put "registration opens 12:00 a.m." on a parent's phone at 23:45
 * the night before: a minute nobody published, at the hour the exemption exists to
 * protect, four and three-quarter hours after the battle plan said the same thing.
 */
describe('a town that published a date and no hour (VIL-347)', () => {
  /** Oakville's non-resident open as the row stores it: 2026-08-25, 00:00 Toronto. */
  const START_OF_DAY = new Date('2026-08-25T04:00:00.000Z');
  /** The same morning with the hour the Town actually prints for residents, 7 a.m. */
  const SEVEN_AM = new Date('2026-08-25T11:00:00.000Z');
  /** A two-parent household throughout: the window is unreadable for the HOUSEHOLD, so
   * the decision has to be made once, above the fan-out, rather than once per number. */
  const BOTH_PARENTS: FamilyTextRecipient[] = [
    { parentUserId: 'user-1', timeZone: TZ, role: 'primary_parent' },
    { parentUserId: 'user-2', timeZone: TZ, role: 'co_parent' },
  ];
  const NUMBERS = { 'user-1': '+14165550100', 'user-2': '+16475550199' };
  const goTickFor = (openAt: Date) => new Date(openAt.getTime() - GO_LEAD_MINUTES * 60_000);
  const oakville = (openAt: Date) =>
    live({
      window: win({
        id: 'w-oakville',
        municipality: 'oakville',
        openAt,
        sourceUrl:
          'https://www.oakville.ca/parks-recreation-culture/programs-activities/registered-programs/',
      }),
    });

  it('says nothing at 23:45 rather than naming a midnight nobody published', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    const h = harness({
      sequences: [oakville(START_OF_DAY)],
      recipients: BOTH_PARENTS,
      phones: NUMBERS,
    });

    const result = await runRegistrationSequenceCron(db(), h.deps, goTickFor(START_OF_DAY));

    expect(h.transport.sent).toEqual([]);
    expect(result.sent).toBe(0);
    // The live date moves the old midnight scheduling marker to local noon.
    expect(result.skipped.open_time_unpublished).toBe(0);
    expect(result.quiet).toBe(1);
    expect(result.held).toEqual({
      not_enrolled: 0,
      opt_out_unread: 0,
      no_watch_consent: 0,
      quiet_hours: 0,
    });
  });

  it.each(['go', 'check_in'])(
    'never sends %s from a date-only noon scheduling marker',
    async (leg) => {
      vi.stubEnv('F14_ENABLED', 'true');
      const marker = new Date('2026-08-25T16:00:00Z');
      const sequence = oakville(START_OF_DAY);
      sequence.courseOpensAt = marker;
      const h = harness({ sequences: [sequence], recipients: BOTH_PARENTS, phones: NUMBERS });
      const tick = leg === 'go' ? goTickFor(marker) : new Date(marker.getTime() + 4 * 3_600_000);
      const result = await runRegistrationSequenceCron(db(), h.deps, tick);
      expect(result.sent).toBe(0);
      expect(result.skipped.open_time_unpublished).toBe(1);
      expect(h.transport.sent).toEqual([]);
    },
  );

  it('still sends the go leg to both parents where the town DID print the hour', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    const h = harness({
      sequences: [oakville(SEVEN_AM)],
      recipients: BOTH_PARENTS,
      phones: NUMBERS,
    });

    const result = await runRegistrationSequenceCron(db(), h.deps, goTickFor(SEVEN_AM));

    expect(result.sent).toBe(2);
    expect(result.skipped.open_time_unpublished).toBe(0);
    expect(h.transport.sent.map((sent) => sent.to)).toEqual(['+14165550100', '+16475550199']);
    for (const body of h.transport.bodies()) expect(body).toContain('7:00');
  });

  it('leaves the evening-before plan alone — it names a date, not a minute', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    const h = harness({
      sequences: [oakville(START_OF_DAY)],
      recipients: BOTH_PARENTS,
      phones: NUMBERS,
    });

    // 19:00 Toronto on 24 Aug, the battle-plan slot.
    const result = await runRegistrationSequenceCron(
      db(),
      h.deps,
      new Date('2026-08-24T23:00:00.000Z'),
    );

    expect(result.sent).toBe(2);
    expect(result.skipped.open_time_unpublished).toBe(0);
  });
});

/**
 * THE GAP THE 2026-09-17 AUDIT FOUND. The site promises a co-parent "the same radar and
 * reminders, on their own number", and the loop kept it — the weekly plan and the event
 * reminders both select `['primary_parent', 'co_parent']`. This ladder did not: it
 * joined on `role = 'primary_parent'` and texted one number, so the household's second
 * parent heard about the registration morning from their partner or not at all.
 *
 * What these cases pin is the shape of the fix rather than its mechanics: the ROW is
 * still one per family+window (one claim, one approval, one promise), and the SEND is
 * one per parent seat with its own key, its own gate verdict and its own thread.
 */
describe('the ladder reaches both parents, on their own numbers', () => {
  const BOTH: FamilyTextRecipient[] = [
    { parentUserId: 'user-1', timeZone: TZ, role: 'primary_parent' },
    { parentUserId: 'user-2', timeZone: TZ, role: 'co_parent' },
  ];
  const PHONES = { 'user-1': '+14165550100', 'user-2': '+16475550199' };

  it('sends the heads-up to both numbers under distinct keys, and promises the plan once', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    const h = harness({ sequences: [live()], recipients: BOTH, phones: PHONES });

    const result = await runRegistrationSequenceCron(db(), h.deps, HEADS_UP_TICK);

    expect(result.sent).toBe(2);
    expect(h.transport.sent.map((sent) => sent.to)).toEqual(['+14165550100', '+16475550199']);
    // One key each. `channel_messages.dedupe_key` is UNIQUE, so a family-scoped key
    // here is not a duplicate text — it is the second insert throwing.
    expect([...h.dedupeKeys]).toEqual([
      'registration_sequence:fam-1:w-1:heads_up:user-1',
      'registration_sequence:fam-1:w-1:heads_up:user-2',
    ]);
    // Each parent's own thread, so each one's reply has an antecedent the coach reads.
    expect(h.threaded.map((row) => row.parentUserId)).toEqual(['user-1', 'user-2']);
    // ONE plan promised. "I'll send your plan the evening before" is one plan for one
    // household; a promise per number is a debt Hale does not owe.
    expect(h.promised.map((row) => row.kind)).toEqual(['registration_plan']);
    expect(h.promised[0]?.channelMessageId).toBe('msg-1');
  });

  it('sends the same morning sentence to both, composed once', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    const h = harness({ sequences: [live()], recipients: BOTH, phones: PHONES });

    await runRegistrationSequenceCron(db(), h.deps, GO_TICK);

    const [first, second] = h.transport.bodies();
    expect(h.transport.sent).toHaveLength(2);
    expect(first).toContain(win().sourceUrl);
    // Byte-identical: the registration morning is the household's, and two parents in
    // one house reading two different times for it is the failure this forbids.
    expect(second).toBe(first);
  });

  /**
   * THE POSITIVE CONTROL. Every assertion above would also pass if the sweep had simply
   * started texting everybody twice, so the one-parent household has to come out
   * exactly as it did before: one send, one key, one thread, one promise.
   */
  it('leaves a household with one parent exactly as it was', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    const h = harness({ sequences: [live()] });

    const result = await runRegistrationSequenceCron(db(), h.deps, HEADS_UP_TICK);

    expect(result.sent).toBe(1);
    expect(h.transport.sent).toHaveLength(1);
    expect([...h.dedupeKeys]).toEqual(['registration_sequence:fam-1:w-1:heads_up:user-1']);
    expect(h.threaded).toHaveLength(1);
    expect(h.promised.map((row) => row.kind)).toEqual(['registration_plan']);
  });

  it('holds the parent the gate refuses and still sends to the other', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    const h = harness({
      sequences: [live()],
      recipients: BOTH,
      phones: PHONES,
      // The co-parent pressed STOP an hour ago. The live channel is the gate's answer,
      // and it is per parent — one seat leaving must not silence the other.
      enrolledFor: (parentUserId) => parentUserId !== 'user-2',
    });

    const result = await runRegistrationSequenceCron(db(), h.deps, HEADS_UP_TICK);

    expect(result.sent).toBe(1);
    expect(result.held.not_enrolled).toBe(1);
    expect(h.transport.sent.map((sent) => sent.to)).toEqual(['+14165550100']);
  });

  it('sends nothing, and says not_enrolled, for a household with no live number left', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    const h = harness({ sequences: [live()], recipients: [] });

    const result = await runRegistrationSequenceCron(db(), h.deps, HEADS_UP_TICK);

    // NOT counted quiet: a tick with nobody to text is a different fact from a tick
    // with nothing to say, and only one of them is a departed household.
    expect(result).toMatchObject({ sent: 0, quiet: 0 });
    expect(result.held.not_enrolled).toBe(1);
    expect(h.transport.sent).toEqual([]);
  });

  it('dedupes per parent, so a second fire in the interval sends to nobody', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    const h = harness({ sequences: [live()], recipients: BOTH, phones: PHONES });

    await runRegistrationSequenceCron(db(), h.deps, HEADS_UP_TICK);
    const second = await runRegistrationSequenceCron(
      db(),
      h.deps,
      new Date(HEADS_UP_TICK.getTime() + 300_000),
    );

    expect(second).toMatchObject({ sent: 0, deduped: 2 });
    expect(h.transport.sent).toHaveLength(2);
  });
});
