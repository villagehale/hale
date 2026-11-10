import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { captureProviderSession } from './session-capture';

const NOW = new Date('2026-10-28T15:00:00.000Z');

describe('captureProviderSession (production caller)', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.close();
  });
  beforeEach(() => {
    vi.stubEnv('APP_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('stores a session and writes an audit row with the host, never a cookie', async () => {
    const seeded = await seedFamily(db.database);
    const result = await captureProviderSession(db.database, {
      familyId: seeded.familyId,
      parentUserId: seeded.parentUserId,
      providerHost: 'harbor-rec.example',
      storageState: {
        cookies: [
          { name: 'JSESSIONID', value: 'rec-secret-fixture', domain: 'harbor-rec.example' },
        ],
      },
      capturedAt: NOW,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected capture');
    expect(result.providerHost).toBe('harbor-rec.example');

    const audits = await db.database
      .select({ after: schema.auditLog.after, targetTable: schema.auditLog.targetTable })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.familyId, seeded.familyId));
    const blob = JSON.stringify(audits);
    expect(blob).toContain('provider_signup_sessions');
    expect(blob).toContain('harbor-rec.example');
    expect(blob).toContain('captured');
    expect(blob).not.toContain('rec-secret-fixture');
  });

  it('refuses a password-named cookie and still names the refusal in audit', async () => {
    const seeded = await seedFamily(db.database);
    const result = await captureProviderSession(db.database, {
      familyId: seeded.familyId,
      parentUserId: seeded.parentUserId,
      providerHost: 'harbor-rec.example',
      storageState: { cookies: [{ name: 'password', value: 'x', domain: 'harbor-rec.example' }] },
      capturedAt: NOW,
    });
    expect(result).toEqual({ ok: false, reason: 'invalid_state' });
    const audits = await db.database
      .select({ after: schema.auditLog.after })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.familyId, seeded.familyId));
    expect(JSON.stringify(audits)).toContain('invalid_state');
  });

  it('is the production caller of storeProviderSession', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./session-capture.ts', import.meta.url)),
      'utf8',
    );
    expect(source).toContain('storeProviderSession');
    const route = readFileSync(
      fileURLToPath(new URL('../../app/api/signup/provider-session/route.ts', import.meta.url)),
      'utf8',
    );
    expect(route).toContain('captureProviderSession');
  });
});
