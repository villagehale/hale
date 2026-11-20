import { type EnvBag, isEnabled, posthogFlagsPathEnabled } from '@hale/flags';

/**
 * VIL-717 · the instant ack with a time, and the one note when that time passes.
 *
 * Default off. Exactly `true` turns it on (`ack-eta` in packages/flags/src/catalog.ts);
 * `true\n`, `TRUE` and unset stay off. Off, a slow 1:1 turn is exactly today's: a tapback
 * on iMessage when reactions are lit, nothing on SMS, and the drain's deadline leg names
 * `flag_off` and reads nothing.
 */
export const ACK_ETA_ENABLED_ENV = 'ACK_ETA_ENABLED';

export function ackEtaEnabled(familyId?: string, env: EnvBag = process.env): boolean {
  return isEnabled('ack-eta', familyId, env);
}

/**
 * Whether ANY family could be lit, which is the drain leg's question before it reads a
 * row. The env value answers it while PostHog flags are off; once they are on, one family
 * may be lit through PostHog with the env unset, so the leg reads the due rows and asks
 * {@link ackEtaEnabled} per family.
 */
export function ackEtaMayBeLit(env: EnvBag = process.env): boolean {
  return ackEtaEnabled(undefined, env) || posthogFlagsPathEnabled(env);
}
