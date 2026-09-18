import type { Database, schema } from '@hale/db';
import { channelSendJobPayloadSchema } from '@hale/tools-contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loopTemplateRenderer } from '~/lib/loop/templates/registry';
import { DEFAULT_LOOP_PREFS } from '~/lib/loop/prefs';
import {
  type ChannelSendJob,
  type SendCaregiverRow,
  type SendParentRow,
  type SundaySendDeps,
  runSundaySendCron,
} from './send';

/**
 * VIL-241 · M6 — the week a caregiver was promised.
 *
 * The M6 invite tells a grandparent "You're in - I'll text you the week's schedule and
 * pickup reminders, and nothing else." Until this leg existed that was the last thing
 * Hale ever said to them: `scopeWeekItemsForRole` had no production caller, and the
 * Sunday send's audience was `['primary_parent','co_parent']`.
 *
 * Injected deps + a fixed clock, mirroring send.test.ts. The bodies are rendered through
 * the REAL registry, because "the teenager's item is absent" is a claim about what lands
 * on a phone, and asserting it against a job payload would pass with a renderer that
 * printed the whole plan.
 */

const NOW = new Date('2026-01-19T13:00:00Z'); // Mon 08:00 Toronto

const TODDLER = { id: 'c1', name: 'Mia', dateOfBirth: '2022-06-01', gender: 'girl' };
const TEEN = { id: 'c2', name: 'Noor', dateOfBirth: '2011-06-01', gender: 'girl' };

const GYMNASTICS = {
  kind: 'routine',
  title: 'Gymnastics',
  childIds: [TODDLER.id],
  startsAt: '2026-01-20T16:15',
  endsAt: null,
  location: 'Stouffville Leisure Centre',
  sourceRef: null,
  needs: 'none',
  privacySensitive: false,
};
const TEEN_PRACTICE = { ...GYMNASTICS, title: 'Band practice', childIds: [TEEN.id], startsAt: '2026-01-21T17:00' };
const CHECKUP = {
  ...GYMNASTICS,
  kind: 'appointment',
  title: 'Mia - checkup',
  startsAt: '2026-01-22T10:00',
  location: null,
  needs: 'calendar_add',
  privacySensitive: true,
};
const IDEA = { ...GYMNASTICS, kind: 'suggestion', title: 'Try the new library storytime', needs: 'decision' };

const plan = {
  id: 'wp-1',
  familyId: 'fam-1',
  weekStart: '2026-01-19',
  composedAt: NOW,
  summary: 'A full week.',
  items: [GYMNASTICS, TEEN_PRACTICE, CHECKUP, IDEA],
  status: 'composed',
} as unknown as schema.WeekPlan;

const parent: SendParentRow = {
  familyId: 'fam-1',
  userId: 'p1',
  timezone: 'America/Toronto',
  weekStartDay: 1,
  view: { ...DEFAULT_LOOP_PREFS },
};

const grandma: SendCaregiverRow = {
  familyId: 'fam-1',
  userId: 'g1',
  role: 'grandparent',
  timezone: 'America/Toronto',
  weekStartDay: 1,
  view: { ...DEFAULT_LOOP_PREFS },
};

function makeDeps(over: Partial<SundaySendDeps> = {}) {
  const enqueued: ChannelSendJob[] = [];
  const captures: { event: string; distinctId: string; props: Record<string, unknown> }[] = [];
  const deps: SundaySendDeps = {
    selectParents: async () => [parent],
    selectCaregivers: async () => [grandma],
    readPlan: async (_db, _familyId, weekStart) => (weekStart === '2026-01-19' ? plan : null),
    loadChildren: async () => [TODDLER, TEEN],
    enqueue: async (job) => {
      enqueued.push(job);
    },
    capture: async (event, distinctId, props = {}) => {
      captures.push({ event, distinctId, props });
      return 'sent';
    },
    ...over,
  };
  return { deps, enqueued, captures };
}

const db = {} as Database;

/** What actually reaches the phone for this job. */
function body(job: ChannelSendJob): string {
  const rendered = loopTemplateRenderer.render(
    {
      templateKey: job.templateKey,
      familyId: job.familyId,
      parentUserId: job.parentUserId,
      category: job.category,
      urgency: job.urgency,
      payload: job.payload,
    },
    'sms',
    // The caregiver's own resolved dial — the documented absent-row default, which is the
    // one a seat with no loop_prefs row actually gets in production.
    DEFAULT_LOOP_PREFS.childNameLevel,
  );
  if (rendered.kind !== 'sms') throw new Error('expected an sms leg');
  return rendered.text;
}

describe('the caregiver weekly plan', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('texts a grandparent the schedule, pinned to sms, on the caregiver template', async () => {
    vi.stubEnv('LOOP_SEND_ENABLED', 'true');
    const { deps, enqueued } = makeDeps();
    const result = await runSundaySendCron(db, deps, NOW);

    const job = enqueued.find((j) => j.parentUserId === 'g1');
    expect(job).toBeDefined();
    expect(job).toMatchObject({
      templateKey: 'weekly_plan:caregiver',
      familyId: 'fam-1',
      parentUserId: 'g1',
      category: 'weekly_plan',
      urgency: 'normal',
      channel: 'sms',
      dedupeKey: 'fam-1:2026-01-19:g1',
    });
    expect(result.caregiversMatched).toBe(1);
    expect(result.caregiverEnqueued).toBe(1);
  });

  it('survives the queue contract with its sms pin intact', async () => {
    // THE LANDMINE THIS PINS: `channelSendJobPayloadSchema` is what the drain parses a
    // job through before dispatching it, and it used to have no `channel` key at all —
    // so zod stripped the pin and the caregiver's week went to the email adapter for a
    // recipient with no address. Parsing the real job through the real contract is the
    // only assertion that can catch that; the job object alone looks correct.
    vi.stubEnv('LOOP_SEND_ENABLED', 'true');
    const { deps, enqueued } = makeDeps();
    await runSundaySendCron(db, deps, NOW);
    const job = enqueued.find((j) => j.parentUserId === 'g1') as ChannelSendJob;
    const parsed = channelSendJobPayloadSchema.parse({
      ...job,
      familyId: '11111111-1111-4111-8111-111111111111',
      parentUserId: '22222222-2222-4222-8222-222222222222',
    });
    expect(parsed.channel).toBe('sms');
  });

  it('carries the schedule and NOT the health, the teenager, or the suggestion', async () => {
    vi.stubEnv('LOOP_SEND_ENABLED', 'true');
    const { deps, enqueued } = makeDeps();
    await runSundaySendCron(db, deps, NOW);
    const text = body(enqueued.find((j) => j.parentUserId === 'g1') as ChannelSendJob);

    // POSITIVE CONTROL first: the in-scope item and the child it belongs to are there, so
    // the absences below are absences and not an empty message.
    expect(text).toContain('Gymnastics');
    expect(text).toContain('Stouffville Leisure Centre');
    expect(text).toContain('Mia');

    expect(text).not.toContain('Band practice'); // the 13-year-old's week
    expect(text).not.toContain('Noor'); // not even her name
    expect(text).not.toContain('checkup'); // health
    expect(text).not.toContain('storytime'); // a decision that is the parents' to make
  });

  it("does not put the teenager's name or date of birth on the queue at all", async () => {
    vi.stubEnv('LOOP_SEND_ENABLED', 'true');
    const { deps, enqueued } = makeDeps();
    await runSundaySendCron(db, deps, NOW);
    const job = enqueued.find((j) => j.parentUserId === 'g1') as ChannelSendJob;
    expect(JSON.stringify(job.payload)).not.toContain('Noor');
    expect(JSON.stringify(job.payload)).not.toContain(TEEN.dateOfBirth);
    expect(job.payload.children).toEqual([{ id: 'c1', name: 'Mia' }]);
  });

  it('leaves the parents’ send exactly as it was (positive control)', async () => {
    vi.stubEnv('LOOP_SEND_ENABLED', 'true');
    const { deps, enqueued } = makeDeps();
    const result = await runSundaySendCron(db, deps, NOW);

    const parentJob = enqueued.find((j) => j.parentUserId === 'p1');
    expect(parentJob).toMatchObject({
      templateKey: 'weekly_plan',
      dedupeKey: 'fam-1:2026-01-19:p1',
    });
    expect(parentJob?.channel).toBeUndefined(); // still rides their loop_channel
    expect((parentJob?.payload as { items: unknown[] }).items).toHaveLength(4); // the WHOLE plan
    expect(result.enqueued).toBe(1);
  });

  it('sends nothing, and names the outcome, when every item is out of scope', async () => {
    vi.stubEnv('LOOP_SEND_ENABLED', 'true');
    const teenOnly = { ...plan, items: [TEEN_PRACTICE, CHECKUP] } as unknown as schema.WeekPlan;
    const { deps, enqueued } = makeDeps({ readPlan: async () => teenOnly });
    const result = await runSundaySendCron(db, deps, NOW);

    expect(enqueued.filter((j) => j.parentUserId === 'g1')).toEqual([]);
    expect(result.caregiversNothingInScope).toBe(1);
    expect(result.caregiverEnqueued).toBe(0);
    // And no "quiet week" filler: the household's week was not quiet.
    expect(enqueued.map((j) => j.templateKey)).not.toContain('weekly_plan:caregiver');
  });

  it('tags each plan with the audience it reached, so the two sends are separable in the metric', async () => {
    // Both legs fire the same `loop_plan_sent` event with the RECIPIENT as the distinct
    // id, so without this property a caregiver's week and a parent's are one undivided
    // number — and "how many parents got their Sunday" stops being answerable.
    vi.stubEnv('LOOP_SEND_ENABLED', 'true');
    const { deps, captures } = makeDeps();
    await runSundaySendCron(db, deps, NOW);
    expect(
      captures
        .filter((c) => c.event === 'loop_plan_sent')
        .map((c) => ({ distinctId: c.distinctId, audience: c.props.audience })),
    ).toEqual([
      { distinctId: 'p1', audience: 'parent' },
      { distinctId: 'g1', audience: 'caregiver' },
    ]);
  });

  it('composes but enqueues nothing while LOOP_SEND_ENABLED is off', async () => {
    vi.stubEnv('LOOP_SEND_ENABLED', 'false');
    const { deps, enqueued } = makeDeps();
    const result = await runSundaySendCron(db, deps, NOW);
    expect(enqueued).toEqual([]);
    expect(result.caregiversMatched).toBe(1);
    expect(result.caregiverEnqueued).toBe(0);
  });

  it('keys the dedupe per caregiver per week, so a re-run inside the slot re-sends nothing new', async () => {
    vi.stubEnv('LOOP_SEND_ENABLED', 'true');
    const { deps, enqueued } = makeDeps();
    await runSundaySendCron(db, deps, NOW);
    await runSundaySendCron(db, deps, new Date('2026-01-19T13:30:00Z'));
    const keys = enqueued.filter((j) => j.parentUserId === 'g1').map((j) => j.dedupeKey);
    expect(keys).toEqual(['fam-1:2026-01-19:g1', 'fam-1:2026-01-19:g1']);
  });

  it('skips a seat whose family has no composed week', async () => {
    vi.stubEnv('LOOP_SEND_ENABLED', 'true');
    const { deps, enqueued } = makeDeps({ readPlan: async () => null });
    const result = await runSundaySendCron(db, deps, NOW);
    expect(enqueued).toEqual([]);
    expect(result.skippedNoPlan).toBe(2); // the parent's and the caregiver's
    expect(result.caregiversNothingInScope).toBe(0);
  });
});
