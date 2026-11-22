import { type EnvBag, isEnabled } from '@hale/flags';

/**
 * VIL-717 · the instant ack with a time, and the one note when that time passes.
 *
 * Default off, and env-only (`ack-eta` in packages/flags/src/catalog.ts): exactly `true`
 * turns it on, `true\n`, `TRUE` and unset stay off, and no PostHog sync can light it. Off,
 * a slow 1:1 turn is exactly today's: a tapback on iMessage when reactions are lit, nothing
 * on SMS. The drain's deadline leg names `flag_off` and reads no table.
 */
export const ACK_ETA_ENABLED_ENV = 'ACK_ETA_ENABLED';

export function ackEtaEnabled(familyId?: string, env: EnvBag = process.env): boolean {
  return isEnabled('ack-eta', familyId, env);
}
