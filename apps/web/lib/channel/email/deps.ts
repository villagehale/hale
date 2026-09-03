import { PostgresRateLimiter } from '~/lib/rate-limit/postgres';
import { captureInboundRouted } from '~/lib/analytics/server-capture';
import { db as defaultDb } from '~/lib/db';
import { enqueueChannelMessageReceived } from '~/lib/channel/twilio/deps';
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
 *
 * The ENQUEUE is A3's, imported rather than reimplemented. One text and one email are
 * both one job on one queue, and the identity that makes the hand-off idempotent — the
 * pg-boss job id IS the channel message id — only holds while there is a single producer
 * function. A second copy here would be a second place for that id to drift, and the
 * drifted one is the one that answers a parent twice.
 */
export function emailInboundDeps(): EmailInboundDeps {
  const database = defaultDb();
  return {
    database,
    content: () => createResendContentReader({ apiKey: requireEmailInboundConfig().apiKey }),
    limiter: new PostgresRateLimiter(database),
    enqueue: enqueueChannelMessageReceived,
    now: () => new Date(),
    log: console,
    countOutcome: async (outcome) => {
      await captureInboundRouted('email', outcome);
    },
  };
}
