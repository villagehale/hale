import { schema } from '@hale/db';
import { deriveStage } from '@hale/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sendWelcomeEmail } from './send-welcome';
import { type WelcomeContent, type WelcomeEmailSender, stagePhrase } from './welcome-email';

// sendWelcomeEmail is the idempotent orchestration around the welcome sender: it
// refuses to re-send when a prior 'welcome' row exists, builds the personalized
// (non-PII) copy from persisted rows — the users name fallback, the family's
// coarse area, and each child's stage derived from a DOB — mints the CASL
// unsubscribe link, sends through the injected sender, and records the accepted
// send. We fake the exact Drizzle reads/writes it runs; no real DB or Resend.

const USER_ID = '22222222-2222-4222-8222-222222222222';
const FAMILY_ID = '33333333-3333-4333-8333-333333333333';
const EMAIL = 'parent@example.com';

interface Capture {
  emailSends: unknown[];
}

interface Rows {
  priorWelcome: boolean;
  /** users.name row (the session-name fallback source). */
  userName?: string | null;
  areaCoarse?: string | null;
  city?: string | null;
  /** children.date_of_birth values (stage is derived from these). */
  childDobs?: string[];
}

/** Fake db: table-aware reads (prior-send, users name, family area, child DOBs)
 * and a captured email_sends insert. A where() result is awaitable directly (the
 * children read) or via .limit() (the single-row reads). */
function fakeDb(args: { rows: Rows; capture: Capture }) {
  function rowsFor(table: unknown): unknown[] {
    if (table === schema.emailSends) return args.rows.priorWelcome ? [{ id: 'prev' }] : [];
    if (table === schema.users) return [{ name: args.rows.userName ?? null }];
    if (table === schema.families)
      return [{ areaCoarse: args.rows.areaCoarse ?? null, city: args.rows.city ?? null }];
    if (table === schema.children)
      return (args.rows.childDobs ?? []).map((dateOfBirth) => ({ dateOfBirth }));
    throw new Error(`unexpected select from ${String(table)}`);
  }

  const select = vi.fn(() => ({
    from: (table: unknown) => {
      const result = () => rowsFor(table);
      const whereResult = {
        limit: async () => result(),
        // biome-ignore lint/suspicious/noThenProperty: the children read awaits where() directly
        then: (resolve: (v: unknown[]) => unknown) => resolve(result()),
      };
      return { where: () => whereResult };
    },
  }));
  const insert = vi.fn((table: unknown) => ({
    values: async (values: unknown) => {
      if (table === schema.emailSends) {
        args.capture.emailSends.push(values);
      }
    },
  }));
  return { select, insert } as never;
}

function fakeSender(accepted = true): {
  sender: WelcomeEmailSender;
  send: ReturnType<typeof vi.fn>;
} {
  const send = vi.fn(async () => ({
    accepted,
    providerMessageId: accepted ? 'resend-welcome-1' : null,
  }));
  return { sender: { sendWelcome: send }, send };
}

/** The WelcomeContent the sender was called with. */
function contentOf(send: ReturnType<typeof vi.fn>): WelcomeContent {
  return (send.mock.calls[0] as [string, WelcomeContent, string])[1];
}

beforeEach(() => {
  vi.stubEnv('UNSUBSCRIBE_SECRET', 'test-unsub-secret');
  vi.stubEnv('APP_URL', 'https://app.example.com');
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('sendWelcomeEmail', () => {
  it('sends once, greets by first name, and records the ledger row keyed to the user', async () => {
    const capture: Capture = { emailSends: [] };
    const db = fakeDb({ rows: { priorWelcome: false }, capture });
    const { sender, send } = fakeSender();

    const result = await sendWelcomeEmail(
      db,
      { userId: USER_ID, familyId: FAMILY_ID, email: EMAIL, name: 'Avery Q' },
      { email: sender },
    );

    expect(result).toEqual({ status: 'sent' });
    expect(send).toHaveBeenCalledTimes(1);
    const [to, content, unsubUrl] = send.mock.calls[0] as [string, WelcomeContent, string];
    expect(to).toBe(EMAIL);
    // First given-name token, derived from the full session name.
    expect(content.firstName).toBe('Avery');
    expect(new URL(unsubUrl).searchParams.get('t')).toBe('welcome');
    expect(capture.emailSends).toHaveLength(1);
    expect(capture.emailSends[0]).toMatchObject({
      userId: USER_ID,
      familyId: FAMILY_ID,
      emailType: 'welcome',
      recipient: EMAIL,
      providerMessageId: 'resend-welcome-1',
    });
  });

  it('falls back to users.name when the session carries no name (mobile bridge)', async () => {
    // The reported "Hi," bug: on the mobile path the session name is null. The
    // persisted users.name is the source of truth for the greeting.
    const capture: Capture = { emailSends: [] };
    const db = fakeDb({ rows: { priorWelcome: false, userName: 'Barton Dong' }, capture });
    const { sender, send } = fakeSender();

    const result = await sendWelcomeEmail(
      db,
      { userId: USER_ID, familyId: FAMILY_ID, email: EMAIL, name: null },
      { email: sender },
    );

    expect(result).toEqual({ status: 'sent' });
    expect(contentOf(send).firstName).toBe('Barton');
  });

  it('greets "there" (never a bare "Hi,") when no name is known anywhere', async () => {
    const capture: Capture = { emailSends: [] };
    const db = fakeDb({ rows: { priorWelcome: false, userName: null }, capture });
    const { sender, send } = fakeSender();

    await sendWelcomeEmail(
      db,
      { userId: USER_ID, familyId: FAMILY_ID, email: EMAIL, name: null },
      { email: sender },
    );

    expect(contentOf(send).firstName).toBe('there');
  });

  it('derives a neighbourhood place from a coarse FSA — never a child name or DOB', async () => {
    const dob = '2024-03-15';
    const capture: Capture = { emailSends: [] };
    const db = fakeDb({ rows: { priorWelcome: false, areaCoarse: 'L4C', childDobs: [dob] }, capture });
    const { sender, send } = fakeSender();

    await sendWelcomeEmail(
      db,
      { userId: USER_ID, familyId: FAMILY_ID, email: EMAIL, name: 'Avery' },
      { email: sender },
    );

    const content = contentOf(send);
    expect(content.place).toBe('your neighbourhood');
    // The stage phrase matches the child's derived stage (spec-derived, not
    // wall-clock-pinned); the DOB itself never appears in the content.
    expect(content.stage).toBe(stagePhrase([deriveStage(dob)]));
    expect(content.stage).not.toBeNull();
    expect(JSON.stringify(content)).not.toContain(dob);
  });

  it('derives an "around {city}" place from the city when no FSA is set', async () => {
    const capture: Capture = { emailSends: [] };
    const db = fakeDb({
      rows: { priorWelcome: false, areaCoarse: null, city: 'Toronto', childDobs: ['2015-01-01'] },
      capture,
    });
    const { sender, send } = fakeSender();

    await sendWelcomeEmail(
      db,
      { userId: USER_ID, familyId: FAMILY_ID, email: EMAIL, name: 'Avery' },
      { email: sender },
    );

    expect(contentOf(send).place).toBe('around Toronto');
  });

  it('does NOT re-send when a prior welcome row exists (idempotent)', async () => {
    const capture: Capture = { emailSends: [] };
    const db = fakeDb({ rows: { priorWelcome: true }, capture });
    const { sender, send } = fakeSender();

    const result = await sendWelcomeEmail(
      db,
      { userId: USER_ID, familyId: FAMILY_ID, email: EMAIL, name: 'Avery' },
      { email: sender },
    );

    expect(result).toEqual({ status: 'already_sent' });
    expect(send).not.toHaveBeenCalled();
    expect(capture.emailSends).toEqual([]);
  });

  it('does NOT record a ledger row when the provider rejects the send', async () => {
    const capture: Capture = { emailSends: [] };
    const db = fakeDb({ rows: { priorWelcome: false }, capture });
    const { sender, send } = fakeSender(false);

    const result = await sendWelcomeEmail(
      db,
      { userId: USER_ID, familyId: FAMILY_ID, email: EMAIL, name: 'Avery' },
      { email: sender },
    );

    // A rejected send leaves NO welcome row, so a later attempt can retry.
    expect(result).toEqual({ status: 'send_failed' });
    expect(send).toHaveBeenCalledTimes(1);
    expect(capture.emailSends).toEqual([]);
  });

  it('skips (no send) when no unsubscribe secret is configured to mint the CASL link', async () => {
    vi.stubEnv('UNSUBSCRIBE_SECRET', '');
    const capture: Capture = { emailSends: [] };
    const db = fakeDb({ rows: { priorWelcome: false }, capture });
    const { sender, send } = fakeSender();

    const result = await sendWelcomeEmail(
      db,
      { userId: USER_ID, familyId: FAMILY_ID, email: EMAIL, name: 'Avery' },
      { email: sender },
    );

    expect(result).toEqual({ status: 'skipped', reason: 'no_unsub_secret' });
    expect(send).not.toHaveBeenCalled();
    expect(capture.emailSends).toEqual([]);
  });
});
