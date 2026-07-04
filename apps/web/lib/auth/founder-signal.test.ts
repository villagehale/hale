import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFounderSignupNotifier } from './founder-signal';

// The founder new-signup signal: a lightweight internal alert emitted the moment a
// real account is created, so the founder learns of EVERY join (not just onboarding
// completions). It reuses the shared Resend from-identity and injects the client so
// the send is testable without a live account. Privacy (rule #1): the new user's
// email is the ONLY payload — no other PII.

const SIGNUP_EMAIL = 'newparent@example.com';

interface SendPayload {
  to: string;
  from: string;
  subject: string;
  text: string;
}

function fakeResend() {
  const send = vi.fn(async (_payload: SendPayload) => ({
    data: { id: 'resend-founder-1' },
    error: null,
  }));
  return { emails: { send } } as never;
}

/** The typed send mock behind the `as never` fake client. */
function sendOf(client: unknown): Mock<(payload: SendPayload) => Promise<unknown>> {
  return (client as { emails: { send: Mock<(payload: SendPayload) => Promise<unknown>> } }).emails
    .send;
}

beforeEach(() => {
  vi.stubEnv('RESEND_API_KEY', 'test-key');
  vi.stubEnv('FOUNDER_ALERT_EMAIL', '');
  vi.stubEnv('WELCOME_BCC', '');
  vi.stubEnv('WELCOME_FROM', '');
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('createFounderSignupNotifier', () => {
  it('sends the founder a new-signup alert to FOUNDER_ALERT_EMAIL carrying only the email', async () => {
    vi.stubEnv('FOUNDER_ALERT_EMAIL', 'founder@villagehale.com');
    const client = fakeResend();

    const sent = await createFounderSignupNotifier(client).notifySignup(SIGNUP_EMAIL);

    expect(sent).toBe(true);
    const send = sendOf(client);
    expect(send).toHaveBeenCalledTimes(1);
    const payload = send.mock.calls[0]?.[0];
    expect(payload?.to).toBe('founder@villagehale.com');
    // The signup email is the whole point of the signal — it must appear.
    expect(payload?.subject).toContain(SIGNUP_EMAIL);
    // No PII beyond the email itself: the only address in the body is the signup one.
    expect(payload?.text).toContain(SIGNUP_EMAIL);
  });

  it('falls back to WELCOME_BCC when FOUNDER_ALERT_EMAIL is unset', async () => {
    vi.stubEnv('WELCOME_BCC', 'founder-bcc@villagehale.com');
    const client = fakeResend();

    await createFounderSignupNotifier(client).notifySignup(SIGNUP_EMAIL);

    const payload = sendOf(client).mock.calls[0]?.[0];
    expect(payload?.to).toBe('founder-bcc@villagehale.com');
  });

  it('does NOT send (no throw) when no founder address is configured', async () => {
    const client = fakeResend();

    const sent = await createFounderSignupNotifier(client).notifySignup(SIGNUP_EMAIL);

    expect(sent).toBe(false);
    expect(sendOf(client)).not.toHaveBeenCalled();
  });

  it('does NOT send when RESEND_API_KEY is unset and no client is injected', async () => {
    vi.stubEnv('RESEND_API_KEY', '');
    vi.stubEnv('FOUNDER_ALERT_EMAIL', 'founder@villagehale.com');

    const sent = await createFounderSignupNotifier().notifySignup(SIGNUP_EMAIL);

    expect(sent).toBe(false);
  });
});
