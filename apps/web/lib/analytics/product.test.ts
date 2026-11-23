import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetCanaryFamilyCacheForTests, setCanaryFamilyLookupForTests } from './canary-tag';
import { resetPosthogClientsForTests } from './posthog-node';
import { decodeBatch, ours } from './posthog-wire.testkit';
import {
  captureErrorEventAsync,
  captureProductEventAsync,
  mediaKindOf,
  productChannel,
  resetProductCaptureLogsForTests,
} from './product';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  resetPosthogClientsForTests();
  resetProductCaptureLogsForTests();
  resetCanaryFamilyCacheForTests();
});

function armedProduct(): void {
  vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', 'phc_product_test');
  vi.stubEnv('POSTHOG_HOST', 'https://ph.example.com');
  vi.stubEnv('POSTHOG_ID_SALT', 'test-salt');
  vi.stubEnv('POSTHOG_PRODUCT_EVENTS_ENABLED', 'true');
  resetPosthogClientsForTests();
}

describe('productChannel', () => {
  it('maps a group iMessage to group, not imessage', () => {
    expect(productChannel({ channel: 'imessage', isGroup: true })).toBe('group');
    expect(productChannel({ channel: 'imessage', isGroup: false })).toBe('imessage');
    expect(productChannel({ channel: 'sms' })).toBe('sms');
    expect(productChannel({ channel: 'email' })).toBe('email');
  });
});

describe('mediaKindOf', () => {
  it('names none, a single kind, or mixed — never a url', () => {
    expect(mediaKindOf(undefined)).toBe('none');
    expect(mediaKindOf([{ kind: 'image' }])).toBe('image');
    expect(mediaKindOf([{ kind: 'image' }, { kind: 'audio' }])).toBe('mixed');
  });
});

describe('captureProductEventAsync', () => {
  it('is a named no-op when the flag is off — nothing leaves', async () => {
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', 'phc_product_test');
    vi.stubEnv('POSTHOG_ID_SALT', 'test-salt');
    vi.stubEnv('POSTHOG_PRODUCT_EVENTS_ENABLED', '');
    resetPosthogClientsForTests();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      captureProductEventAsync({ event: 'message_inbound', familyId: 'family-uuid-1' }),
    ).resolves.toBe('flag_off');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('hashes the family id, attaches family/$groups after sanitization, and drops PII keys', async () => {
    armedProduct();
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) => new Response('{}', { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      captureProductEventAsync({
        event: 'message_inbound',
        familyId: 'family-uuid-1',
        chatId: 'chat-9',
        properties: {
          channel: 'group',
          is_group: true,
          family_count: 2,
          media_type: 'image',
          parentName: 'Sam',
          message: 'hi Maya',
        },
      }),
    ).resolves.toBe('sent');
    expect(fetchMock).toHaveBeenCalled();
    const { text, events } = decodeBatch(fetchMock.mock.calls[0]?.[1]);
    expect(events[0]?.event).toBe('message_inbound');
    expect(events[0]?.distinct_id).toBe(
      '47d4bd0e8f16f9fae4b33bdf8af9ff328db2b2b9f24408e6f2320c8a7f250f53',
    );
    expect(ours(events[0]?.properties ?? {})).toMatchObject({
      channel: 'group',
      is_group: true,
      family_count: 2,
      media_type: 'image',
    });
    expect(events[0]?.properties.$groups).toEqual({
      family: '47d4bd0e8f16f9fae4b33bdf8af9ff328db2b2b9f24408e6f2320c8a7f250f53',
      group_chat: expect.any(String),
    });
    expect(text).not.toContain('family-uuid-1');
    expect(text).not.toContain('Sam');
    expect(text).not.toContain('Maya');
    expect(text).not.toContain('chat-9');
  });

  it('stamps canary on the probe family and sets the person property', async () => {
    armedProduct();
    setCanaryFamilyLookupForTests((id) => id === 'probe-family');
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) => new Response('{}', { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      captureProductEventAsync({
        event: 'message_inbound',
        familyId: 'probe-family',
        properties: { channel: 'sms', is_group: false, family_count: 1, media_type: 'none' },
      }),
    ).resolves.toBe('sent');
    const { text, events } = decodeBatch(fetchMock.mock.calls[0]?.[1]);
    expect(ours(events[0]?.properties ?? {})).toMatchObject({ canary: true, channel: 'sms' });
    expect(events[0]?.properties.$set).toEqual({ canary: true });
    expect(text).not.toContain('probe-family');
  });

  it('does not stamp a real family just because a property says CANARY', async () => {
    armedProduct();
    setCanaryFamilyLookupForTests(() => false);
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) => new Response('{}', { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      captureProductEventAsync({
        event: 'message_inbound',
        familyId: 'real-family',
        properties: { channel: 'sms', is_group: false, family_count: 1, media_type: 'CANARY' },
      }),
    ).resolves.toBe('sent');
    const { events } = decodeBatch(fetchMock.mock.calls[0]?.[1]);
    expect(ours(events[0]?.properties ?? {})).not.toHaveProperty('canary');
    expect(events[0]?.properties.$set).toBeUndefined();
    expect(ours(events[0]?.properties ?? {}).media_type).toBe('CANARY');
  });
});

describe('captureErrorEventAsync', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', 'phc_product_test');
    vi.stubEnv('POSTHOG_PROJECT_API_KEY', 'phc_project_test');
    vi.stubEnv('POSTHOG_HOST', 'https://ph.example.com');
    vi.stubEnv('POSTHOG_ID_SALT', 'test-salt');
    resetPosthogClientsForTests();
    resetProductCaptureLogsForTests();
  });

  it('stays dark without POSTHOG_ERROR_TRACKING_ENABLED', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      captureErrorEventAsync({ event: 'send_failed', familyId: 'family-uuid-1' }),
    ).resolves.toBe('flag_off');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
