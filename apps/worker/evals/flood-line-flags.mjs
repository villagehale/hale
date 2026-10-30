// The flood-line eval's flag allow-list (VIL-463). Parsed BEFORE the spend cap or any
// client exists: an unknown or missing mode exits, so a typo such as `--dyr` can never
// fall through to a live, paid run. Live runs need an explicit `--live`.

export const FLOOD_LINE_MODES = ['--dry', '--broken', '--cached-only', '--live'];

/** @returns {'dry' | 'broken' | 'cached-only' | 'live'} */
export function parseFloodLineFlags(args) {
  const unknown = args.filter((a) => !FLOOD_LINE_MODES.includes(a));
  if (unknown.length > 0) {
    throw new Error(
      `unknown flag(s): ${unknown.join(' ')}. Allowed: ${FLOOD_LINE_MODES.join(' ')}`,
    );
  }
  const modes = [...new Set(args)];
  if (modes.length !== 1) {
    throw new Error(`pass exactly one mode: ${FLOOD_LINE_MODES.join(' | ')} (live needs --live)`);
  }
  return modes[0].slice(2);
}

/** Under --dry there is no client at all: any attempt to reach a model throws. */
export function dryClient() {
  throw new Error('flood-line --dry: a model call was attempted; --dry makes none');
}
