/**
 * VIL-415. Exactly `true` turns the AI intent router and the AI copy on.
 * Anything else, including unset, `TRUE`, `1`, and `on`, keeps today's path.
 */
export function aiIntentRouterEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.AI_INTENT_ROUTER_ENABLED === 'true';
}
