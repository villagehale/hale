import { beforeAll, describe, expect, it } from 'vitest';
import { memberKeyFromHandle, nameKey, senderMemberKey } from './member-key';

const KEY = Buffer.alloc(32, 7).toString('base64');
const APPLE_ID = 'Parent.One@example.com';
const PHONE = '+15555550104';

beforeAll(() => {
  process.env.APP_ENCRYPTION_KEY = KEY;
});

const nothingKnown = async () => [];

describe('senderMemberKey', () => {
  it('keys a nameless non-phone handle with the keyed index, never the handle itself', async () => {
    const key = await senderMemberKey({ handle: APPLE_ID }, nothingKnown);
    expect(key).not.toBe(nameKey(APPLE_ID));
    expect(key.toLowerCase()).not.toContain('example.com');
    expect(key.toLowerCase()).not.toContain('parent.one');
    expect(key).toMatch(/^handle:[0-9a-f]{64}$/);
  });

  it('gives one handle one key whatever its case or padding', async () => {
    const a = await senderMemberKey({ handle: APPLE_ID }, nothingKnown);
    const b = await senderMemberKey({ handle: ` ${APPLE_ID.toLowerCase()} ` }, nothingKnown);
    const other = await senderMemberKey({ handle: 'other@example.com' }, nothingKnown);
    expect(b).toBe(a);
    expect(other).not.toBe(a);
  });

  it('reads a row written under the legacy name:<handle> key', async () => {
    const legacy = nameKey(APPLE_ID);
    const key = await senderMemberKey({ handle: APPLE_ID }, async () => [legacy]);
    expect(key).toBe(legacy);
  });

  it('prefers the keyed index once a row under it exists', async () => {
    const fresh = await senderMemberKey({ handle: APPLE_ID }, nothingKnown);
    const key = await senderMemberKey({ handle: APPLE_ID }, async () => [nameKey(APPLE_ID), fresh]);
    expect(key).toBe(fresh);
  });

  it('keeps a phone on its blind index, reading no known keys', async () => {
    const neverRead = async (): Promise<string[]> => {
      throw new Error('known keys read for a sender with no legacy key');
    };
    expect(await senderMemberKey({ handle: PHONE }, neverRead)).toBe(memberKeyFromHandle(PHONE));
  });
});
