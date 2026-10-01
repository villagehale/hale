/**
 * VIL-401 · near-real-time Gmail and Calendar detection.
 *
 * Dark by default. The 15-minute connector poll is the only sync until this is the
 * literal string `true`. A trailing newline (what `vercel env add` stores from a
 * piped echo) stays OFF — the same strict read as every other Hale flag.
 */
export const GOOGLE_PUSH_SYNC_ENABLED_ENV = 'GOOGLE_PUSH_SYNC_ENABLED';

/** Process env, or a test double that only sets the keys under test. */
export type PushEnv = Record<string, string | undefined>;

export function googlePushSyncEnabled(env: PushEnv = process.env): boolean {
  return env[GOOGLE_PUSH_SYNC_ENABLED_ENV] === 'true';
}
