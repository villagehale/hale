/**
 * VIL-226 · Linq `phone_number.status_updated`. Flagged or throttled pauses
 * unrequested sends. A healthy status lifts the pause. This is a monitor, not
 * a cap: requested time-critical items still cross.
 */

const PAUSED_STATUSES = new Set(['flagged', 'throttled', 'limited', 'suspended']);

export function lineStatusPauses(status: string): boolean {
  const normalized = status.trim().toLowerCase();
  if (PAUSED_STATUSES.has(normalized)) return true;
  return normalized.includes('flag') || normalized.includes('throttl');
}
