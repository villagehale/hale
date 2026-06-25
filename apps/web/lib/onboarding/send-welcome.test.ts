import { schema } from '@hale/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sendWelcomeEmail } from './send-welcome';
import type { WelcomeEmailSender } from './welcome-email';

// sendWelcomeEmail is the idempotent orchestration around the welcome sender: it
// refuses to re-send when a prior 'welcome' row exists, mints the CASL
// unsubscribe link, sends through the injected sender, and records the accepted
// send (the row that makes the next call a no-op). We fake the exact Drizzle
// chains it runs — the prior-send select and the ledger insert — and a fake
// sender; no real DB or Resend.

const USER_ID = '22222222-2222-4222-8222-222222222222';
const FAMILY_ID = '33333333-3333-4333-8333-333333333333';
const EMAIL = 'parent@example.com';

interface Capture {
  emailSends: unknown[];
}

/** Fake db: the prior-send select returns `priorWelcome` rows; the email_sends
 * insert is captured. */
function fakeDb(args: { priorWelcome: boolean; capture: Capture }) {
  const select = vi.fn(() => ({
    from: (table: unknown) => {
      if (table === schema.emailSends) {
        return {
          where: () => ({ limit: async () => (args.priorWelcome ? [{ id: 'prev' }] : []) }),
        };
      }
      throw new Error(`unexpected select from ${String(table)}`);
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

beforeEach(() => {
  vi.stubEnv('UNSUBSCRIBE_SECRET', 'test-unsub-secret');
  vi.stubEnv('APP_URL', 'https://app.example.com');
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('sendWelcomeEmail', () => {
  it('sends once and records the welcome ledger row keyed to the user', async () => {
    const capture: Capture = { emailSends: [] };
    const db = fakeDb({ priorWelcome: false, capture });
    const { sender, send } = fakeSender();

    const result = await sendWelcomeEmail(
      db,
      { userId: USER_ID, familyId: FAMILY_ID, email: EMAIL, name: 'Avery Q' },
      { email: sender },
    );

    expect(result).toEqual({ status: 'sent' });
    // The sender saw the recipient, the first name (derived from the full name),
    // and a real unsubscribe URL for the welcome stream.
    expect(send).toHaveBeenCalledTimes(1);
    const [to, firstName, unsubUrl] = send.mock.calls[0] as [string, string, string];
    expect(to).toBe(EMAIL);
    expect(firstName).toBe('Avery');
    expect(new URL(unsubUrl).searchParams.get('t')).toBe('welcome');
    // The accepted send is recorded as a 'welcome' row (the idempotency anchor).
    expect(capture.emailSends).toHaveLength(1);
    expect(capture.emailSends[0]).toMatchObject({
      userId: USER_ID,
      familyId: FAMILY_ID,
      emailType: 'welcome',
      recipient: EMAIL,
      providerMessageId: 'resend-welcome-1',
    });
  });

  it('does NOT re-send when a prior welcome row exists (idempotent)', async () => {
    const capture: Capture = { emailSends: [] };
    const db = fakeDb({ priorWelcome: true, capture });
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
    const db = fakeDb({ priorWelcome: false, capture });
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
    const db = fakeDb({ priorWelcome: false, capture });
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
