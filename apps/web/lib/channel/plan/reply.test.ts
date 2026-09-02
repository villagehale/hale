import type { Database } from '@hale/db';
import { describe, expect, it, vi } from 'vitest';
import { playbookFor } from '@hale/types';
import type { PlanComposeOutcome } from './compose';
import type { NoteComposeOutcome } from './note';
import { PlanDeferred, type PlanReplyDeps, handlePlanYes } from './reply';

/**
 * The YES, end to end minus the provider and the model.
 *
 * Four properties earn their place here, and each is a defect this handler exists to
 * make impossible:
 *
 *   IT CLAIMS NARROWLY. A bare affirmative with no fresh offer behind it belongs to
 *   whatever else Hale asked, and taking it would answer the wrong question with three
 *   texts of parenting advice.
 *   IT SENDS IN ORDER, AND ONCE. A re-drained job must resume, not repeat.
 *   IT CLOSES ONLY WHAT IT KEPT. A plan that composed and did not send must leave the
 *   offer open — a promise marked kept by a message nobody received is the one lie the
 *   ledger exists to prevent.
 *   IT NEVER SENDS A SIREN AS A PLAN.
 */

const FAMILY = 'fam-1';
const PARENT = 'parent-1';
const CONVERSATION = 'conv-1';
const NOW = new Date('2026-08-12T14:00:00.000Z');
const FRESH_OFFER = {
  id: 'commitment-1',
  summary: 'Offered the full sleep plan - waiting on a yes.',
  topic: 'sleep',
  subjectChildId: 'child-1',
  // Null on every kind but the founder's welcome offer: this promise's subject and the
  // family it is owed to are the same household.
  subjectFamilyId: null,
  dueAt: new Date('2026-08-14T14:00:00.000Z'),
  createdAt: new Date('2026-08-11T14:00:00.000Z'),
};
const PLAN = [
  'Nights 1-3: the Ferber method - down drowsy but awake, wait 3 minutes before going in.',
  "Nights 4-7: stretch the wait to 10. I'll check in Friday.",
];

const database = {} as Database;

function harness(
  overrides: {
    offer?: typeof FRESH_OFFER | null;
    composed?: PlanComposeOutcome;
    note?: NoteComposeOutcome;
    child?: { ageMonths: number; stage: 'newborn' | 'toddler' } | null;
    question?: string | null;
    alreadySent?: string[];
    sendFailsAt?: number;
  } = {},
) {
  const sent: string[] = [];
  /** The router's bound sender, as a handler sees it: a body in, a receipt out, and no
   * destination anywhere — which is what stops this handler picking a channel. */
  const send = async (body: string) => {
    if (sent.length === overrides.sendFailsAt) throw new Error('carrier rejected');
    sent.push(body);
    return { providerMessageId: `prov-${sent.length}`, channel: 'sms' as const };
  };
  const ledger: Array<{ dedupeKey: string; templateKey: string }> = [];
  const audits: Array<Record<string, unknown>> = [];
  const threaded: string[] = [];
  const fulfilled: unknown[] = [];
  const cancelled: unknown[] = [];
  const recorded: unknown[] = [];
  const grounding: unknown[] = [];
  const noteGrounding: unknown[] = [];

  const deps: PlanReplyDeps = {
    loadOpenOffer: async () =>
      overrides.offer === undefined ? FRESH_OFFER : overrides.offer,
    loadQuestion: async () =>
      overrides.question === undefined ? 'he wakes at 3am every single night' : overrides.question,
    loadChild: async () =>
      overrides.child === undefined ? { ageMonths: 26, stage: 'toddler' } : overrides.child,
    loadFacts: async () => ['Bedtime is 7pm.'],
    loadTimeZone: async () => 'America/Toronto',
    composer: {
      compose: async (input) => {
        grounding.push(input);
        return overrides.composed ?? { status: 'composed', messages: PLAN, checkInDays: 3 };
      },
    },
    noteComposer: {
      compose: async (input) => {
        noteGrounding.push(input);
        return overrides.note ?? { status: 'composed', message: 'He is a bit young for that yet.' };
      },
    },
    dedupeActive: async (key) => (overrides.alreadySent ?? []).includes(key),
    recordSend: async (_db, write) => {
      ledger.push({ dedupeKey: write.dedupeKey, templateKey: write.templateKey });
      return `msg-${ledger.length}`;
    },
    audit: async (_db, row) => {
      audits.push(row);
    },
    appendMessage: async (_conversationId, _role, content) => {
      threaded.push(content);
      return `thread-${threaded.length}`;
    },
    fulfillCommitment: async (_db, input) => {
      fulfilled.push(input);
      return { status: 'closed', commitmentIds: ['commitment-1'] };
    },
    cancelCommitment: async (_db, input) => {
      cancelled.push(input);
      return { status: 'closed', commitmentIds: ['commitment-1'] };
    },
    recordCommitment: async (_db, input) => {
      recorded.push(input);
      return { status: 'recorded', commitmentId: 'commitment-2' };
    },
  };

  const run = (body = 'yes') =>
    handlePlanYes(
      database,
      { familyId: FAMILY, parentUserId: PARENT, conversationId: CONVERSATION, body, send, now: NOW },
      deps,
    );

  return {
    run,
    sent,
    ledger,
    audits,
    threaded,
    fulfilled,
    cancelled,
    recorded,
    grounding,
    noteGrounding,
  };
}

describe('claiming', () => {
  it('sends the plan on a bare yes with a fresh offer open', async () => {
    const h = harness();

    const outcome = await h.run();

    expect(outcome).toEqual({ status: 'plan_sent', sent: 2, checkInDays: 3 });
    expect(h.sent).toEqual(PLAN);
  });

  it('leaves an ordinary message to the coach', async () => {
    const h = harness();

    expect(await h.run('what time is swim')).toEqual({ status: 'declined_to_claim' });
    expect(h.sent).toEqual([]);
  });

  it('leaves a bare yes alone when no plan was offered', async () => {
    const h = harness({ offer: null });

    // The overwhelmingly common case for the word "yes" on this channel. Claiming it
    // would answer some other question with three texts of parenting advice.
    expect(await h.run()).toEqual({ status: 'declined_to_claim' });
    expect(h.sent).toEqual([]);
  });

  it('lets a stale offer expire rather than answering a week-old question', async () => {
    const h = harness({
      offer: { ...FRESH_OFFER, dueAt: new Date('2026-08-11T14:00:00.000Z') },
    });

    expect(await h.run()).toEqual({ status: 'declined_to_claim' });
    expect(h.sent).toEqual([]);
  });

  it('declines an offer whose topic this build no longer knows', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = harness({ offer: { ...FRESH_OFFER, topic: 'weaning' } });

    // Grounding a plan on a guess is worse than handing the turn to the coach, which
    // can read what the parent actually said.
    expect(await h.run()).toEqual({ status: 'declined_to_claim' });
    expect(logged).toHaveBeenCalledTimes(1);
    logged.mockRestore();
  });
});

describe('grounding', () => {
  it('writes the plan from the question the parent actually asked', async () => {
    const h = harness();

    await h.run();

    // `topic` is only the category. "He wakes at 3am" and "we want him out of our bed"
    // are both sleep, and they are not the same plan.
    expect(h.grounding).toHaveLength(1);
    expect(h.grounding[0]).toMatchObject({
      topic: 'sleep',
      question: 'he wakes at 3am every single night',
      child: { ageMonths: 26, stage: 'toddler' },
      facts: ['Bedtime is 7pm.'],
    });
    // The METHOD content comes from the curated playbook, never from the model's own
    // knowledge — that is the whole point of the arc's second pass.
    expect((h.grounding[0] as { playbook: { primaryMethod: { name: string } } }).playbook
      .primaryMethod.name).toBe(playbookFor('sleep').primaryMethod.name);
  });

  it('names it in the log when the thread no longer holds the question', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = harness({ question: null });

    await h.run();

    // A worse brief, deliberately, rather than refusing a parent who said yes — but a
    // plan that could not be aimed is worth a line in the log.
    expect(h.grounding).toHaveLength(1);
    expect((h.grounding[0] as { question: string }).question).toContain('Ferber');
    expect(logged).toHaveBeenCalledTimes(1);
    logged.mockRestore();
  });
});

describe('the ordered send', () => {
  it('gives every message its own dedupe key, in order', async () => {
    const h = harness();

    await h.run();

    expect(h.ledger).toEqual([
      { dedupeKey: 'coach_plan:commitment-1:0', templateKey: 'coach_plan:sleep' },
      { dedupeKey: 'coach_plan:commitment-1:1', templateKey: 'coach_plan:sleep' },
    ]);
  });

  it('resumes a half-sent plan rather than repeating it', async () => {
    const h = harness({ alreadySent: ['coach_plan:commitment-1:0'] });

    // A re-drained job. The first stage already reached the parent, so only the second
    // goes — the whole reason each message carries a key of its own.
    const outcome = await h.run();

    expect(h.sent).toEqual([PLAN[1]]);
    expect(outcome).toEqual({ status: 'plan_sent', sent: 1, checkInDays: 3 });
  });

  it('puts what was sent in the thread, so the next turn reads it back', async () => {
    const h = harness();

    await h.run();

    expect(h.threaded).toEqual(PLAN);
  });

  it('writes an audit row per message and never the body (rule #1/#6)', async () => {
    const h = harness();

    await h.run();

    expect(h.audits).toHaveLength(2);
    expect(h.audits[0]).toMatchObject({
      familyId: FAMILY,
      actionTaken: 'coach_plan_message_sent',
      after: { topic: 'sleep', index: 0 },
    });
    expect(JSON.stringify(h.audits)).not.toContain('drowsy');
  });
});

describe('closing the loop', () => {
  it('keeps the offer with the first message and owes a check-in from the last', async () => {
    const h = harness();

    await h.run();

    expect(h.fulfilled).toEqual([
      { familyId: FAMILY, kind: 'plan_offer', channelMessageId: 'msg-1', now: NOW },
    ]);
    expect(h.recorded).toEqual([
      {
        familyId: FAMILY,
        kind: 'plan_check_in',
        summary: `Check in on the ${playbookFor('sleep').primaryMethod.name} plan.`,
        topic: 'sleep',
        subjectChildId: 'child-1',
        // Derived from the composer's OWN chosen offset, so the day Hale promised in
        // prose and the day the row fires cannot disagree.
        dueAt: new Date(NOW.getTime() + 3 * 24 * 3_600_000),
        channelMessageId: 'msg-2',
      },
    ]);
  });

  it('DEFERS rather than sending a canned apology, leaving the offer open', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = harness({
      composed: { status: 'deferred', reason: 'gates_exhausted', violations: ['too long'] },
    });

    // No preset body exists on this path. The throw is the point: the drain redrives
    // the turn, the still-open offer re-claims the same YES, and a real plan lands late
    // rather than an apology landing on time.
    await expect(h.run()).rejects.toBeInstanceOf(PlanDeferred);
    expect(h.sent).toEqual([]);
    expect(h.fulfilled).toEqual([]);
    expect(h.recorded).toEqual([]);
    logged.mockRestore();
  });

  it('leaves the offer open when nothing reached the parent', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = harness({ sendFailsAt: 0 });

    // A promise marked kept by a message nobody received is the one lie the ledger
    // exists to prevent — and the check-in would then ask about a plan that never went.
    await expect(h.run()).rejects.toThrow('carrier rejected');
    expect(h.fulfilled).toEqual([]);
    expect(h.recorded).toEqual([]);
    logged.mockRestore();
  });
});

describe('the age gate', () => {
  it('refuses a sleep plan for a 4-month-old, before a model writes a plan at all', async () => {
    const h = harness({ child: { ageMonths: 4, stage: 'newborn' } });

    const outcome = await h.run();

    // The gate is CODE, ahead of the composer, because the whole point of a gate is
    // that it holds on the run where the model would have said yes.
    expect(outcome).toEqual({ status: 'age_gated', sent: 1 });
    expect(h.grounding).toEqual([]);
    expect(h.sent).toEqual(['He is a bit young for that yet.']);
  });

  it('grounds the refusal on the playbook, not on the model knowing the rule', async () => {
    const h = harness({ child: { ageMonths: 4, stage: 'newborn' } });

    await h.run();

    expect(h.noteGrounding).toHaveLength(1);
    expect(h.noteGrounding[0]).toMatchObject({
      kind: 'too_young',
      topic: 'sleep',
      child: { ageMonths: 4 },
    });
  });

  it('VOIDS the offer rather than marking it kept by a refusal', async () => {
    const h = harness({ child: { ageMonths: 4, stage: 'newborn' } });

    await h.run();

    // The promise was a plan. A refusal does not keep it, so marking it fulfilled would
    // put a false entry in the one ledger that records what Hale actually did — and
    // leaving it open would re-refuse on every later yes.
    expect(h.fulfilled).toEqual([]);
    expect(h.recorded).toEqual([]);
    expect(h.cancelled).toEqual([
      { familyId: FAMILY, kind: 'plan_offer', reason: 'plan_age_gated', now: NOW },
    ]);
  });

  it('still plans for a child inside the bound', async () => {
    // 26 months: inside sleep's verified 6-36. A gate that fired here would be worse
    // than no gate, so the passing case is asserted through the same path.
    const outcome = await harness({ child: { ageMonths: 26, stage: 'toddler' } }).run();

    expect(outcome).toMatchObject({ status: 'plan_sent' });
  });

  it('composes with no age rather than inventing a refusal for one nobody knows', async () => {
    const h = harness({
      offer: { ...FRESH_OFFER, subjectChildId: null as unknown as string },
      child: null,
    });

    const outcome = await h.run();

    expect(outcome).toMatchObject({ status: 'plan_sent' });
    expect((h.grounding[0] as { child: unknown }).child).toBeNull();
  });
});
