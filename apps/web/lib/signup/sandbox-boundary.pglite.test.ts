import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type TestDb, createTestDb, seedChild, seedFamily } from '~/lib/testing/pglite';
import { runAuthorizedSignup } from './run';
import { recordSignupOffer } from './store';
import type { FieldSlot, PageControl, PageSnapshot, SignupBrowser, SignupPage } from './types';

/**
 * VIL-387. The sandbox is the SignupBrowser. authorizeSignup, planBookingStep,
 * and the stop rules run in the backend. The browser receives a URL and then
 * control-name / value pairs.
 *
 * A durable slot grant (draft PR #725, authorized_signup_consents) is not on
 * main. The closed FieldSlot set is the list this runner may type. When that
 * grant lands, also assert the typed values are a subset of the stored slot
 * names and that a missing grant never calls fill.
 */

const NOW = new Date('2026-09-29T15:00:00.000Z');
const ORIGIN = 'http://127.0.0.1';
const SECRET_LAST_NAME = 'tok_sandbox_secret';
const POSTAL = 'M5V2T6';

/** Every slot the backend is willing to type. A new FieldSlot fails this file until it is listed. */
const CONSENTED_SLOTS: Record<FieldSlot, true> = {
  child_first_name: true,
  child_last_name: true,
  child_dob: true,
  parent_first_name: true,
  parent_email: true,
  postal_code: true,
  session: true,
  visit_date: true,
  party_size: true,
  seating_note: true,
};

const CREDENTIAL =
  /password|token|secret|bearer|authorization|cookie|api[-_ ]?key|credential|otp|cvv|csrf|sk_live/i;

interface Call {
  method: string;
  args: readonly unknown[];
}

function control(
  name: string,
  type: string,
  label: string,
  required: boolean,
  options: PageControl['options'] = [],
): PageControl {
  return { name, type, required, label, autocomplete: null, options };
}

function classForm(extra: PageControl[]): PageSnapshot {
  return {
    href: `${ORIGIN}/register`,
    captcha: false,
    confirmed: false,
    priceCents: [],
    formText: 'Parent and tot swim',
    waitingRoom: false,
    controls: [
      control('child_first_name', 'text', 'Child first name', true),
      control('parent_email', 'email', 'Parent email', true),
      control('postal_code', 'text', 'Postal code', true),
      control('session', 'select', 'Session', true, [
        { value: 'tue-1630', label: 'Tue 4:30', disabled: false },
      ]),
      ...extra,
    ],
  };
}

function recordingBrowser(first: PageSnapshot, afterSubmit?: PageSnapshot) {
  const calls: Call[] = [];
  const browser: SignupBrowser = {
    async open(url: string): Promise<SignupPage> {
      calls.push({ method: 'open', args: [url] });
      let submitted = false;
      return {
        async snapshot() {
          calls.push({ method: 'snapshot', args: [] });
          return submitted && afterSubmit ? afterSubmit : first;
        },
        async fill(name: string, value: string) {
          calls.push({ method: 'fill', args: [name, value] });
        },
        async select(name: string, value: string) {
          calls.push({ method: 'select', args: [name, value] });
        },
        async continue() {
          calls.push({ method: 'continue', args: [] });
        },
        async submit() {
          calls.push({ method: 'submit', args: [] });
          submitted = true;
        },
        async close() {
          calls.push({ method: 'close', args: [] });
        },
      };
    },
  };
  return { browser, calls };
}

describe('sandbox boundary — browser input is consented slots only', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(async () => {
    await db.close();
  });

  beforeEach(() => {
    vi.stubEnv('AUTHORIZED_SIGNUP_ENABLED', 'on');
  });

  async function familyWithOffer() {
    const seeded = await seedFamily(db.database);
    await db.database
      .update(schema.families)
      .set({ postalCode: POSTAL })
      .where(eq(schema.families.id, seeded.familyId));
    const childId = await seedChild(db.database, seeded.familyId, 'Ada', 36, undefined, NOW);
    await db.database
      .update(schema.children)
      .set({ lastName: SECRET_LAST_NAME })
      .where(eq(schema.children.id, childId));
    const stored = await recordSignupOffer(db.database, {
      familyId: seeded.familyId,
      childId,
      parentUserId: seeded.parentUserId,
      activityKey: 'swim-parent-tot',
      registrationUrl: `${ORIGIN}/register`,
      sessions: [
        {
          id: 'tue-1630',
          label: 'Tue 4:30',
          startsAt: '2026-10-06T20:30:00.000Z',
          endsAt: '2026-10-06T21:15:00.000Z',
          full: false,
          priceCents: null,
        },
      ],
      approvedPriceCents: null,
      now: NOW,
    });
    expect(stored.ok).toBe(true);
    const [child] = await db.database
      .select({ dob: schema.children.dateOfBirth })
      .from(schema.children)
      .where(eq(schema.children.id, childId))
      .limit(1);
    if (!child?.dob) throw new Error('sandbox boundary: child has no date of birth');
    return { seeded, dob: child.dob, email: `${seeded.familyId}@example.test` };
  }

  function assertHandsOnly(calls: Call[], allowedValues: ReadonlySet<string>, dob: string) {
    const open = calls.filter((call) => call.method === 'open');
    expect(open).toEqual([{ method: 'open', args: [`${ORIGIN}/register`] }]);

    const typed = calls.filter((call) => call.method === 'fill' || call.method === 'select');
    expect(typed.length).toBeGreaterThan(0);
    for (const call of typed) {
      expect(call.args).toHaveLength(2);
      const name = call.args[0];
      const value = call.args[1];
      expect(typeof name).toBe('string');
      expect(typeof value).toBe('string');
      if (typeof name !== 'string' || typeof value !== 'string') continue;
      expect(Object.hasOwn(CONSENTED_SLOTS, name)).toBe(true);
      expect(name).not.toMatch(CREDENTIAL);
      expect(allowedValues.has(value)).toBe(true);
      expect(value).not.toMatch(CREDENTIAL);
    }

    const dumped = JSON.stringify(calls);
    expect(dumped).not.toContain(SECRET_LAST_NAME);
    expect(dumped).not.toContain(dob);
    expect(dumped).not.toContain('Test Parent');
    expect(dumped).not.toContain('sk_live');
    expect(dumped).not.toContain('Bearer');
  }

  it('types only consented slot values and never a token field', async () => {
    const { seeded, dob, email } = await familyWithOffer();
    const form = classForm([
      control('api_token', 'text', 'API token', false),
      control('csrf_token', 'hidden', 'CSRF token', false),
    ]);
    const { browser, calls } = recordingBrowser(form, { ...form, confirmed: true });
    const result = await runAuthorizedSignup(
      db.database,
      {
        familyId: seeded.familyId,
        parentUserId: seeded.parentUserId,
        body: 'Yes, sign us up',
        inboundChannelMessageId: null,
        existingThread: true,
        now: NOW,
      },
      { browser },
    );

    expect(result.outcome).toBe('completed');
    assertHandsOnly(calls, new Set(['Ada', email, POSTAL, 'tue-1630']), dob);
    const names = calls
      .filter((call) => call.method === 'fill' || call.method === 'select')
      .map((call) => call.args[0]);
    expect(names).not.toContain('api_token');
    expect(names).not.toContain('csrf_token');
  });

  it('does not fill a password field', async () => {
    const { seeded, dob } = await familyWithOffer();
    const form = classForm([control('password', 'password', 'Password', true)]);
    const { browser, calls } = recordingBrowser(form);
    const result = await runAuthorizedSignup(
      db.database,
      {
        familyId: seeded.familyId,
        parentUserId: seeded.parentUserId,
        body: 'Yes, sign us up',
        inboundChannelMessageId: null,
        existingThread: true,
        now: NOW,
      },
      { browser },
    );

    expect(result.outcome).toBe('login_wall');
    expect(calls.filter((call) => call.method === 'fill' || call.method === 'select')).toEqual([]);
    expect(calls.filter((call) => call.method === 'open')).toEqual([
      { method: 'open', args: [`${ORIGIN}/register`] },
    ]);
    const dumped = JSON.stringify(calls);
    expect(dumped).not.toContain(SECRET_LAST_NAME);
    expect(dumped).not.toContain(dob);
    expect(dumped).not.toContain('password');
  });
});
