import { PostgresRateLimiter } from '~/lib/rate-limit/postgres';
import { db as defaultDb } from '~/lib/db';
import { requireEmailInboundConfig } from './config';
import { createResendContentReader } from './content';
import type { EmailInboundDeps } from './inbound';

/**
 * The production wiring for the inbound-email webhook — the one place the leg meets a
 * real database, a real limiter, and a real provider client. Every module beside it
 * takes its collaborators as arguments, so the tests never do.
 *
 * The content reader is a THUNK, and that is the point: constructing it reaches for a
 * Resend client, and a forged request must never cause one. The route builds these deps
 * eagerly but the reader is not touched until the signature has passed — the same lazy
 * shape twilio/deps.ts uses for its intake deps, for the same reason.
 */
export function emailInboundDeps(): EmailInboundDeps {
  const database = defaultDb();
  return {
    database,
    content: () => createResendContentReader({ apiKey: requireEmailInboundConfig().apiKey }),
    limiter: new PostgresRateLimiter(database),
    now: () => new Date(),
    log: console,
  };
}
