import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUSINESS_ADDRESS } from '~/lib/cron/email-compliance';
import {
  type WelcomeContent,
  createWelcomeEmailSender,
  firstNameToken,
  placePhrase,
  stagePhrase,
} from './welcome-email';

// The welcome email is transactional, so unlike the daily brief it is NOT held
// behind DIGEST_SEND_ENABLED and uses the warm aloha@ sender. We drive the
// provider through a fake Resend client (mocking the HTTP send is fine; the LLM
// is not involved here) and assert the wire payload: the from-identity, the
// recipient, the CASL footer (business address + unsubscribe), the three next
// steps, and the design-system layout. The copy is personalized from a
// pre-derived, non-PII WelcomeContent — never a child name or DOB.

const UNSUB_URL = 'https://app.example.com/unsubscribe?u=u1&t=welcome&sig=abc';

/** A greeting-ready WelcomeContent; overrides tweak individual slots per test. */
function content(overrides: Partial<WelcomeContent> = {}): WelcomeContent {
  return { firstName: 'Avery', place: null, stage: null, voice: null, ...overrides };
}

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

describe('firstNameToken', () => {
  it('takes the first given-name token from a full name', () => {
    expect(firstNameToken('Barton Dong')).toBe('Barton');
  });
  it('falls back to "there" when no name is known (never a bare greeting)', () => {
    expect(firstNameToken(null)).toBe('there');
    expect(firstNameToken('   ')).toBe('there');
  });
});

describe('placePhrase', () => {
  it('reads an FSA-shaped area as the neighbourhood (rule #1: never the precise code)', () => {
    expect(placePhrase('L4C', null)).toBe('your neighbourhood');
    // The precise code must NOT leak into the copy.
    expect(placePhrase('L4C', 'Richmond Hill')).toBe('your neighbourhood');
    expect(placePhrase('L4C', null)).not.toContain('L4C');
  });
  it('reads a city name as "around {city}" when no FSA is set', () => {
    expect(placePhrase(null, 'Toronto')).toBe('around Toronto');
  });
  it('is null when neither a coarse area nor a city is known', () => {
    expect(placePhrase(null, null)).toBeNull();
  });
});

describe('stagePhrase', () => {
  it('derives a warm phrase from a single stage', () => {
    expect(stagePhrase(['newborn'])).toBe('those first months with your little one');
    expect(stagePhrase(['toddler'])).toBe('the toddler years');
    expect(stagePhrase(['teenager'])).toBe('the teenage years');
  });
  it('collapses mixed sibling stages to a general phrase', () => {
    expect(stagePhrase(['newborn', 'teenager'])).toBe('raising your kids');
  });
  it('is null with no children', () => {
    expect(stagePhrase([])).toBeNull();
  });
});

describe('createWelcomeEmailSender', () => {
  it('sends from the warm aloha identity by default', async () => {
    const { client, send } = fakeResend();
    const sender = createWelcomeEmailSender(client);

    const result = await sender.sendWelcome('parent@example.com', content(), UNSUB_URL);

    expect(result).toEqual({ accepted: true, providerMessageId: 'resend-welcome-1' });
    const payload = send.mock.calls[0]?.[0] as SendPayload;
    expect(payload.from).toBe('Hale <aloha@villagehale.com>');
    expect(payload.to).toBe('parent@example.com');
    expect(payload.subject.length).toBeGreaterThan(0);
  });

  it('renders the CASL footer (Georgetown address + working unsubscribe) in both parts', async () => {
    const { client, send } = fakeResend();
    const sender = createWelcomeEmailSender(client);

    await sender.sendWelcome('parent@example.com', content(), UNSUB_URL);

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

  it('greets by first name and lists the three next steps with their links', async () => {
    const { client, send } = fakeResend();
    const sender = createWelcomeEmailSender(client);

    await sender.sendWelcome('parent@example.com', content({ firstName: 'Barton' }), UNSUB_URL);

    const payload = send.mock.calls[0]?.[0] as SendPayload;
    expect(payload.text).toContain('Hi Barton,');
    for (const part of [payload.html, payload.text]) {
      expect(part).toContain('https://app.villagehale.com/home');
      expect(part).toContain('https://app.villagehale.com/village');
      expect(part).toContain('https://app.villagehale.com/family');
    }
  });

  it('weaves the coarse place + stage into the copy — but never a child name or DOB', async () => {
    const { client, send } = fakeResend();
    const sender = createWelcomeEmailSender(client);

    await sender.sendWelcome(
      'parent@example.com',
      content({ firstName: 'Barton', place: 'your neighbourhood', stage: 'the toddler years' }),
      UNSUB_URL,
    );

    const payload = send.mock.calls[0]?.[0] as SendPayload;
    for (const part of [payload.html, payload.text]) {
      expect(part).toContain('your neighbourhood');
      expect(part).toContain('the toddler years');
    }
  });

  it('never greets with a bare "Hi," — an unknown name greets "Hi there,"', async () => {
    const { client, send } = fakeResend();
    const sender = createWelcomeEmailSender(client);

    await sender.sendWelcome('parent@example.com', content({ firstName: 'there' }), UNSUB_URL);

    const payload = send.mock.calls[0]?.[0] as SendPayload;
    expect(payload.text).toContain('Hi there,');
    expect(payload.text).not.toContain('Hi ,');
    expect(payload.html).not.toContain('Hi ,');
  });

  it('renders the design-system palette with the white card + light-blue tagline, and a text-safe (non-apricot) CTA', async () => {
    const { client, send } = fakeResend();
    const sender = createWelcomeEmailSender(client);

    await sender.sendWelcome('parent@example.com', content(), UNSUB_URL);

    const payload = send.mock.calls[0]?.[0] as SendPayload;
    expect(payload.html).toContain('Welcome to your village.');
    // The white content card and the muted light-blue tagline are present.
    expect(payload.html).toContain('#ffffff');
    expect(payload.html).toContain('#C7D3E6');
    // Apricot #f97316 is FILL-ONLY per the design system (globals.css) — never
    // small text, and that includes the white-on-apricot CTA (~2.8:1, AA fail).
    // The CTA fill is Apricot-deep #C2410C instead; apricot must not appear at
    // all in the rendered HTML (case-insensitive).
    expect(payload.html).toContain('#C2410C');
    expect(payload.html.toLowerCase()).not.toContain('#f97316');
  });

  it('VIL-229: uses the voice greeting / village line / closing note when present, keeps the deterministic shell', async () => {
    const { client, send } = fakeResend();
    const sender = createWelcomeEmailSender(client);

    await sender.sendWelcome(
      'parent@example.com',
      content({
        firstName: 'Barton',
        voice: {
          greeting: 'hi Barton — so glad you found us',
          villageLine: 'Hale is the quiet village around your family',
          closingNote: 'write back whenever — a person is always here',
        },
      }),
      UNSUB_URL,
    );

    const payload = send.mock.calls[0]?.[0] as SendPayload;
    for (const part of [payload.html, payload.text]) {
      expect(part).toContain('hi Barton — so glad you found us');
      expect(part).toContain('Hale is the quiet village around your family');
      expect(part).toContain('write back whenever — a person is always here');
      // The deterministic shell (step links) is unchanged.
      expect(part).toContain('https://app.villagehale.com/village');
    }
    // The voice greeting REPLACES the deterministic "Hi Barton," line.
    expect(payload.text).not.toContain('Hi Barton,');
  });

  it('reports not-accepted (does not throw) when the provider returns an error', async () => {
    const send = vi.fn(async () => ({ data: null, error: { message: 'rejected' } }));
    const sender = createWelcomeEmailSender({ emails: { send } } as never);

    const result = await sender.sendWelcome('parent@example.com', content(), UNSUB_URL);

    expect(result).toEqual({ accepted: false, providerMessageId: null });
  });

  it('skips (no send) when RESEND_API_KEY is unset and no client injected', async () => {
    vi.stubEnv('RESEND_API_KEY', '');
    const sender = createWelcomeEmailSender();

    const result = await sender.sendWelcome('parent@example.com', content(), UNSUB_URL);

    expect(result).toEqual({ accepted: false, providerMessageId: null });
  });

  it('BCCs the founder copy when WELCOME_BCC is set (new-signup signal)', async () => {
    vi.stubEnv('WELCOME_BCC', 'barton@villagehale.com');
    const { client, send } = fakeResend();
    const sender = createWelcomeEmailSender(client);

    await sender.sendWelcome('parent@example.com', content(), UNSUB_URL);

    const payload = send.mock.calls[0]?.[0] as SendPayload;
    expect(payload.bcc).toBe('barton@villagehale.com');
  });

  it('omits bcc when WELCOME_BCC is unset', async () => {
    const { client, send } = fakeResend();
    const sender = createWelcomeEmailSender(client);

    await sender.sendWelcome('parent@example.com', content(), UNSUB_URL);

    const payload = send.mock.calls[0]?.[0] as SendPayload;
    expect(payload.bcc).toBeUndefined();
  });
});
