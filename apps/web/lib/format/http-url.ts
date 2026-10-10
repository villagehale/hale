/**
 * An absolute http(s) URL, or null.
 *
 * The same fail-closed rule the public village card uses: javascript:, data:, and
 * relative paths are not links a parent can open.
 */
export function safeHttpUrl(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? trimmed : null;
}
