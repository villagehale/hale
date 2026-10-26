import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOutboundTransport } from './outbound-transport';
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
    const out = await transport.send({ to: '+15550000001', body: '你好' });
    expect(out.providerMessageId).toMatch(/^preview-capture-/);
    expect(capturedSends()).toHaveLength(1);
    expect(capturedSends()[0]).toMatchObject({ to: '+15550000001', body: '你好' });
    expect(sink).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
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
      to: '+15550000002',
      body: 'hola',
    });
    expect(capturedSends()).toHaveLength(1);
    expect(fetchSpy).not.toHaveBeenCalled();

    vi.stubEnv('VERCEL_ENV', 'production');
    expect(() => createOutboundTransport()).toThrow(/not_preview/);
  });
});
