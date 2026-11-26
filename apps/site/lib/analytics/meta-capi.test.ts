import { afterEach, describe, expect, it, vi } from 'vitest';
import { POST } from '../../app/api/analytics/meta-lead/route';
import { resetSiteMetaCapiAbsenceForTests, sendSiteMetaCapi } from './meta-capi';

const LEAD_ID = 'lead_0123456789abcdef0123456789abcdef';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  resetSiteMetaCapiAbsenceForTests();
});

describe('sendSiteMetaCapi', () => {
  it('sends InitiateCheckout with the session id, CAD value, and fbp/fbc, and no email', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      return new Response('{}', { status: 200 });
    });
    const status = await sendSiteMetaCapi({
      eventName: 'InitiateCheckout',
      eventId: 'cs_test_capi',
      sourceUrl: 'https://www.villagehale.com/pricing?tier=plus#pay',
      value: 59,
      currency: 'cad',
      ads: { fbp: 'fb.1.1.cookie', fbc: 'fb.1.1.click' },
      env: {
        META_CAPI_ENABLED: 'true',
        NEXT_PUBLIC_META_PIXEL_ID: '2041301346827688',
        META_CAPI_ACCESS_TOKEN: 'token',
      },
      fetchImpl,
    });
    expect(status).toBe('sent');
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as {
      data: Array<{
        event_name: string;
        event_id: string;
        event_source_url: string;
        user_data: Record<string, string>;
        custom_data: { value: number; currency: string };
      }>;
    };
    expect(body.data[0]).toMatchObject({
      event_name: 'InitiateCheckout',
      event_id: 'cs_test_capi',
      event_source_url: 'https://www.villagehale.com/pricing',
      user_data: { fbp: 'fb.1.1.cookie', fbc: 'fb.1.1.click' },
      custom_data: { value: 59, currency: 'CAD' },
    });
    expect(JSON.stringify(body)).not.toContain('@');
    expect(body.data[0]?.user_data).not.toHaveProperty('em');
    expect(body.data[0]?.user_data).not.toHaveProperty('ph');
  });

  it('does not call Meta while the flag is off', async () => {
    const fetchImpl = vi.fn();
    expect(
      await sendSiteMetaCapi({
        eventName: 'Lead',
        eventId: LEAD_ID,
        sourceUrl: 'https://www.villagehale.com/text',
        env: { NEXT_PUBLIC_META_PIXEL_ID: '2041301346827688', META_CAPI_ACCESS_TOKEN: 'token' },
        fetchImpl,
      }),
    ).toBe('flag_off');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('POST /api/analytics/meta-lead', () => {
  it('posts Lead with the same event id and the click cookies', async () => {
    vi.stubEnv('META_CAPI_ENABLED', 'true');
    vi.stubEnv('NEXT_PUBLIC_META_PIXEL_ID', '2041301346827688');
    vi.stubEnv('META_CAPI_ACCESS_TOKEN', 'token');
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      return new Response('{}', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchImpl);
    const res = await POST(
      new Request('https://www.villagehale.com/api/analytics/meta-lead', {
        method: 'POST',
        headers: {
          cookie: '_fbp=fb.1.1.cookie; _fbc=fb.1.1.click',
          referer: 'https://www.villagehale.com/text?from=home',
        },
        body: JSON.stringify({ event_id: LEAD_ID }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'sent' });
    expect(res.headers.get('set-cookie')).toBeNull();
    const body = JSON.parse(String((fetchImpl.mock.calls[0] as [string, RequestInit])[1].body)) as {
      data: Array<{
        event_name: string;
        event_id: string;
        event_source_url: string;
        user_data: Record<string, string>;
      }>;
    };
    expect(body.data[0]).toMatchObject({
      event_name: 'Lead',
      event_id: LEAD_ID,
      event_source_url: 'https://www.villagehale.com/text',
      user_data: { fbp: 'fb.1.1.cookie', fbc: 'fb.1.1.click' },
    });
  });

  it('refuses a lead with no pixel cookie and does not call Meta', async () => {
    vi.stubEnv('META_CAPI_ENABLED', 'true');
    vi.stubEnv('NEXT_PUBLIC_META_PIXEL_ID', '2041301346827688');
    vi.stubEnv('META_CAPI_ACCESS_TOKEN', 'token');
    const fetchImpl = vi.fn();
    vi.stubGlobal('fetch', fetchImpl);
    const res = await POST(
      new Request('https://www.villagehale.com/api/analytics/meta-lead', {
        method: 'POST',
        headers: { referer: 'https://www.villagehale.com/text' },
        body: JSON.stringify({ event_id: LEAD_ID }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'refused' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('names flag_off and does not call Meta', async () => {
    const fetchImpl = vi.fn();
    vi.stubGlobal('fetch', fetchImpl);
    const res = await POST(
      new Request('https://www.villagehale.com/api/analytics/meta-lead', {
        method: 'POST',
        headers: {
          cookie: '_fbp=fb.1.1.cookie',
          referer: 'https://www.villagehale.com/text',
        },
        body: JSON.stringify({ event_id: LEAD_ID }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'flag_off' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
