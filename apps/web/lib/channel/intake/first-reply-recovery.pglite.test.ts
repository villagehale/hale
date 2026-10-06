import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { PostgresRateLimiter } from '~/lib/rate-limit/postgres';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { type FirstReplyRecoveryDeps, runFirstReplyRecoveryCron } from './first-reply-recovery';
import {
  type FriendVoiceComposer,
  type FriendVoiceInput,
  friendVoiceContext,
} from './friend-voice';
import { loadOpenSession } from './session';
import { FakeTransport } from './transport';

/**
 * A first text that got no reply is recoverable by construction: an open pre-family
 * session whose transcript holds an inbound and no outbound is owed one reply, whatever
 * state the turn left it in. Against the real DDL because the window, the minimum age
 * and the claim are all SQL.
 */

const KEY = Buffer.alloc(32, 7).toString('base64');
/** Tuesday 6 Oct 2026, 2:00 p.m. Toronto. */
const NOW = new Date('2026-10-06T18:00:00.000Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

let db: TestDb;
let phones = 0;

beforeAll(async () => {
  process.env.APP_ENCRYPTION_KEY = KEY;
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(() => {
  process.env.APP_ENCRYPTION_KEY = KEY;
  vi.stubEnv('ONBOARDING_FRIEND_VOICE_ENABLED', 'on');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await db.exec('truncate table sms_intake_sessions, rate_limits cascade');
});

interface Seed {
  state?: string;
  createdAt?: Date;
  updatedAt?: Date;
  transcript?: Array<{ direction: 'in' | 'out'; body: string }>;
  place?: { city: string; areaCoarse: string; postalCode: string } | null;
}

async function seed(over: Seed = {}): Promise<{ id: string; phone: string }> {
  phones += 1;
  const phone = `+1416555${String(4000 + phones)}`;
  const createdAt = over.createdAt ?? new Date(NOW.getTime() - 10 * MINUTE);
  const transcript = (over.transcript ?? [{ direction: 'in', body: 'hi' }]).map((entry, i) => ({
    ...entry,
    providerId: `msg-${phones}-${i}`,
    at: createdAt.toISOString(),
  }));
  const data = {
    collected: { children: [], postalCode: over.place?.postalCode ?? null },
    transcript,
    ladderLanguage: 'en',
    ...(over.place !== undefined
      ? {
          firstTouch: {
            language: 'en',
            place: over.place
              ? {
                  kind: 'postal',
                  areaCoarse: over.place.areaCoarse,
                  postalCode: over.place.postalCode,
                  municipality: 'toronto',
                  city: over.place.city,
                }
              : null,
            locationRequest: null,
          },
        }
      : {}),
  };
  const [row] = await db.database
    .insert(schema.smsIntakeSessions)
    .values({
      phoneHash: phoneBlindIndex(phone),
      phoneEncrypted: encryptString(phone),
      state: over.state ?? 'awaiting_place',
      dataEncrypted: encryptString(JSON.stringify(data)),
      lastProviderId: `msg-${phones}-0`,
      createdAt,
      updatedAt: over.updatedAt ?? createdAt,
    })
    .returning({ id: schema.smsIntakeSessions.id });
  if (!row) throw new Error('seed: no row');
  return { id: row.id, phone };
}

function composer(): FriendVoiceComposer & { inputs: FriendVoiceInput[] } {
  const inputs: FriendVoiceInput[] = [];
  return {
    inputs,
    async compose(input) {
      inputs.push(input);
      return {
        reply:
          input.step === 'ages'
            ? 'How old are your kids?'
            : "Hey, it's Hale. What's your postal code?",
      };
    },
  };
}

function deps(
  transport: FakeTransport,
  friendVoice: FriendVoiceComposer,
  over: Partial<FirstReplyRecoveryDeps> = {},
): FirstReplyRecoveryDeps {
  return {
    transport,
    friendVoice,
    limiter: new PostgresRateLimiter(db.database),
    preflight: async () => ({ proceed: true, health: null }),
    ...over,
  };
}

async function stamp(id: string): Promise<Date | null> {
  const [row] = await db.database
    .select({ at: schema.smsIntakeSessions.firstReplyRecoveredAt })
    .from(schema.smsIntakeSessions)
    .where(eq(schema.smsIntakeSessions.id, id));
  return row?.at ?? null;
}

describe('first-reply recovery reads the transcript, not the state', () => {
  it('sends ONE model-written reply to an awaiting_place session that heard nothing', async () => {
    const { id, phone } = await seed({ state: 'awaiting_place' });
    const transport = new FakeTransport();
    const voice = composer();

    await runFirstReplyRecoveryCron(db.database, deps(transport, voice), NOW);

    expect(transport.sent.map((message) => message.to)).toEqual([phone]);
    expect(transport.bodies()).toEqual(["Hey, it's Hale. What's your postal code?"]);
    expect(voice.inputs.map((input) => input.step)).toEqual(['place']);
    expect(await stamp(id)).toEqual(NOW);
    const session = await loadOpenSession(db.database, phone);
    expect(session?.transcript.map((entry) => entry.direction)).toEqual(['in', 'out']);
    expect(session?.state).toBe('awaiting_place');

    const second = await runFirstReplyRecoveryCron(db.database, deps(transport, voice), NOW);
    expect(second.sent).toBe(0);
    expect(transport.sent).toHaveLength(1);
  });

  it('asks the ages when the silent turn already stored a place', async () => {
    const { phone } = await seed({
      state: 'awaiting_details',
      place: { city: 'Toronto', areaCoarse: 'M5V', postalCode: 'M5V 2T6' },
    });
    const transport = new FakeTransport();
    const voice = composer();

    await runFirstReplyRecoveryCron(db.database, deps(transport, voice), NOW);

    expect(voice.inputs.map((input) => [input.step, input.placeLabel])).toEqual([
      ['ages', 'Toronto'],
    ]);
    expect(transport.bodies()).toEqual(['How old are your kids?']);
    expect((await loadOpenSession(db.database, phone))?.state).toBe('awaiting_ages');
  });

  it('leaves alone a session past the window, one too young, and one with no inbound yet', async () => {
    await seed({ createdAt: new Date(NOW.getTime() - 25 * HOUR) });
    await seed({ updatedAt: new Date(NOW.getTime() - 30_000) });
    await seed({ transcript: [] });
    await seed({
      transcript: [
        { direction: 'in', body: 'hi' },
        { direction: 'out', body: "Hey, it's Hale. What's your postal code?" },
      ],
    });
    const transport = new FakeTransport();
    const voice = composer();

    const result = await runFirstReplyRecoveryCron(db.database, deps(transport, voice), NOW);

    expect(result.sent).toBe(0);
    expect(voice.inputs).toEqual([]);
    expect(transport.sent).toEqual([]);
  });

  it('answers an 11:30 p.m. text at 8:00 a.m., and tells the model how long it waited', async () => {
    /** 11:30 p.m. America/Toronto, Fri 28 Aug 2026 (EDT). */
    const late = new Date('2026-08-29T03:30:00.000Z');
    /** 8:00 a.m. the next morning — quiet hours have just ended, and the text is 8.5h old. */
    const morning = new Date('2026-08-29T12:00:00.000Z');
    const { id, phone } = await seed({ createdAt: late, updatedAt: late });
    const transport = new FakeTransport();
    const voice = composer();

    const night = await runFirstReplyRecoveryCron(
      db.database,
      deps(transport, voice),
      new Date(late.getTime() + 3 * 60_000),
    );
    expect(night.sent).toBe(0);
    expect(voice.inputs).toEqual([]);
    expect(await stamp(id)).toBeNull();

    const answered = await runFirstReplyRecoveryCron(db.database, deps(transport, voice), morning);
    expect(answered.sent).toBe(1);
    expect(transport.sent.map((message) => message.to)).toEqual([phone]);
    const brief = voice.inputs[0];
    expect(brief).toBeDefined();
    if (!brief) return;
    expect(friendVoiceContext(brief)).toMatchObject({
      lastInbound: { minutesAgo: 8 * 60 + 30, overnight: true, yesterday: true },
    });
  });

  it('holds the whole tick while the provider pre-flight reports an incident', async () => {
    const { id } = await seed();
    const transport = new FakeTransport();
    const voice = composer();

    const result = await runFirstReplyRecoveryCron(
      db.database,
      deps(transport, voice, {
        preflight: async () => ({
          proceed: false,
          abort: { failure: 'billing', detail: 'credit balance too low', alerted: true },
        }),
      }),
      NOW,
    );

    expect(result.held).toMatchObject({ failure: 'billing', skipped: 1 });
    expect(voice.inputs).toEqual([]);
    expect(transport.sent).toEqual([]);
    expect(await stamp(id)).toBeNull();
  });

  it('pages #ops at most once a day for a row the model keeps failing, and keeps it owed', async () => {
    vi.stubEnv('OPS_SLACK_WEBHOOK_URL', 'https://hooks.slack.example/ops');
    const pages: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        pages.push(String(init?.body ?? ''));
        return new Response(null, { status: 200 });
      }),
    );
    const { id } = await seed();
    const transport = new FakeTransport();
    const failing: FriendVoiceComposer = {
      async compose() {
        throw new Error('model down');
      },
    };

    await runFirstReplyRecoveryCron(db.database, deps(transport, failing), NOW);
    await runFirstReplyRecoveryCron(
      db.database,
      deps(transport, failing),
      new Date(NOW.getTime() + 3 * MINUTE),
    );

    expect(transport.sent).toEqual([]);
    expect(pages).toHaveLength(1);
    expect(pages[0]).toContain('reason=model_failed');
    expect(pages[0]).not.toContain('voice_unavailable');
    expect(await stamp(id)).toBeNull();
  });
});
