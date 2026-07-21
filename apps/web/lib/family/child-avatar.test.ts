import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the storage adapter (its REST calls are unit-tested in docs/storage). Here we
// test the avatar mutation ORCHESTRATION: upload-before-row ordering, the in-place
// upsert, the audit action strings (rule #6), family scoping (rule #1), and the
// child-vanished race cleanup.
vi.mock('../docs/storage.js', () => ({
  uploadDocument: vi.fn(async () => {}),
  signDocumentUrl: vi.fn(async () => 'https://signed.example/avatar'),
  removeDocument: vi.fn(async () => {}),
}));

import { removeDocument, signDocumentUrl, uploadDocument } from '../docs/storage.js';
import {
  avatarStoragePathFor,
  removeChildAvatar,
  resolveChildAvatarUrl,
  setChildAvatar,
  sniffAvatarMime,
} from './child-avatar.js';

const FAMILY_ID = '44444444-4444-4444-8444-444444444444';
const CHILD_ID = '55555555-5555-4555-8555-555555555555';
const ACTOR = '22222222-2222-4222-8222-222222222222';
const PATH = `avatars/${FAMILY_ID}/${CHILD_ID}`;

function jpeg(): Buffer {
  return Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
}
function png(): Buffer {
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
}
function webp(): Buffer {
  const b = Buffer.alloc(16);
  b.write('RIFF', 0, 'ascii');
  b.write('WEBP', 8, 'ascii');
  return b;
}
function heic(): Buffer {
  const b = Buffer.alloc(16);
  b.write('ftyp', 4, 'ascii');
  b.write('heic', 8, 'ascii');
  return b;
}
function pdf(): Buffer {
  return Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d]);
}

/** A chainable, awaitable drizzle-builder stub resolving to `rows`. */
function builder(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const m of ['from', 'where', 'limit', 'set', 'values', 'returning']) {
    chain[m] = vi.fn(() => chain);
  }
  // biome-ignore lint/suspicious/noThenProperty: drizzle builders are thenable; the mock must be awaitable
  (chain as { then: unknown }).then = (resolve: (v: unknown[]) => unknown) => resolve(rows);
  return chain;
}

/**
 * A fake DB whose select resolves to `ownershipRows` and whose tx.update().returning()
 * resolves to `updatedRows`. Records the avatar-path set and the audit values written.
 */
function fakeDb(opts: { ownershipRows?: unknown[]; updatedRows?: unknown[] } = {}) {
  const setValues: unknown[] = [];
  const auditValues: Array<Record<string, unknown>> = [];

  const tx = {
    update: vi.fn(() => {
      const b = builder(opts.updatedRows ?? [{ id: CHILD_ID }]);
      (b.set as Mock).mockImplementation((v: unknown) => {
        setValues.push(v);
        return b;
      });
      return b;
    }),
    insert: vi.fn(() => {
      const b = builder([]);
      (b.values as Mock).mockImplementation((v: Record<string, unknown>) => {
        auditValues.push(v);
        return b;
      });
      return b;
    }),
  };

  const db = {
    select: vi.fn(() => builder(opts.ownershipRows ?? [{ id: CHILD_ID }])),
    transaction: vi.fn(async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx)),
  };

  return { db: db as never, setValues, auditValues };
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('sniffAvatarMime', () => {
  it('accepts the three browser-renderable image types by their magic bytes', () => {
    expect(sniffAvatarMime(jpeg())).toBe('image/jpeg');
    expect(sniffAvatarMime(png())).toBe('image/png');
    expect(sniffAvatarMime(webp())).toBe('image/webp');
  });

  it('rejects HEIC even though it sniffs as an image — no browser <img> renders it and there is no transcode (honest 415)', () => {
    // The base sniffer recognizes HEIC; the avatar allowlist must still drop it, or a
    // parent uploads a photo that renders nowhere on the web.
    expect(sniffAvatarMime(heic())).toBeNull();
  });

  it('rejects a PDF (a document is not a profile photo) and arbitrary bytes', () => {
    expect(sniffAvatarMime(pdf())).toBeNull();
    expect(sniffAvatarMime(Buffer.from('not an image at all'))).toBeNull();
    expect(sniffAvatarMime(Buffer.alloc(0))).toBeNull();
  });
});

describe('avatarStoragePathFor', () => {
  it('is the deterministic per-child key (one object per child, no filename/PII)', () => {
    expect(avatarStoragePathFor(FAMILY_ID, CHILD_ID)).toBe(PATH);
  });
});

describe('setChildAvatar', () => {
  it('uploads the bytes in place (upsert) BEFORE writing the row, sets avatar_path, audits child_avatar_set, and returns a signed URL', async () => {
    const { db, setValues, auditValues } = fakeDb();

    const url = await setChildAvatar(
      db,
      { familyId: FAMILY_ID, childId: CHILD_ID, actorUserId: ACTOR },
      jpeg(),
      'image/jpeg',
    );

    // Upsert to the deterministic key…
    expect(uploadDocument).toHaveBeenCalledWith(PATH, expect.any(Buffer), 'image/jpeg', expect.anything(), true);
    // …and the bytes land BEFORE the row write (crash-safe: no row ever points at absent bytes).
    // invocationCallOrder is 1-based, so a real call is > 0; 0 means "never called".
    const uploadOrder = (uploadDocument as Mock).mock.invocationCallOrder.at(0) ?? 0;
    const txOrder =
      (db as unknown as { transaction: Mock }).transaction.mock.invocationCallOrder.at(0) ?? 0;
    expect(uploadOrder).toBeGreaterThan(0);
    expect(txOrder).toBeGreaterThan(0);
    expect(uploadOrder).toBeLessThan(txOrder);

    // Sets the key AND stamps avatar_updated_at (the cache-buster source).
    expect(setValues).toHaveLength(1);
    expect(setValues[0]).toEqual({ avatarPath: PATH, avatarUpdatedAt: expect.any(Date) });
    expect(auditValues[0]).toMatchObject({
      familyId: FAMILY_ID,
      actor: ACTOR,
      actionTaken: 'child_avatar_set',
      targetTable: 'children',
      targetId: CHILD_ID,
    });
    // The audit row carries NO filename or bytes (rule #1) — only the child id.
    expect(auditValues[0]).not.toHaveProperty('before');
    expect(auditValues[0]).not.toHaveProperty('after');
    // The returned URL carries the ?v= cache-buster derived from the stamp.
    expect(url).toMatch(/^https:\/\/signed\.example\/avatar[?&]v=\d+$/);
  });

  it('cleans up the just-uploaded object and returns null when the child vanished in a race (no orphan, no audit)', async () => {
    // The ownership-scoped UPDATE affects 0 rows → the child was removed between the
    // route check and this write. The bytes we already uploaded must not be orphaned.
    const { db, auditValues } = fakeDb({ updatedRows: [] });

    const url = await setChildAvatar(
      db,
      { familyId: FAMILY_ID, childId: CHILD_ID, actorUserId: ACTOR },
      png(),
      'image/png',
    );

    expect(url).toBeNull();
    expect(removeDocument).toHaveBeenCalledWith(PATH, expect.anything());
    expect(auditValues).toHaveLength(0);
    expect(signDocumentUrl).not.toHaveBeenCalled();
  });
});

describe('resolveChildAvatarUrl', () => {
  const STAMP = new Date('2026-07-20T00:00:00.000Z');

  it('signs a present avatar_path and appends the ?v= cache-buster from the stamp', async () => {
    const sign = vi.fn(async (p: string) => `https://signed/${p}?token=abc`);
    expect(await resolveChildAvatarUrl(PATH, STAMP, sign)).toBe(
      `https://signed/${PATH}?token=abc&v=${STAMP.getTime()}`,
    );
    expect(sign).toHaveBeenCalledWith(PATH);
  });

  it('changes the rendered URL when the photo is REPLACED (stamp advances) even though the key is stable — no stale render', async () => {
    const sign = vi.fn(async (p: string) => `https://signed/${p}?token=fixed`);
    const before = await resolveChildAvatarUrl(PATH, new Date('2026-07-20T00:00:00Z'), sign);
    const after = await resolveChildAvatarUrl(PATH, new Date('2026-07-20T09:30:00Z'), sign);
    expect(before).not.toBe(after);
  });

  it('returns null (no sign) when the child has no avatar', async () => {
    const sign = vi.fn(async () => 'nope');
    expect(await resolveChildAvatarUrl(null, null, sign)).toBeNull();
    expect(sign).not.toHaveBeenCalled();
  });

  it('degrades to null (initials fallback) when signing fails, rather than throwing — a photo must never break the page (rule #1)', async () => {
    const sign = vi.fn(async () => {
      throw new Error('storage 500');
    });
    expect(await resolveChildAvatarUrl(PATH, STAMP, sign)).toBeNull();
  });
});

describe('removeChildAvatar', () => {
  it('removes the object, nulls the pointer, and audits child_avatar_removed for a child in the family', async () => {
    const { db, setValues, auditValues } = fakeDb({ ownershipRows: [{ id: CHILD_ID }] });

    const result = await removeChildAvatar(db, {
      familyId: FAMILY_ID,
      childId: CHILD_ID,
      actorUserId: ACTOR,
    });

    expect(result).toBe('removed');
    // Bytes leave first (mirrors the erase sweep) and both pointer + stamp are nulled.
    expect(removeDocument).toHaveBeenCalledWith(PATH, expect.anything());
    expect(setValues).toEqual([{ avatarPath: null, avatarUpdatedAt: null }]);
    expect(auditValues[0]).toMatchObject({
      familyId: FAMILY_ID,
      actor: ACTOR,
      actionTaken: 'child_avatar_removed',
      targetTable: 'children',
      targetId: CHILD_ID,
    });
  });

  it('returns not_found and touches NOTHING when the child is not in the caller family (rule #1)', async () => {
    const { db, auditValues } = fakeDb({ ownershipRows: [] });

    const result = await removeChildAvatar(db, {
      familyId: FAMILY_ID,
      childId: CHILD_ID,
      actorUserId: ACTOR,
    });

    expect(result).toBe('not_found');
    expect(removeDocument).not.toHaveBeenCalled();
    expect(auditValues).toHaveLength(0);
  });
});
