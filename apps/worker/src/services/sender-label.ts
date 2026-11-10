/**
 * Who it is from, as a parent would name them: the display name if the header carries
 * one, otherwise the bare domain. NEVER the full address — a display name that is itself
 * an address falls through to the domain, because reading it is reading the mailbox out.
 */
export function senderLabel(from: string): string {
  const display = /^\s*"?([^"<]*?)"?\s*<[^>]*>\s*$/.exec(from)?.[1]?.trim();
  if (display !== undefined && display !== '' && !display.includes('@')) return display;
  const address = /<([^>]*)>/.exec(from)?.[1] ?? from;
  return address.split('@')[1]?.trim() ?? '';
}
