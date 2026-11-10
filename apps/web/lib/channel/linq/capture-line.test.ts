import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { schema } from '@hale/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeFakeDb } from '~/lib/channel/intake/fakes';
import { PREVIEW_CAPTURE_LINE, outboundLineFrom } from '~/lib/channel/outbound-transport';
import { capturedChatOps, clearCapturedChatOps } from '~/lib/channel/preview-capture-transport';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { openHouseholdLinqGroup } from './group';

/**
 * Group paths that need Hale's line read it through outboundLineFrom(), so a
 * Preview capture run reaches the (captured) Linq call instead of stopping
 * early, while production with no line stops early exactly as before.
 */

const ENC_KEY = Buffer.alloc(32, 7).toString('base64');
const NOW = new Date('2026-10-28T12:00:00.000Z');
const FAMILY = '00000000-0000-4000-8000-0000000000f1';
const USER = '00000000-0000-4000-8000-0000000000u1';
const PARENT = '+14375550101';
const COPARENT = '+14375550102';
const CHAT = '8f392755-6865-4b18-880a-227f9d8b4500';

function throwingFetch() {
  return vi.fn(async () => {
    throw new Error('network is off in this test: no Linq call may run');
  });
}

function liveOneToOne() {
  const fake = makeFakeDb();
  fake.db.insert(schema.parentChannels).values({
    userId: USER,
    familyId: FAMILY,
    kind: 'sms',
    phoneE164Encrypted: encryptString(PARENT),
    phoneE164Hash: phoneBlindIndex(PARENT),
    verifiedAt: NOW,
  } as never);
  fake.db.insert(schema.families).values({ id: FAMILY, displayName: 'Fixture' } as never);
  fake.db.insert(schema.channelMessages).values({
    familyId: FAMILY,
    parentUserId: USER,
    channel: 'imessage',
    direction: 'in',
    category: 'reply',
    providerChatId: CHAT,
    providerMessageId: 'in-1',
  } as never);
  return fake;
}

function clearLinqEnv() {
  vi.stubEnv('LINQ_API_KEY', '');
  vi.stubEnv('LINQ_FROM_E164', '');
}

let globalFetch: ReturnType<typeof throwingFetch>;
beforeEach(() => {
  process.env.APP_ENCRYPTION_KEY = ENC_KEY;
  clearCapturedChatOps();
  globalFetch = throwingFetch();
  vi.stubGlobal('fetch', globalFetch);
});

afterEach(() => {
  process.env.APP_ENCRYPTION_KEY = '';
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  clearCapturedChatOps();
});

describe('outboundLineFrom', () => {
  it('is the fake 437-555 placeholder only on a preview deploy with capture on', () => {
    expect(PREVIEW_CAPTURE_LINE).toBe('+14375550100');
    clearLinqEnv();
    vi.stubEnv('VERCEL_ENV', 'preview');
    vi.stubEnv('PREVIEW_CAPTURE_TRANSPORT', 'on');
    expect(outboundLineFrom()).toBe(PREVIEW_CAPTURE_LINE);
  });

  it('in production with LINQ_FROM_E164 unset is null, even if the capture flag were set', () => {
    clearLinqEnv();
    vi.stubEnv('VERCEL_ENV', 'production');
    vi.stubEnv('PREVIEW_CAPTURE_TRANSPORT', '');
    expect(outboundLineFrom()).toBeNull();
    vi.stubEnv('PREVIEW_CAPTURE_TRANSPORT', 'on');
    expect(outboundLineFrom()).toBeNull();
  });
});

describe('capture on: a group path reaches captured Linq calls, never Linq', () => {
  it('opens the household group via captured create_chat, then add_participant', async () => {
    clearLinqEnv();
    vi.stubEnv('VERCEL_ENV', 'preview');
    vi.stubEnv('PREVIEW_CAPTURE_TRANSPORT', 'on');
    const fake = liveOneToOne();
    const fetch = throwingFetch();

    const opened = await openHouseholdLinqGroup(fake.db, {
      familyId: FAMILY,
      parentUserId: USER,
      parentPhoneE164: PARENT,
      coParentPhoneE164: COPARENT,
      now: NOW,
      fetch,
    });
    expect(opened.status).toBe('opened');
    const create = capturedChatOps().find((op) => op.op === 'create_chat');
    expect(create?.input).toMatchObject({ from: PREVIEW_CAPTURE_LINE, to: [PARENT, COPARENT] });

    const added = await openHouseholdLinqGroup(fake.db, {
      familyId: FAMILY,
      parentUserId: USER,
      parentPhoneE164: PARENT,
      coParentPhoneE164: '+14375550103',
      now: NOW,
      fetch,
    });
    expect(added.status).toBe('added');
    expect(capturedChatOps().map((op) => op.op)).toContain('add_participant');

    expect(fetch).not.toHaveBeenCalled();
    expect(globalFetch).not.toHaveBeenCalled();
  });
});

describe('production, LINQ_FROM_E164 unset: the line-gated paths stop early as today', () => {
  it('openHouseholdLinqGroup skips with no_from and calls nothing', async () => {
    clearLinqEnv();
    vi.stubEnv('VERCEL_ENV', 'production');
    vi.stubEnv('PREVIEW_CAPTURE_TRANSPORT', '');
    const fake = liveOneToOne();
    const fetch = throwingFetch();
    const outcome = await openHouseholdLinqGroup(fake.db, {
      familyId: FAMILY,
      parentUserId: USER,
      parentPhoneE164: PARENT,
      coParentPhoneE164: COPARENT,
      now: NOW,
      fetch,
    });
    expect(outcome).toEqual({ status: 'skipped', reason: 'no_from' });
    expect(fetch).not.toHaveBeenCalled();
    expect(capturedChatOps()).toEqual([]);
  });

  // The four early exits Noah named. Each reads the line from outboundLineFrom()
  // and keeps its no-line branch unchanged; outboundLineFrom() is null here
  // (asserted above), so each takes the same early exit as before.
  const SITES: { file: string; guard: RegExp }[] = [
    {
      file: 'group-members.ts',
      guard: /const from = outboundLineFrom\(\);\n\s+if \(!from\) return false;/,
    },
    {
      file: 'multi-family.ts',
      guard: /const from = outboundLineFrom\(\);\n\s+if \(!from\) return false;/,
    },
    {
      file: 'group-coparent.ts',
      guard:
        /const from = outboundLineFrom\(\);\n\s+const text = from\n\s+\? [\s\S]*?\n\s+: await linqGroupLineMissing\(language\);/,
    },
    {
      file: 'inbound.ts',
      guard:
        /const from = outboundLineFrom\(\);\n\s+const text = from\n\s+\? [\s\S]*?\n\s+: await linqGroupLineMissing\(language\);/,
    },
  ];
  for (const site of SITES) {
    it(`${site.file} gates on outboundLineFrom() with its no-line branch intact`, () => {
      const text = readFileSync(fileURLToPath(new URL(`./${site.file}`, import.meta.url)), 'utf8');
      expect(text).toMatch(site.guard);
      clearLinqEnv();
      vi.stubEnv('VERCEL_ENV', 'production');
      expect(outboundLineFrom()).toBeNull();
    });
  }
});
