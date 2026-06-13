import { and, eq, sql } from 'drizzle-orm';
import { type Database, schema } from '@hearth/db';
import { db as defaultDb } from '~/lib/db';

/**
 * Maps an inbound webhook payload to a family_id by extracting the
 * provider-specific external identifier and looking up the `integrations`
 * row whose stored `provider_metadata.externalId` matches.
 *
 * Returns null when no family is bound (or the payload carries no usable
 * identifier) — the route handler returns 200 with `status: unbound` so the
 * provider doesn't retry.
 */
export async function resolveFamilyFromWebhook(
  provider: string,
  payload: unknown,
  database: Database = defaultDb(),
): Promise<string | null> {
  const externalId = extractExternalId(provider, payload);
  if (!externalId) {
    return null;
  }

  const rows = await database
    .select({ familyId: schema.integrations.familyId })
    .from(schema.integrations)
    .where(
      and(
        eq(schema.integrations.provider, provider as never),
        eq(sql`${schema.integrations.providerMetadata}->>'externalId'`, externalId),
      ),
    )
    .limit(1);

  return rows[0]?.familyId ?? null;
}

/**
 * Pulls the stable external identifier each provider carries in its webhook
 * body — the same value stored on the integration at connect time. Returns
 * null for unknown providers or payloads missing the identifier.
 */
function extractExternalId(provider: string, payload: unknown): string | null {
  if (!isRecord(payload)) {
    return null;
  }

  switch (provider) {
    case 'gmail':
      // Gmail push delivers the mailbox address inside the Pub/Sub message.
      return readString(payload.emailAddress);
    case 'gcal':
      // Google Calendar push echoes the watch channel id.
      return readString(payload.channelId) ?? readString(payload.resourceId);
    case 'outlook':
      // Microsoft Graph change notifications carry the subscription id.
      return readString(payload.subscriptionId);
    case 'stripe':
      // Stripe Connect events name the connected account.
      return readString(payload.account);
    case 'twilio':
      return readString(payload.AccountSid);
    default:
      return null;
  }
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
