import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUSINESS_ADDRESS } from '~/lib/cron/email-compliance';
import { createWelcomeEmailSender } from './welcome-email';

// The welcome email is transactional, so unlike the daily brief it is NOT held
// behind DIGEST_SEND_ENABLED and uses the warm aloha@ sender. We drive the
// provider through a fake Resend client (mocking the HTTP send is fine; the LLM
// is not involved here) and assert the wire payload: the from-identity, the
// recipient, and a body carrying the CASL footer (business address +
// unsubscribe) and the three concrete next steps.

const UNSUB_URL = 'https://app.example.com/unsubscribe?u=u1&t=welcome&sig=abc';

interface SendPayload {
  from: string;
  to: string;
  bcc?: string;
  subject: string;
  html: string;
  text: string;
}

function fakeResend() {
  const send = vi.fn(async (_payload: SendPayload) => ({
    data: { id: 'resend-welcome-1' },
    error: null,
  }));
  return { client: { emails: { send } } as never, send };
}

beforeEach(() => {
  vi.stubEnv('RESEND_API_KEY', 'test-key');
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('createWelcomeEmailSender', () => {
  it('sends from the warm aloha identity by default', async () => {
    const { client, send } = fakeResend();
    const sender = createWelcomeEmailSender(client);

    const result = await sender.sendWelcome('parent@example.com', 'Avery', UNSUB_URL);

    expect(result).toEqual({ accepted: true, providerMessageId: 'resend-welcome-1' });
    const payload = send.mock.calls[0]?.[0] as SendPayload;
    expect(payload.from).toBe('Hale <aloha@villagehale.com>');
    expect(payload.to).toBe('parent@example.com');
    expect(payload.subject.length).toBeGreaterThan(0);
  });

  it('renders the CASL footer (Georgetown address + working unsubscribe) in both parts', async () => {
    const { client, send } = fakeResend();
    const sender = createWelcomeEmailSender(client);

    await sender.sendWelcome('parent@example.com', 'Avery', UNSUB_URL);

    const payload = send.mock.calls[0]?.[0] as SendPayload;
    for (const part of [payload.html, payload.text]) {
      expect(part).toContain('Georgetown, ON L7G 4S8');
      expect(part).toContain(BUSINESS_ADDRESS);
    }
    // The text part carries the URL verbatim; the HTML part carries it inside an
    // href with the ampersands HTML-escaped (an unescaped & in markup is invalid).
    expect(payload.text).toContain(UNSUB_URL);
    expect(payload.html).toContain(UNSUB_URL.replace(/&/g, '&amp;'));
  });

  it('personalizes with the first name and lists the three next steps with their links', async () => {
    const { client, send } = fakeResend();
    const sender = createWelcomeEmailSender(client);

    await sender.sendWelcome('parent@example.com', 'Avery', UNSUB_URL);

    const payload = send.mock.calls[0]?.[0] as SendPayload;
    expect(payload.text).toContain('Avery');
    for (const part of [payload.html, payload.text]) {
      expect(part).toContain('https://app.villagehale.com/home');
      expect(part).toContain('https://app.villagehale.com/village');
      expect(part).toContain('https://app.villagehale.com/family');
    }
    // The HTML is the branded layout (Prussian header band), not the old plain
    // body: it carries the header heading and the warm Prussian + linen tokens.
    expect(payload.html).toContain('Welcome to your village.');
    expect(payload.html).toContain('#01204F');
    expect(payload.html).toContain('#f6f1e7');
  });

  it('greets without a name when none is known', async () => {
    const { client, send } = fakeResend();
    const sender = createWelcomeEmailSender(client);

    await sender.sendWelcome('parent@example.com', null, UNSUB_URL);

    const payload = send.mock.calls[0]?.[0] as SendPayload;
    // No "Hi ," dangling comma when the name is absent.
    expect(payload.text).not.toContain('Hi ,');
  });

  it('reports not-accepted (does not throw) when the provider returns an error', async () => {
    const send = vi.fn(async () => ({ data: null, error: { message: 'rejected' } }));
    const sender = createWelcomeEmailSender({ emails: { send } } as never);

    const result = await sender.sendWelcome('parent@example.com', 'Avery', UNSUB_URL);

    expect(result).toEqual({ accepted: false, providerMessageId: null });
  });

  it('skips (no send) when RESEND_API_KEY is unset and no client injected', async () => {
    vi.stubEnv('RESEND_API_KEY', '');
    const sender = createWelcomeEmailSender();

    const result = await sender.sendWelcome('parent@example.com', 'Avery', UNSUB_URL);

    expect(result).toEqual({ accepted: false, providerMessageId: null });
  });

  it('BCCs the founder copy when WELCOME_BCC is set (new-signup signal)', async () => {
    vi.stubEnv('WELCOME_BCC', 'barton@villagehale.com');
    const { client, send } = fakeResend();
    const sender = createWelcomeEmailSender(client);

    await sender.sendWelcome('parent@example.com', 'Avery', UNSUB_URL);

    const payload = send.mock.calls[0]?.[0] as SendPayload;
    expect(payload.bcc).toBe('barton@villagehale.com');
  });

  it('omits bcc when WELCOME_BCC is unset', async () => {
    const { client, send } = fakeResend();
    const sender = createWelcomeEmailSender(client);

    await sender.sendWelcome('parent@example.com', 'Avery', UNSUB_URL);

    const payload = send.mock.calls[0]?.[0] as SendPayload;
    expect(payload.bcc).toBeUndefined();
  });
});
