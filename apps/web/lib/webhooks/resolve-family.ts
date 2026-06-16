import { and, eq, sql } from 'drizzle-orm';
import { type Database, schema } from '@hale/db';
import { db as defaultDb } from '~/lib/db';
import { getAdapter } from '~/lib/webhooks/registry';

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
 * Pulls the stable external identifier a provider carries in its webhook body by
 * dispatching to the provider's registry adapter — the per-provider logic lives
 * in one place (the registry), not a switch here. Returns null for unknown
 * providers or payloads missing the identifier.
 */
function extractExternalId(provider: string, payload: unknown): string | null {
  const adapter = getAdapter(provider);
  if (!adapter) {
    return null;
  }
  return adapter.extractExternalId(payload);
}
