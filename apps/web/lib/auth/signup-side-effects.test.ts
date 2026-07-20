import { schema } from '@hale/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatchSignupSideEffects } from './signup-side-effects';

// The side-effects fired the moment a credentials account is created, BEFORE
// onboarding: (1) the founder new-signup signal, (2) the verification-send ledger
// row, (3) the server-side signup_completed analytics event. All three are
// best-effort — none may throw out of the dispatcher, so a failing signal can never
// break sign-up. Deps are injected so no real DB / Resend / PostHog is touched.

const USER_ID = '44444444-4444-4444-8444-444444444444';
const EMAIL = 'new@example.com';
const VERIFY_URL = 'https://app.example.com/verify?token=abc';

interface Capture {
  emailSends: unknown[];
}

function fakeDb(capture: Capture) {
  const insert = vi.fn((table: unknown) => ({
    values: async (values: unknown) => {
      if (table === schema.emailSends) {
        capture.emailSends.push(values);
      }
    },
  }));
  return { insert } as never;
}

function fakeDeps(overrides: {
  ensureUserId?: () => Promise<string>;
  notifySignup?: ReturnType<typeof vi.fn>;
  sendVerification?: ReturnType<typeof vi.fn>;
  capture?: ReturnType<typeof vi.fn>;
}) {
  return {
    ensureUserId: overrides.ensureUserId ?? (async () => USER_ID),
    founder: {
      notifySignup: overrides.notifySignup ?? vi.fn(async () => true),
    },
    verifier: {
      sendVerification:
        overrides.sendVerification ??
        vi.fn(async () => ({ accepted: true, providerMessageId: 'resend-verify-1' })),
      sendReset: vi.fn(),
      sendMagicLink: vi.fn(),
    },
    captureServerEvent: overrides.capture ?? vi.fn(async () => {}),
  };
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('dispatchSignupSideEffects', () => {
  it('dispatches the founder new-signup signal with the new account email', async () => {
    const capture: Capture = { emailSends: [] };
    const notifySignup = vi.fn(async () => true);
    const deps = fakeDeps({ notifySignup });

    await dispatchSignupSideEffects(
      { db: fakeDb(capture), email: EMAIL, verifyUrl: VERIFY_URL },
      deps,
    );

    expect(notifySignup).toHaveBeenCalledTimes(1);
    expect(notifySignup).toHaveBeenCalledWith(EMAIL);
  });

  it('does NOT throw (sign-up unaffected) when the founder signal fails', async () => {
    const capture: Capture = { emailSends: [] };
    const notifySignup = vi.fn(async () => {
      throw new Error('resend down');
    });
    const capServer = vi.fn(async () => {});
    const deps = fakeDeps({ notifySignup, capture: capServer });

    await expect(
      dispatchSignupSideEffects(
        { db: fakeDb(capture), email: EMAIL, verifyUrl: VERIFY_URL },
        deps,
      ),
    ).resolves.toBeUndefined();
    // The other side-effects still ran despite the founder-signal failure.
    expect(capServer).toHaveBeenCalledTimes(1);
    expect(capture.emailSends).toHaveLength(1);
  });

  it("records a 'verification' email_sends row keyed to the new user on an accepted send", async () => {
    const capture: Capture = { emailSends: [] };
    const sendVerification = vi.fn(async () => ({
      accepted: true,
      providerMessageId: 'resend-verify-1',
    }));
    const deps = fakeDeps({ sendVerification });

    await dispatchSignupSideEffects(
      { db: fakeDb(capture), email: EMAIL, verifyUrl: VERIFY_URL },
      deps,
    );

    expect(sendVerification).toHaveBeenCalledWith(EMAIL, VERIFY_URL);
    expect(capture.emailSends).toHaveLength(1);
    expect(capture.emailSends[0]).toMatchObject({
      userId: USER_ID,
      familyId: null,
      emailType: 'verification',
      recipient: EMAIL,
      providerMessageId: 'resend-verify-1',
    });
  });

  it('does NOT record a verification row when the provider rejects the send', async () => {
    const capture: Capture = { emailSends: [] };
    const sendVerification = vi.fn(async () => ({ accepted: false, providerMessageId: null }));
    const deps = fakeDeps({ sendVerification });

    await dispatchSignupSideEffects(
      { db: fakeDb(capture), email: EMAIL, verifyUrl: VERIFY_URL },
      deps,
    );

    expect(capture.emailSends).toEqual([]);
  });

  it('fires signup_completed server-side keyed to the new user id (outcome, not intent)', async () => {
    const capture: Capture = { emailSends: [] };
    const capServer = vi.fn(async () => {});
    const deps = fakeDeps({ capture: capServer });

    await dispatchSignupSideEffects(
      { db: fakeDb(capture), email: EMAIL, verifyUrl: VERIFY_URL },
      deps,
    );

    expect(capServer).toHaveBeenCalledTimes(1);
    expect(capServer).toHaveBeenCalledWith('signup_completed', USER_ID, { method: 'email' });
  });
});
