/**
 * VIL-661 · drive minutes between two real venue addresses (VIL-486).
 *
 * Minutes come from a routing client the caller injects. There is no guessed
 * buffer and no invented address. A miss is null: overlap then uses clock
 * time only.
 */

export interface TravelTimeClient {
  driveMinutes(originAddress: string, destAddress: string): Promise<number | null>;
}

const ROUTES_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes';

function mapsKey(): string {
  return process.env.GOOGLE_MAPS_API_KEY ?? process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? '';
}

function minutesFromDuration(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d+(?:\.\d+)?)s$/.exec(value.trim());
  if (!match?.[1]) return null;
  const seconds = Number(match[1]);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.ceil(seconds / 60);
}

/**
 * Google Routes when a Maps key is present. No key, a transport error, or a
 * body without a duration is null — never a guessed commute.
 */
export function defaultTravelTimeClient(fetchImpl: typeof fetch = fetch): TravelTimeClient {
  return {
    async driveMinutes(originAddress, destAddress) {
      const key = mapsKey();
      if (!key) return null;
      const origin = originAddress.trim();
      const dest = destAddress.trim();
      if (!origin || !dest) return null;
      try {
        const res = await fetchImpl(ROUTES_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Goog-Api-Key': key,
            'X-Goog-FieldMask': 'routes.duration',
          },
          body: JSON.stringify({
            origin: { address: origin },
            destination: { address: dest },
            travelMode: 'DRIVE',
          }),
        });
        if (!res.ok) return null;
        const body = (await res.json()) as { routes?: Array<{ duration?: string }> };
        return minutesFromDuration(body.routes?.[0]?.duration);
      } catch {
        return null;
      }
    },
  };
}

/** Null when either venue has no street address. Same address is zero minutes. */
export async function travelMinutesBetween(
  origin: { address: string | null } | null | undefined,
  dest: { address: string | null } | null | undefined,
  client: TravelTimeClient,
): Promise<number | null> {
  const from = origin?.address?.trim() ?? '';
  const to = dest?.address?.trim() ?? '';
  if (!from || !to) return null;
  if (from === to) return 0;
  return client.driveMinutes(from, to);
}
