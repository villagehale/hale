/**
 * Human copy for the OAuth scopes a connector connection actually holds. Chips
 * render from the CONNECTION's granted scopes, never from a hardcoded per-provider
 * list — so a scope this map doesn't know renders literally and is never labelled
 * read-only. The page can never claim less (or safer) access than a row carries
 * (rule #1).
 */
const GOOGLE_SCOPE_COPY: Record<string, { label: string; readOnly: boolean }> = {
  'https://www.googleapis.com/auth/calendar.readonly': { label: 'Calendar', readOnly: true },
  'https://www.googleapis.com/auth/gmail.readonly': { label: 'Mail', readOnly: true },
  'https://www.googleapis.com/auth/drive.readonly': { label: 'Files', readOnly: true },
};

export function describeScope(scope: string): { label: string; readOnly: boolean } {
  return GOOGLE_SCOPE_COPY[scope] ?? { label: scope, readOnly: false };
}
