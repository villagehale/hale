import { describe, expect, it, vi } from 'vitest';
import { BUSINESS_ADDRESS } from '~/lib/cron/email-compliance';
import type { ResendTransport } from '~/lib/channel/resend-transport';
import type { EmailInboundConfig } from './config';
import {
  EMAIL_REPLY_SUBJECT,
  inboundReplyToAddress,
  messageIdHeader,
  productionEmailReply,
  sendEmailReply,
} from './reply-send';

/**
 * The envelope around a coach-written reply.
 *
 * What is pinned here is everything that is NOT the words: that the answer lands in the
 * parent's own mail thread, that a reply to it comes back to Hale rather than to a
 * no-reply void, and that a send which quietly did nothing is refused rather than
 * reported as delivered.
 */

const CONFIG: EmailInboundConfig = {
  apiKey: 're_test',
  webhookSecret: 'whsec_test',
  inboundDomain: 'mail.villagehale.com',
  authservId: 'mx.resend.com',
};

type Sent = Parameters<ResendTransport['send']>[0];

function transport(answer: Awaited<ReturnType<ResendTransport['send']>>) {
  const sent: Sent[] = [];
  return {
    sent,
    transport: {
      send: async (msg: Sent) => {
        sent.push(msg);
        return answer;
      },
    } satisfies ResendTransport,
  };
}

function deps(answer: Awaited<ReturnType<ResendTransport['send']>> = { id: 'prov-1', error: null }) {
  const t = transport(answer);
  return { sent: t.sent, deps: { transport: t.transport, config: CONFIG, from: 'aloha@villagehale.com' } };
}

describe('messageIdHeader', () => {
  it.each([
    ['<a@b.test>', '<a@b.test>'],
    ['a@b.test', '<a@b.test>'],
    ['  a@b.test  ', '<a@b.test>'],
  ])('renders %j as %j', (input, expected) => {
    expect(messageIdHeader(input)).toBe(expected);
  });

  it('has nothing to reference when the id is blank', () => {
    expect(messageIdHeader('   ')).toBeNull();
  });
});

describe('sendEmailReply', () => {
  it('threads the answer onto the message it answers', async () => {
    const h = deps();

    await sendEmailReply(h.deps, {
      to: 'sam@example.com',
      body: 'Saturday is dry — the splash pad is open.',
      inReplyTo: 'msg-1@example.com',
    });

    const msg = h.sent[0];
    expect(msg?.headers).toEqual({
      'In-Reply-To': '<msg-1@example.com>',
      References: '<msg-1@example.com>',
    });
    expect(msg?.subject).toBe(EMAIL_REPLY_SUBJECT);
  });

  it('points a reply back at the address the webhook receives on', async () => {
    const h = deps();

    await sendEmailReply(h.deps, { to: 'sam@example.com', body: 'Hi.', inReplyTo: null });

    expect(h.sent[0]?.replyTo).toBe('hale@mail.villagehale.com');
    expect(inboundReplyToAddress(CONFIG)).toBe('hale@mail.villagehale.com');
    // From stays the loop's verified sending identity — only the reply path moves.
    expect(h.sent[0]?.from).toBe('aloha@villagehale.com');
  });

  it('sends the coach words with the CASL footer under them and nothing else', async () => {
    const h = deps();

    await sendEmailReply(h.deps, {
      to: 'sam@example.com',
      body: 'Saturday is dry — the splash pad is open.',
      inReplyTo: null,
    });

    const text = h.sent[0]?.text ?? '';
    expect(text.startsWith('Saturday is dry — the splash pad is open.')).toBe(true);
    expect(text).toContain(BUSINESS_ADDRESS);
    expect(text).toContain('Reply STOP');
    // No unsubscribe LINK: a reply is responsive, so there is no stream to leave and a
    // link to one would be a link to nothing.
    expect(text).not.toContain('http');
  });

  it('starts a thread rather than inventing a reference when there is no inbound id', async () => {
    const h = deps();

    await sendEmailReply(h.deps, { to: 'sam@example.com', body: 'Hi.', inReplyTo: null });

    expect(h.sent[0]?.headers).toBeUndefined();
  });

  it('refuses to report a send the provider rejected', async () => {
    const h = deps({ id: null, error: { name: 'validation_error', message: 'bad domain' } });

    await expect(
      sendEmailReply(h.deps, { to: 'sam@example.com', body: 'Hi.', inReplyTo: null }),
    ).rejects.toThrow(/provider refused/);
  });

  /**
   * The shared transport degrades to a no-op with no credentials, and a no-op answers
   * {id: null, error: null} — which reads as success. The router claims the turn ANSWERED
   * the instant this returns, so passing that on would thread a reply into a parent's
   * history that no inbox ever received (rule #11).
   */
  it('refuses a send that silently went nowhere', async () => {
    const h = deps({ id: null, error: null });

    await expect(
      sendEmailReply(h.deps, { to: 'sam@example.com', body: 'Hi.', inReplyTo: null }),
    ).rejects.toThrow(/nothing was sent/);
  });
});

describe('productionEmailReply — dark by construction', () => {
  it('is absent until the inbound leg is provisioned', () => {
    vi.stubEnv('RESEND_API_KEY', 're_test');
    vi.stubEnv('RESEND_INBOUND_WEBHOOK_SECRET', '');
    vi.stubEnv('HALE_INBOUND_EMAIL_DOMAIN', '');
    vi.stubEnv('HALE_INBOUND_AUTHSERV_ID', '');

    expect(productionEmailReply()).toBeNull();
    vi.unstubAllEnvs();
  });

  it('is built once every inbound variable is set', () => {
    vi.stubEnv('RESEND_API_KEY', 're_test');
    vi.stubEnv('RESEND_INBOUND_WEBHOOK_SECRET', 'whsec_test');
    vi.stubEnv('HALE_INBOUND_EMAIL_DOMAIN', 'mail.villagehale.com');
    vi.stubEnv('HALE_INBOUND_AUTHSERV_ID', 'mx.resend.com');

    expect(productionEmailReply()?.config.inboundDomain).toBe('mail.villagehale.com');
    vi.unstubAllEnvs();
  });
});
