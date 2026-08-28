import { withWebhookFailureAlert } from '~/lib/channel/twilio/alert';
import { handleTwilioStatusRequest } from '~/lib/channel/twilio/status';
import { db } from '~/lib/db';

// Node runtime: node:crypto HMAC + the Drizzle/pg ledger update.
export const runtime = 'nodejs';

/**
 * POST /api/channels/twilio/status — Twilio's delivery receipts (VIL-214 · A3).
 * Resolves the message by its provider id and advances channel_messages.status.
 *
 * Inside the same failure boundary as the inbound webhook (VIL-331): a status webhook
 * that cannot reach the database stops advancing the ledger, and the receipts room goes
 * quietly stale rather than loudly wrong.
 */
export async function POST(req: Request): Promise<Response> {
  return withWebhookFailureAlert('twilio_status', async () =>
    handleTwilioStatusRequest(req, { database: db(), log: console }),
  );
}
