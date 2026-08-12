import { describe, expect, it, vi } from 'vitest';
import type { ResendTransport } from '~/lib/channel/resend-transport';
import { INTRO_EMAIL_SUBJECT } from './copy';
import { createIntroEmailSender, introFirstName } from './email';

type SendArg = Parameters<ResendTransport['send']>[0];

function fakeTransport(
  result: Awaited<ReturnType<ResendTransport['send']>> = { id: 'msg-1', error: null },
) {
  const send = vi.fn(async (_msg: SendArg) => result);
  return { transport: { send } as ResendTransport, send };
}

const REQUEST = {
  parentA: { firstName: 'Sam', email: 'sam@example.com' },
  parentB: { firstName: 'Priya', email: 'priya@example.com' },
  stage: 'toddler' as const,
  anchorTitle: null,
};

describe('createIntroEmailSender', () => {
  it('sends ONE message with both parents on the visible header', async () => {
    const { transport, send } = fakeTransport();
    const result = await createIntroEmailSender({ transport, configured: true }).send(REQUEST);

    expect(result).toEqual({ status: 'sent', providerMessageId: 'msg-1' });
    expect(send).toHaveBeenCalledTimes(1);
    const msg = send.mock.calls[0]?.[0] as SendArg;
    expect(msg.to).toBe('sam@example.com');
    expect(msg.cc).toBe('priya@example.com');
    expect(msg.bcc).toBeUndefined();
    expect(msg.subject).toBe(INTRO_EMAIL_SUBJECT);
  });

  it('names an absent provider instead of reporting a send that never happened', async () => {
    // The shared transport no-ops with {id:null,error:null} when it has no key, which
    // reads as success to anyone who only checks `error`. Both families would be audited
    // as disclosed-to and neither would ever hear from the other.
    const { transport, send } = fakeTransport({ id: null, error: null });
    const result = await createIntroEmailSender({ transport, configured: false }).send(REQUEST);

    expect(result).toEqual({ status: 'skipped', reason: 'not_configured' });
    expect(send).not.toHaveBeenCalled();
  });

  it('surfaces a provider error as an error, not as a send', async () => {
    const { transport } = fakeTransport({ id: null, error: { name: 'x', message: 'rejected' } });
    const result = await createIntroEmailSender({ transport, configured: true }).send(REQUEST);
    expect(result).toEqual({ status: 'error', message: 'rejected' });
  });

  it('carries the stage overlap and the anchor into the body', async () => {
    const { transport, send } = fakeTransport();
    await createIntroEmailSender({ transport, configured: true }).send({
      ...REQUEST,
      stage: 'preschool',
      anchorTitle: 'Family Storytime',
    });
    const text = (send.mock.calls[0]?.[0] as SendArg).text;
    expect(text).toContain('Hi Sam and Priya,');
    expect(text).toContain('you each have a preschooler');
    expect(text).toContain('You were also both eyeing Family Storytime');
  });
});

describe('introFirstName', () => {
  it('takes the first name only - a surname is an identity nobody consented to share', () => {
    expect(introFirstName('Priya Raman')).toBe('Priya');
    expect(introFirstName('  Sam  ')).toBe('Sam');
    expect(introFirstName('Mary Anne Van Der Berg')).toBe('Mary');
  });
});
