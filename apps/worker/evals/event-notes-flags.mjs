// The event-notes eval's flag allow-list (VIL-468). A copy of flood-line-flags.mjs from
// #926 (VIL-463), to be folded into one shared eval-flags module once that is on main.
// Parsed BEFORE the spend cap or any client exists: an unknown or missing mode exits, so a
// typo such as `--dyr` can never fall through to a live, paid run.

export const EVENT_NOTES_MODES = ['--dry', '--broken', '--cached-only', '--live'];

/** @returns {'dry' | 'broken' | 'cached-only' | 'live'} */
export function parseEventNotesFlags(args) {
  const unknown = args.filter((a) => !EVENT_NOTES_MODES.includes(a));
  if (unknown.length > 0) {
    throw new Error(
      `unknown flag(s): ${unknown.join(' ')}. Allowed: ${EVENT_NOTES_MODES.join(' ')}`,
    );
  }
  const modes = [...new Set(args)];
  if (modes.length !== 1) {
    throw new Error(`pass exactly one mode: ${EVENT_NOTES_MODES.join(' | ')} (live needs --live)`);
  }
  return modes[0].slice(2);
}

/** Outside --live there is no client: any attempt to reach a model throws. */
export function dryClient() {
  throw new Error('event-notes: a model call was attempted outside --live');
}
