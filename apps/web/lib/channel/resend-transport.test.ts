import { describe, expect, it, vi } from 'vitest';
import { createResendTransport } from './resend-transport';

// The shared Resend transport (VIL-213 · A2). It owns the SDK client and normalizes
// the send result to {id, error}; the four email senders keep their own
// from-identity/body/skip. Two behaviours matter: an injected client's result is
// mapped faithfully, and with no client and no key the transport is a clean no-op
// that never reaches a provider.

const MSG = { from: 'a@x.com', to: 'b@y.com', subject: 's', text: 't' } as const;

/** A fake Resend whose `emails.send` returns the given wire result. */
function fakeClient(result: { data: { id: string } | null; error: unknown }) {
  const send = vi.fn(async () => result);
  return { client: { emails: { send } } as never, send };
}

describe('createResendTransport', () => {
  it('maps an injected client accepted send to the provider id with no error', async () => {
    const { client, send } = fakeClient({ data: { id: 'resend-9' }, error: null });

    const result = await createResendTransport({ client }).send(MSG);

    expect(result).toEqual({ id: 'resend-9', error: null });
    expect(send).toHaveBeenCalledWith(MSG);
  });

  it('narrows a provider error to {name, message} and reports no id (drops PII-bearing fields)', async () => {
    // A real Resend error also carries statusCode + a recipient-shaped payload; only
    // name + message may cross the seam (rule #1).
    const { client } = fakeClient({
      data: null,
      error: { name: 'rate_limit_exceeded', message: 'Too many requests', statusCode: 429 },
    });

    const result = await createResendTransport({ client }).send(MSG);

    expect(result).toEqual({ id: null, error: { name: 'rate_limit_exceeded', message: 'Too many requests' } });
  });

  it('no-ops with a null id and null error when neither a client nor an api key is available', async () => {
    const result = await createResendTransport().send(MSG);

    expect(result).toEqual({ id: null, error: null });
  });
});
