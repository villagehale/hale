/**
 * Meta Pixel dataset id from public env. Runtime never hardcodes the id.
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

export function conversionsPageViewEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return (
    env.NEXT_PUBLIC_CONVERSIONS_API_ENABLED === 'true' || env.CONVERSIONS_API_ENABLED === 'true'
  );
}

export function metaPixelIdFromEnv(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const id = env.NEXT_PUBLIC_META_PIXEL_ID?.trim();
  return id ? id : null;
}

export function metaPixelIdWhenConversionsEnabled(
  env: Record<string, string | undefined> = process.env,
): string | null {
  if (!conversionsPageViewEnabled(env)) return null;
  return metaPixelIdFromEnv(env);
}
