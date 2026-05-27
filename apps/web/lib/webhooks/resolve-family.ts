/**
 * Maps an inbound webhook payload to a family_id by inspecting the
 * provider-specific identifiers and looking up the matching `integrations` row.
 *
 * Returns null when no family is bound — the route handler returns 200 with
 * `status: unbound` so the provider doesn't retry.
 */

export async function resolveFamilyFromWebhook(
  provider: string,
  payload: unknown,
): Promise<string | null> {
  // Each provider has a different identifier shape. The real implementation
  // looks up `integrations` by (provider, provider_external_id) and returns
  // the bound family_id.
  //
  // Stubbed for v1; wired per-provider as integrations are connected.
  if (!isRecord(payload)) {
    return null;
  }
  void provider;
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
