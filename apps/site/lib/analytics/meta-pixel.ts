/**
 * Meta Pixel dataset ids from public env. Runtime never hardcodes an id.
 *
 * `NEXT_PUBLIC_META_PIXEL_ID` is one id, or a comma-separated list. Each entry
 * is trimmed; empties and anything that is not digits are dropped; duplicates
 * are removed. A single id is unchanged. CAPI on the app reads only the first
 * id: a later dataset has no CAPI access token yet, so it is browser-only.
 *
 * PageView must be readable on the statically generated marketing layout.
 * `CONVERSIONS_API_ENABLED` is a server env and is NOT inlined into client
 * bundles or `generateStaticParams` pages, so Google Ads (hardcoded) loaded
 * after Accept while the Pixel did not. Gate PageView on
 * `NEXT_PUBLIC_CONVERSIONS_API_ENABLED` (build-time), and still honor the
 * server flag when the layout actually runs at request time.
 *
 * Purchase still goes through CAPI on the app, behind the server flag.
 */

const META_PIXEL_ID = /^\d+$/;

export function conversionsPageViewEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return (
    env.NEXT_PUBLIC_CONVERSIONS_API_ENABLED === 'true' || env.CONVERSIONS_API_ENABLED === 'true'
  );
}

/** Trim, drop empties and non-digits, dedupe, keep first-seen order. */
export function parseMetaPixelIds(raw: string | readonly string[] | null | undefined): string[] {
  if (raw == null) return [];
  const text = typeof raw === 'string' ? raw : raw.join(',');
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const part of text.split(',')) {
    const id = part.trim();
    if (!META_PIXEL_ID.test(id) || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

export function metaPixelIdsFromEnv(
  env: Record<string, string | undefined> = process.env,
): string[] {
  return parseMetaPixelIds(env.NEXT_PUBLIC_META_PIXEL_ID);
}

export function metaPixelIdFromEnv(
  env: Record<string, string | undefined> = process.env,
): string | null {
  return metaPixelIdsFromEnv(env)[0] ?? null;
}

export function metaPixelIdsWhenConversionsEnabled(
  env: Record<string, string | undefined> = process.env,
): string[] {
  if (!conversionsPageViewEnabled(env)) return [];
  return metaPixelIdsFromEnv(env);
}

export function metaPixelIdWhenConversionsEnabled(
  env: Record<string, string | undefined> = process.env,
): string | null {
  return metaPixelIdsWhenConversionsEnabled(env)[0] ?? null;
}
