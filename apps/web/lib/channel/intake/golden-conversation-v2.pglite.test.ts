import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { routeInboundText } from '~/lib/channel/inbound-route';
import { HALE_CONTACT_FIRST_NAME } from '~/lib/channel/linq/contact-card';
import { FakeRateLimiter } from '~/lib/rate-limit/fake';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import {
  FakeExtractor,
  FakeIdentityAsk,
  FakeIntentReader,
  fakeNoOpenQuestions,
  fakeSilentAnswerComposer,
} from './fakes';
import type { FriendVoiceInput } from './friend-voice';
import { type ScriptedTurn, findResult, v2Turn } from './golden-conversation-v2.fixture';
import { KID_PROFILE_FACT_KEY } from './kid-profile-facts';
import type { IntakeDeps } from './machine';
import { FakeTransport, type InboundMessage } from './transport';

/**
 * VIL-721 · what the in-thread walk keeps, on real Postgres through the real machine:
 * the kids' names, ages and activities, each read by the model (a stand-in at the
 * composer port drives the walk) and each in family memory with its provenance.
 */

const KEY = Buffer.alloc(32, 7).toString('base64');
const PHONE = '+14165551234';
const CHAT = '8f392755-6865-4b18-880a-227f9d8b458f';
const T0 = new Date('2026-07-30T12:00:00.000Z');
const FROM = '+15555550100';
const LINK = /https:\/\/\S+/g;

function conversation(
  database: TestDb['database'],
  compose: (input: FriendVoiceInput) => ScriptedTurn = v2Turn,
) {
  const transport = new FakeTransport();
  const events: { event: string; properties: Record<string, unknown> }[] = [];
  let clock = new Date(T0.getTime() - 60_000);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const target = String(url);
      if (target.includes('/contact_card') && (init?.method ?? 'GET') === 'GET') {
        return Response.json({
          contact_cards: [
            { phone_number: FROM, first_name: HALE_CONTACT_FIRST_NAME, is_active: true },
          ],
        });
      }
      if (target.includes('/contact_card')) {
        return Response.json({
          phone_number: FROM,
          first_name: HALE_CONTACT_FIRST_NAME,
          is_active: true,
        });
      }
      return new Response(null, { status: 204 });
    }),
  );
  const deps = (): IntakeDeps => ({
    transport,
    threadMessage: async () => 'conv-1',
    openQuestions: fakeNoOpenQuestions,
    extractor: new FakeExtractor([{ children: [], postalCode: null }]),
    intentReader: new FakeIntentReader([
      { intent: 'assent', verbatim: 'yes', interpretation: 'plain yes' },
    ]),
    radar: { compose: async () => findResult() },
    answerComposer: fakeSilentAnswerComposer,
    identityAsk: new FakeIdentityAsk(),
    limiter: new FakeRateLimiter(() => clock.getTime()),
    friendVoice: {
      async compose(input: FriendVoiceInput) {
        return compose(input);
      },
    },
    capture: async (event, _distinctId, properties) => {
      events.push({ event, properties: (properties ?? {}) as Record<string, unknown> });
      return 'sent' as const;
    },
    now: clock,
  });
  let sequence = 0;
  return {
    transport,
    events,
    say: async (body: string) => {
      sequence += 1;
      clock = new Date(clock.getTime() + 60_000);
      vi.setSystemTime(clock);
      const sentFrom = transport.bodies().length;
      const inbound: InboundMessage = {
        from: PHONE,
        body,
        providerId: `v2-pg-${sequence}`,
        receivedAt: clock,
        transport: 'imessage',
        chatId: CHAT,
      };
      await routeInboundText(
        {
          database,
          log: { info: () => undefined, warn: () => undefined, error: () => undefined },
          countOutcome: async () => undefined,
          intake: () => ({ ...deps(), now: clock }),
          enqueue: async () => undefined,
          now: () => clock,
        },
        inbound,
      );
      return { bodies: transport.bodies().slice(sentFrom) };
    },
  };
}

function linksIn(bodies: readonly string[]): string[] {
  return bodies.flatMap((body) => body.match(LINK) ?? []);
}

describe('VIL-721 what the walk keeps, on Postgres', () => {
  let db: TestDb;

  beforeEach(async () => {
    process.env.APP_ENCRYPTION_KEY = KEY;
    db = await createTestDb();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    vi.stubEnv('FIRST_TOUCH_LADDER_ENABLED', 'on');
    vi.stubEnv('COLD_START_LADDER_ENABLED', 'true');
    // Pinned, not assumed: the flags-on CI job turns every default-off flag on, and this
    // stand-in does not fill the marks the model-fields flag would require.
    vi.stubEnv('THREAD_ONBOARDING_V2_ENABLED', 'false');
    vi.stubEnv('FRIEND_VOICE_MODEL_FIELDS_ENABLED', 'false');
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    vi.stubEnv('LINQ_FROM_E164', FROM);
    vi.stubEnv('APP_URL', 'https://app.example.com');
  });

  afterEach(async () => {
    process.env.APP_ENCRYPTION_KEY = '';
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    await db.close();
  });

  const facts = () => db.database.select().from(schema.familyMemoryFacts);
  const audited = (action: string) =>
    db.database.select().from(schema.auditLog).where(eq(schema.auditLog.actionTaken, action));

  it('walks postal, kids, ages, the map, activities, name, ONE Google link, schedule, co-parent', async () => {
    vi.stubEnv('THREAD_ONBOARDING_V2_ENABLED', 'true');
    const talk = conversation(db.database);
    expect((await talk.say('hi')).bodies.join('\n')).toMatch(/postal code\?$/);
    expect((await talk.say('M5V 2T6')).bodies.join('\n')).toMatch(/kids' names\?$/);
    expect((await talk.say('Maya')).bodies.join('\n')).toMatch(/How old are your kids\?$/);

    // The map is the first useful thing, and the activities ask follows it on its own.
    const shown = await talk.say("she's 4");
    expect(shown.bodies.length).toBeGreaterThanOrEqual(2);
    expect(shown.bodies.slice(0, -1).join('\n')).toContain('Swim at the rec centre');
    expect(shown.bodies.slice(0, -1).join('\n')).not.toContain('?');
    expect(shown.bodies.at(-1)).toMatch(/already do.*\?$/);

    // First text at T0, the map on the fourth text, three minutes in.
    const completed = talk.events.find((entry) => entry.event === 'intake_completed');
    expect(completed?.properties.duration_s).toBe(180);
    expect(Number(completed?.properties.duration_s)).toBeLessThan(600);

    const named = await talk.say('she swims on Saturdays');
    expect(named.bodies.join('\n')).toMatch(/What should I call you\?$/);

    // One link, for both. No per-provider link, ever.
    const google = await talk.say('Dana');
    const googleText = google.bodies.join('\n');
    expect(googleText.replace(LINK, '')).toMatch(/connect Gmail and your calendar/);
    expect(googleText).toMatch(/unverified app/);
    expect(linksIn(google.bodies)).toHaveLength(1);
    expect(linksIn(google.bodies)[0]).toContain('to=google');

    const yes = await talk.say('yes');
    expect(yes.bodies.join('\n')).toContain('Tap it when');
    expect(yes.bodies.join('\n')).not.toContain('?');
    expect(linksIn(yes.bodies)).toEqual([]);

    expect((await talk.say('ok')).bodies.join('\n')).toMatch(/weekly reminder\?$/);
    expect((await talk.say('yes')).bodies.join('\n')).toBe(
      'Done, a weekly reminder for the first one.',
    );
    expect((await talk.say('sounds good')).bodies.join('\n')).toMatch(/other parent\?$/);

    const all = talk.transport.bodies();
    expect(linksIn(all)).toHaveLength(1);
    expect(all.join('\n')).not.toMatch(/to=gmail|to=gcal/);
    expect(all.join('\n')).not.toMatch(/booked|enrolled|signed up|registered/i);
  });

  it('lit, keeps the name, the age and the activity, each with where it came from', async () => {
    vi.stubEnv('THREAD_ONBOARDING_V2_ENABLED', 'true');
    const talk = conversation(db.database);
    for (const words of ['hi', 'M5V 2T6', 'Maya']) await talk.say(words);
    // No family yet: nothing can be kept, and nothing is.
    expect(await facts()).toEqual([]);

    await talk.say("she's 4");
    await talk.say('she swims on Saturdays');

    const [child] = await db.database.select().from(schema.children);
    const [parent] = await db.database.select().from(schema.users);
    const kept = await facts();
    expect(kept).toHaveLength(2);
    const profile = kept.find((row) => row.factKey === KID_PROFILE_FACT_KEY);
    const activity = kept.find((row) => row.factKey === 'kid-activity-swim-lessons');
    expect(profile).toMatchObject({
      childId: child?.id,
      factType: 'logistic',
      factValue: {
        schemaVersion: 1,
        kind: 'kid_profile',
        name: 'Maya',
        ageMonths: 48,
        agePrecision: 'years',
      },
      inferredBy: 'onboarding_thread_v2_record',
      sourceAudience: 'one_to_one',
      sourceUserId: parent?.id,
      memorySource: 'parent_message',
    });
    expect(activity).toMatchObject({
      childId: child?.id,
      factType: 'routine',
      factValue: {
        schemaVersion: 1,
        kind: 'kid_activity',
        activity: 'swim lessons',
        when: 'Saturdays',
      },
      inferredBy: 'onboarding_thread_v2',
      sourceAudience: 'one_to_one',
      sourceUserId: parent?.id,
      memorySource: 'parent_message',
    });
    // The activity's value never carries the kid's name: the row points at the child.
    expect(JSON.stringify(activity?.factValue)).not.toContain('Maya');

    const kidsKept = await audited('onboarding_kids_kept');
    expect(kidsKept.map((row) => row.after)).toEqual([{ count: 1 }]);
    const activitiesKept = await audited('onboarding_activities_kept');
    expect(activitiesKept.map((row) => row.after)).toEqual([{ count: 1, linked: 1 }]);
  });

  it('lit, a corrected age moves the record and the memory together', async () => {
    vi.stubEnv('THREAD_ONBOARDING_V2_ENABLED', 'true');
    const talk = conversation(db.database, (input) => {
      const turn = v2Turn(input);
      if (input.parentWords !== 'actually she is 5') return turn;
      return {
        ...turn,
        capture: {
          ...turn.capture,
          children: [{ name: 'Maya', ageMonths: 60, agePrecision: 'years' as const }],
        },
      };
    });
    for (const words of ['hi', 'M5V 2T6', 'Maya', "she's 4"]) await talk.say(words);
    await talk.say('actually she is 5');

    const rows = (await facts()).filter((row) => row.factKey === KID_PROFILE_FACT_KEY);
    const live = rows.filter((row) => row.validUntil === null);
    expect(live).toHaveLength(1);
    expect(live[0]?.factValue).toMatchObject({ name: 'Maya', ageMonths: 60 });
    expect(rows.find((row) => row.validUntil !== null)?.factValue).toMatchObject({
      ageMonths: 48,
    });
  });

  it('lit, "nothing yet" keeps no activity', async () => {
    vi.stubEnv('THREAD_ONBOARDING_V2_ENABLED', 'true');
    const talk = conversation(db.database);
    for (const words of ['hi', 'M5V 2T6', 'Maya', "she's 4", 'nothing yet']) await talk.say(words);
    const keys = (await facts()).map((row) => row.factKey);
    expect(keys).toEqual([KID_PROFILE_FACT_KEY]);
    expect(await audited('onboarding_activities_kept')).toEqual([]);
  });

  it('dark, the kids stay in the record and nothing new is kept', async () => {
    const talk = conversation(db.database);
    for (const words of ['hi', 'M5V 2T6', 'Maya', "she's 4"]) await talk.say(words);
    const [child] = await db.database.select().from(schema.children);
    expect(child?.name).toBe('Maya');
    expect(await facts()).toEqual([]);
    expect(await audited('onboarding_kids_kept')).toEqual([]);
  });
});
