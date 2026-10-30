import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSmsChannel } from './adapters/phone-sms';
import { createOutboundTransport, readSendRefusal, refusalStopsRetry } from './outbound-transport';
import {
  PreviewCaptureRefused,
  capturedSends,
  clearCapturedSends,
  createPreviewCaptureTransport,
} from './preview-capture-transport';

const ON = { VERCEL_ENV: 'preview', PREVIEW_CAPTURE_TRANSPORT: 'on' };

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  clearCapturedSends();
});

describe('preview capture transport', () => {
  it('captures the send and makes no network call', async () => {
    vi.stubEnv('LINQ_API_KEY', '');
    vi.stubEnv('LINQ_FROM_E164', '');
    const fetchSpy = vi.fn(() => {
      throw new Error('network call');
    });
    vi.stubGlobal('fetch', fetchSpy);
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const sink = vi.fn();
    const transport = createPreviewCaptureTransport(ON, sink);
    const out = await transport.send({ to: '+14375550001', body: '你好' });
    expect(out.providerMessageId).toMatch(/^preview-capture-/);
    expect(capturedSends()).toHaveLength(1);
    expect(capturedSends()[0]).toMatchObject({ to: '+14375550001', body: '你好' });
    expect(sink).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses a recipient outside the fake-family 437-555 range, before capture or sink', async () => {
    vi.stubEnv('LINQ_API_KEY', '');
    vi.stubEnv('LINQ_FROM_E164', '');
    const sink = vi.fn();
    const transport = createPreviewCaptureTransport(ON, sink);
    for (const to of ['+14165550142', '+15550000001', '+14375560001', '']) {
      await expect(transport.send({ to, body: 'real words' })).rejects.toThrow(
        /recipient_not_synthetic/,
      );
    }
    expect(capturedSends()).toHaveLength(0);
    expect(sink).not.toHaveBeenCalled();
  });

  it('createOutboundTransport reports a non-synthetic refusal as permanent, never sent', async () => {
    vi.stubEnv('LINQ_API_KEY', '');
    vi.stubEnv('LINQ_FROM_E164', '');
    vi.stubEnv('VERCEL_ENV', 'preview');
    vi.stubEnv('PREVIEW_CAPTURE_TRANSPORT', 'on');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const err = await createOutboundTransport()
      .send({ to: '+14165550142', body: 'x' })
      .catch((e: unknown) => e);
    expect(readSendRefusal(err)).toEqual({
      code: 'preview_recipient_not_synthetic',
      permanent: true,
    });
    expect(refusalStopsRetry(err)).toBe(true);
    expect(capturedSends()).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a failed persist is logged by name, and the send stays captured in process', async () => {
    vi.stubEnv('LINQ_API_KEY', '');
    vi.stubEnv('LINQ_FROM_E164', '');
    vi.stubEnv('VERCEL_ENV', 'preview');
    vi.stubEnv('PREVIEW_CAPTURE_TRANSPORT', 'on');
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    // No DATABASE_URL in tests, so the lazy db() import fails the write.
    vi.stubEnv('DATABASE_URL', '');
    const out = await createOutboundTransport().send({ to: '+14375550003', body: 'x' });
    expect(out.providerMessageId).toMatch(/^preview-capture-/);
    expect(capturedSends()).toHaveLength(1);
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'preview_capture_persist_failed',
        providerMessageId: out.providerMessageId,
      }),
      expect.stringContaining('mismatch'),
    );
    expect(JSON.stringify(error.mock.calls)).not.toContain('"body"');
  });

  it('refuses outside preview', () => {
    expect(() => createPreviewCaptureTransport({ ...ON, VERCEL_ENV: 'production' })).toThrow(
      PreviewCaptureRefused,
    );
    expect(() => createPreviewCaptureTransport({ PREVIEW_CAPTURE_TRANSPORT: 'on' })).toThrow(
      /not_preview/,
    );
  });

  it('refuses with the flag off', () => {
    expect(() => createPreviewCaptureTransport({ VERCEL_ENV: 'preview' })).toThrow(/flag_off/);
  });

  it('refuses when a Linq key or line is configured', () => {
    vi.stubEnv('LINQ_FROM_E164', '');
    vi.stubEnv('LINQ_API_KEY', 'k');
    expect(() => createPreviewCaptureTransport(ON)).toThrow(/linq_configured/);
    vi.stubEnv('LINQ_API_KEY', '');
    vi.stubEnv('LINQ_FROM_E164', '+15550000000');
    expect(() => createPreviewCaptureTransport(ON)).toThrow(/linq_configured/);
  });

  it('createOutboundTransport uses capture only when asked, and never falls through to Linq', async () => {
    vi.stubEnv('LINQ_API_KEY', '');
    vi.stubEnv('LINQ_FROM_E164', '');
    vi.stubEnv('VERCEL_ENV', 'preview');
    vi.stubEnv('PREVIEW_CAPTURE_TRANSPORT', 'on');
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const fetchSpy = vi.fn();
    await createOutboundTransport({ fetch: fetchSpy as unknown as typeof fetch }).send({
      to: '+14375550002',
      body: 'hola',
    });
    expect(capturedSends()).toHaveLength(1);
    expect(fetchSpy).not.toHaveBeenCalled();

    vi.stubEnv('VERCEL_ENV', 'production');
    expect(() => createOutboundTransport()).toThrow(/not_preview/);
  });

  it('the SMS channel reaches the capture door on a preview proof run, with no network call', async () => {
    vi.stubEnv('LINQ_API_KEY', '');
    vi.stubEnv('LINQ_FROM_E164', '');
    vi.stubEnv('VERCEL_ENV', 'preview');
    vi.stubEnv('PREVIEW_CAPTURE_TRANSPORT', 'on');
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const channel = createSmsChannel({ resolveTarget: async () => '+14375550101' });
    const out = await channel.send({
      userId: 'u1',
      rendered: { kind: 'sms', text: 'Demain 15 h' },
    });
    expect(out.status).toBe('sent');
    expect(capturedSends()[0]).toMatchObject({ to: '+14375550101', body: 'Demain 15 h' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('the SMS channel still skips when neither Linq nor capture is set', async () => {
    vi.stubEnv('LINQ_API_KEY', '');
    vi.stubEnv('LINQ_FROM_E164', '');
    vi.stubEnv('PREVIEW_CAPTURE_TRANSPORT', '');
    const channel = createSmsChannel({ resolveTarget: async () => '+14375550101' });
    const out = await channel.send({ userId: 'u1', rendered: { kind: 'sms', text: 'x' } });
    expect(out).toEqual({ status: 'skipped', reason: 'not_configured' });
  });
});
