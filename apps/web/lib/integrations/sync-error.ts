/**
 * Why a connector sync failed — the one thing `status = 'error'` never said.
 *
 * A Google response body can carry an access token, a calendar title, or a parent's
 * address (rule #1), so NOTHING from it is stored: a code is the HTTP status Google
 * answered with, or the name of the step that gave up. Rule #11 is the reason this
 * exists at all — a sync that stops has to name what stopped it, in the row and in
 * one log line, or a connection dies quietly and nobody can say why.
 *
 * The code is persisted on `integrations.last_error_code`, cleared by the next
 * successful sync, and turned into a human sentence by {@link describeSyncError}.
 */

export type ConnectorErrorCode =
  /** Google answered with this HTTP status (`google_400`, `google_401`, …). */
  | `google_${number}`
  /** The access token needs refreshing and no refresh grant was ever stored. */
  | 'no_refresh_token'
  /** The refresh grant itself was rejected (the parent revoked access, typically). */
  | 'token_refresh_failed'
  /** Pages drained without the terminal cursor token the next run needs. */
  | 'cursor_missing'
  /** The stored token blob would not decrypt (tampered, or a key rotation leftover). */
  | 'decrypt_failed'
  /** Anything not named above. Honest: we do not know, rather than a wrong guess. */
  | 'unknown';

/**
 * A failure that already knows its own code. The catch classifies by TYPE — never by
 * parsing a message string, which is how a provider's wording ends up deciding our
 * control flow.
 */
export class ConnectorSyncError extends Error {
  readonly code: ConnectorErrorCode;

  constructor(code: ConnectorErrorCode) {
    super(code);
    this.name = 'ConnectorSyncError';
    this.code = code;
  }
}

export function classifyConnectorError(err: unknown): ConnectorErrorCode {
  return err instanceof ConnectorSyncError ? err.code : 'unknown';
}

export interface SyncErrorCopy {
  /** A short reason a parent can act on. Carries no provider text. */
  reason: string;
  /** Whether retrying alone can fix it — false means the grant has to be redone. */
  retries: boolean;
}

/**
 * Human copy for a stored code. Null when the row carries no code (it errored before
 * we recorded reasons) — the caller then says only that the sync is failing, which is
 * all it honestly knows.
 */
export function describeSyncError(code: string | null | undefined): SyncErrorCopy | null {
  if (!code) return null;
  if (code === 'google_401' || code === 'no_refresh_token' || code === 'token_refresh_failed') {
    return { reason: 'Google asked us to reconnect', retries: false };
  }
  if (code === 'google_410') return { reason: 'Google needs a fresh start', retries: true };
  if (code === 'google_400' || code === 'google_403') {
    return { reason: 'A request Google refused', retries: true };
  }
  return { reason: 'A temporary problem', retries: true };
}
