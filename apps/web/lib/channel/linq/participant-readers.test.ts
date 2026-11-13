import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { listedReaders } from './participant-readers';

const KEY = Buffer.alloc(32, 7).toString('base64');
const SENT = new Date('2026-11-20T15:00:00.000Z');
const BEFORE = new Date(SENT.getTime() - 60_000);
const AFTER = new Date(SENT.getTime() + 1);
const MEI = '+16415550101';
const ADA = '+16415550201';
const notHale = () => false;

beforeEach(() => {
  vi.stubEnv('APP_ENCRYPTION_KEY', KEY);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('listedReaders: who Linq says was here when the message was sent', () => {
  it('counts only people Linq says joined no later than the send', () => {
    const readers = listedReaders(
      {
        status: 'ok',
        isGroup: true,
        handles: [MEI, ADA, '+16415550303'],
        joinedAt: new Map([
          [MEI, SENT],
          [ADA, AFTER],
        ]),
      },
      phoneBlindIndex(MEI),
      notHale,
      SENT,
    );
    expect(readers?.hashes).toHaveLength(3);
    expect([...(readers?.presentAtSend ?? [])]).toEqual([phoneBlindIndex(MEI)]);
  });

  it('a number listed under two spellings counts only if every listing joined before the send', () => {
    const spaced = '+1 641 555 0201';
    const readers = listedReaders(
      {
        status: 'ok',
        isGroup: true,
        handles: [MEI, spaced, ADA],
        joinedAt: new Map([
          [MEI, BEFORE],
          [ADA, BEFORE],
          [spaced, AFTER],
        ]),
      },
      phoneBlindIndex(MEI),
      notHale,
      SENT,
    );
    expect(readers?.hashes).toHaveLength(2);
    expect([...(readers?.presentAtSend ?? [])]).toEqual([phoneBlindIndex(MEI)]);
  });
});
