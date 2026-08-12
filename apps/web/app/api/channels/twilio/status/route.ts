import { handleTwilioStatusRequest } from '~/lib/channel/twilio/status';
import { db } from '~/lib/db';

// Node runtime: node:crypto HMAC + the Drizzle/pg ledger update.
export const runtime = 'nodejs';

/**
 * POST /api/channels/twilio/status — Twilio's delivery receipts (VIL-214 · A3).
 * Resolves the message by its provider id and advances channel_messages.status.
 */
export async function POST(req: Request): Promise<Response> {
  return handleTwilioStatusRequest(req, { database: db(), log: console });
}
