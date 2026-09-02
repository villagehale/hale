import type { Database } from '@hale/db';
import { withOptOut } from '~/lib/channel/opt-out';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { F14_ALLOWLIST_ENV, F14_ENABLED_ENV } from '~/lib/channel/f14';
import type { ProactiveHoldReason } from '~/lib/channel/outbound-gate';
import { type PlanCheckInDeps, runPlanCheckInSweep } from './check-in';
import type { NoteComposeOutcome } from './note';

/**
 * The one unprompted message in the arc.
 *
 * What is pinned: it is dark until armed, it goes through the outbound gate rather than
 * around it, a held family keeps their promise open, and a sent one closes it exactly
 * once. The gate's OWN four checks are proved in outbound-gate.test.ts — what matters
 * here is that this sweep cannot reach a transport without passing them.
 */

const FAMILY = 'fam-1';
const PARENT = 'parent-1';
const NOW = new Date('2026-08-15T14:00:00.000Z');
const DUE = {
  id: 'commitment-1',
  familyId: FAMILY,
  topic: 'sleep',
  summary: 'Check in on the Graduated check-ins (Ferber method) plan.',
  createdFrom: 'msg-9',
  subjectChildId: null,
  dueAt: new Date('2026-08-15T13:00:00.000Z'),
};
const COMPOSED = 'How have the first few nights gone?';

const database = {} as Database;

afterEach(() => {
  delete process.env[F14_ENABLED_ENV];
  delete process.env[F14_ALLOWLIST_ENV];
});

function harness(
  overrides: {
    due?: (typeof DUE)[];
    hold?: ProactiveHoldReason;
    alreadySent?: boolean;
    recipient?: { parentUserId: string; conversationId: string | null } | null;
    note?: NoteComposeOutcome;
  } = {},
) {
  const sent: Array<{ to: string; body: string }> = [];
  const ledger: Array<{ dedupeKey: string; templateKey: string }> = [];
  const audits: Array<Record<string, unknown>> = [];
  const threaded: string[] = [];
  const fulfilled: unknown[] = [];
  const gated: unknown[] = [];
  const noteGrounding: unknown[] = [];

  const deps: PlanCheckInDeps = {
    loadDue: async () => overrides.due ?? [DUE],
    resolveRecipient: async () =>
      overrides.recipient === undefined
        ? { parentUserId: PARENT, conversationId: 'conv-1' }
        : overrides.recipient,
    buildGate: () => ({
      channelEnrolled: async () => {
        gated.push('checked');
        return overrides.hold !== 'not_enrolled';
      },
      watchConsentGranted: async () => overrides.hold !== 'no_watch_consent',
      countProactiveSends: async () => (overrides.hold === 'frequency_cap' ? 99 : 0),
      proactiveSentSince: async () => true,
      // NOW is 14:00 UTC, which is 10:00 in Toronto — inside the sendable window. The
      // hold case moves the parent to a zone where the same instant is past 21:00.
      parentTimeZone: async () =>
        overrides.hold === 'quiet_hours' ? 'Pacific/Auckland' : 'America/Toronto',
    }),
    noteComposer: {
      compose: async (input) => {
        noteGrounding.push(input);
        return overrides.note ?? { status: 'composed', message: COMPOSED };
      },
    },
    loadTimeZone: async () => 'America/Toronto',
    dedupeActive: async () => overrides.alreadySent === true,
    resolveSendablePhone: async () => '+14165550100',
    transport: {
      send: async (input) => {
        sent.push(input);
        return { providerMessageId: 'prov-1' };
      },
    },
    recordSend: async (_db, write) => {
      ledger.push({ dedupeKey: write.dedupeKey, templateKey: write.templateKey });
      return 'msg-checkin';
    },
    audit: async (_db, row) => {
      audits.push(row);
    },
    threadMessage: async (_db, input) => {
      threaded.push(input.body);
      return 'thread-1';
    },
    fulfillCommitment: async (_db, input) => {
      fulfilled.push(input);
      return { status: 'closed', commitmentIds: ['commitment-1'] };
    },
  };

  return {
    run: () => runPlanCheckInSweep(database, deps, NOW),
    sent,
    ledger,
    audits,
    threaded,
    fulfilled,
    gated,
    noteGrounding,
  };
}

describe('the dark-launch gate', () => {
  it('selects nobody while F14 is unarmed', async () => {
    const h = harness();

    const result = await h.run();

    expect(result.enabled).toBe(false);
    expect(result.due).toBe(0);
    expect(h.gated).toEqual([]);
    expect(h.sent).toEqual([]);
  });

  it('runs for a family named on the allowlist while the flag is off', async () => {
    process.env[F14_ALLOWLIST_ENV] = FAMILY;
    const h = harness();

    const result = await h.run();

    expect(result).toMatchObject({ enabled: true, due: 1, sent: 1 });
  });

  it('does not run for a family the allowlist leaves out', async () => {
    process.env[F14_ALLOWLIST_ENV] = 'some-other-family';
    const h = harness();

    expect(await h.run()).toMatchObject({ enabled: true, due: 0, sent: 0 });
    expect(h.sent).toEqual([]);
  });
});

describe('a due check-in', () => {
  it('sends the reviewed sentence for its topic and closes the promise', async () => {
    process.env[F14_ENABLED_ENV] = 'true';
    const h = harness();

    const result = await h.run();

    // Every proactive message carries the CASL unsubscribe now, and this recipient has
    // been texted before, so it is the compact form (lib/channel/opt-out.ts).
    expect(h.sent).toEqual([{ to: '+14165550100', body: withOptOut(COMPOSED, 'short') }]);
    expect(h.ledger).toEqual([
      {
        dedupeKey: 'coach_plan:checkin:commitment-1',
        templateKey: 'coach_plan:check_in:sleep',
      },
    ]);
    expect(h.fulfilled).toEqual([
      { familyId: FAMILY, kind: 'plan_check_in', channelMessageId: 'msg-checkin', now: NOW },
    ]);
    expect(result).toMatchObject({ sent: 1, failed: 0, unsendable: 0 });
  });

  it('lands in the plan thread, so the answer is an ordinary coach turn', async () => {
    process.env[F14_ENABLED_ENV] = 'true';
    const h = harness();

    await h.run();

    // There is no handler for the reply on purpose: what the parent says next is
    // conversation, and it needs the question in front of it to read as one.
    // THREADED WITHOUT the compliance line: what the parent reads back in their history is
    // Hale's sentence, not the footer the wire needed.
    expect(h.threaded).toEqual([COMPOSED]);
  });

  it('threads the check-in even when the plan message carried no thread of its own', async () => {
    // Same shape as the activity follow-up's: the thread came off the plan message's
    // `related_conversation_id`, which is null for every plan a proactive sender put
    // out. The check-in still went, and the question it asks still needed an antecedent.
    process.env[F14_ENABLED_ENV] = 'true';
    const h = harness({ recipient: { parentUserId: PARENT, conversationId: null } });

    await h.run();

    expect(h.sent).toHaveLength(1);
    expect(h.threaded).toEqual([COMPOSED]);
  });

  it('audits the send without the body (rule #1/#6)', async () => {
    process.env[F14_ENABLED_ENV] = 'true';
    const h = harness();

    await h.run();

    expect(h.audits).toEqual([
      {
        familyId: FAMILY,
        actor: 'system',
        actionTaken: 'coach_plan_check_in_sent',
        targetTable: 'channel_messages',
        targetId: 'msg-checkin',
        after: { topic: 'sleep' },
      },
    ]);
  });

  it('composes the ask from the promise it is keeping, never a template', async () => {
    process.env[F14_ENABLED_ENV] = 'true';
    const h = harness();

    await h.run();

    // Grounded on the method the family actually ran and the day Hale named, so the
    // question is about THEIR week rather than about the topic in the abstract.
    expect(h.noteGrounding).toEqual([
      {
        kind: 'check_in',
        topic: 'sleep',
        playbook: expect.objectContaining({ primaryMethod: expect.anything() }),
        child: null,
        question: null,
        promise: { summary: DUE.summary, promisedDay: 'Saturday' },
      },
    ]);
  });

  it('leaves the promise open when nothing sendable composed', async () => {
    process.env[F14_ENABLED_ENV] = 'true';
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = harness({
      note: { status: 'deferred', reason: 'gates_exhausted', violations: ['two questions'] },
    });

    // No canned sentence stands in. The next tick tries again, which is the only
    // version of this that can still be true a day later.
    const result = await h.run();

    expect(h.sent).toEqual([]);
    expect(h.fulfilled).toEqual([]);
    expect(result).toMatchObject({ deferred: 1, sent: 0 });
    logged.mockRestore();
  });
});

describe('when it must not send', () => {
  it.each<ProactiveHoldReason>([
    'not_enrolled',
    'no_watch_consent',
    'frequency_cap',
    'quiet_hours',
  ])('holds on %s and leaves the promise open for the next tick', async (reason) => {
    process.env[F14_ENABLED_ENV] = 'true';
    const h = harness({ hold: reason });

    const result = await h.run();

    expect(h.sent).toEqual([]);
    expect(h.fulfilled).toEqual([]);
    expect(result.held[reason]).toBe(1);
  });

  it('sends once across two ticks in the same hour', async () => {
    process.env[F14_ENABLED_ENV] = 'true';
    const h = harness({ alreadySent: true });

    // The dedupe key is the message's natural identity, which is what lets an hourly
    // cron fire twice in a slot and text a parent once.
    const result = await h.run();

    expect(h.sent).toEqual([]);
    expect(result).toMatchObject({ due: 1, sent: 0, failed: 0 });
  });

  it('names a row it cannot turn into a message rather than holding it', async () => {
    process.env[F14_ENABLED_ENV] = 'true';
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = harness({ due: [{ ...DUE, topic: 'weaning' }] });

    // A hold is a policy decision and this is a broken row. Folding them together would
    // make "quiet hours" the number a founder reads when a topic has been retired.
    const result = await h.run();

    expect(result).toMatchObject({ unsendable: 1, sent: 0 });
    expect(Object.values(result.held)).toEqual([0, 0, 0, 0]);
    logged.mockRestore();
  });

  it('names a plan whose carrying message no longer resolves to a parent', async () => {
    process.env[F14_ENABLED_ENV] = 'true';
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = harness({ recipient: null });

    expect(await h.run()).toMatchObject({ unsendable: 1, sent: 0 });
    expect(h.sent).toEqual([]);
    logged.mockRestore();
  });
});
