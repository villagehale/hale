/**
 * Meta Pixel dataset id from public env. Runtime never hardcodes the id.
 * PageView is behind CONVERSIONS_API_ENABLED. Purchase still goes through CAPI.
 */

export function metaPixelIdFromEnv(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const id = env.NEXT_PUBLIC_META_PIXEL_ID?.trim();
  return id ? id : null;
}

export function metaPixelIdWhenConversionsEnabled(
  env: Record<string, string | undefined> = process.env,
): string | null {
  if (
    env.CONVERSIONS_API_ENABLED !== 'true' &&
    env.NEXT_PUBLIC_CONVERSIONS_API_ENABLED !== 'true'
  ) {
    return null;
  }
  return metaPixelIdFromEnv(env);
}
