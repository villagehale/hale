import { type Database, schema } from '@hale/db';
import { redactSignupAudit } from './audit';
import {
  type StoreProviderSessionResult,
  storeProviderSession,
} from './browser-use/vault';
import { signupProviderHost } from './consent';

/**
 * PRODUCTION CALLER for `storeProviderSession` (VIL-470).
 *
 * A parent's logged-in provider session (cookies and local storage) is stored
 * encrypted, never a password. The vault refuses a password-named key. Every
 * capture writes an audit row (host and outcome only). Absence of a usable
 * state is a named refusal, not a silent no-op.
 */

export type CaptureProviderSessionResult =
  | { ok: true; id: string; expiresAt: Date; providerHost: string }
  | { ok: false; reason: 'invalid_state' | 'invalid_host' };

export async function captureProviderSession(
  database: Database,
  input: {
    familyId: string;
    parentUserId: string;
    providerHost: string;
    storageState: unknown;
    capturedAt: Date;
  },
): Promise<CaptureProviderSessionResult> {
  const result: StoreProviderSessionResult = await storeProviderSession(database, input);
  const host = signupProviderHost(input.providerHost);
  await database.insert(schema.auditLog).values({
    familyId: input.familyId,
    actor: input.parentUserId,
    actionTaken: 'authorized_signup_step',
    targetTable: 'provider_signup_sessions',
    targetId: result.ok ? result.id : null,
    after: redactSignupAudit({
      step: 'provider_session',
      reason: result.ok ? 'captured' : result.reason,
      host: host || null,
    }),
  });
  if (!result.ok) return result;
  return { ok: true, id: result.id, expiresAt: result.expiresAt, providerHost: host };
}
