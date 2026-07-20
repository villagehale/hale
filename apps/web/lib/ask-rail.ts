// Shared between the coach page's pre-paint script and the client Ask surface, so
// the server reads the real string values (not a client-reference proxy). The two
// Ask side rails persist their collapsed choice like the sidebar: a localStorage
// key mirrored onto a root data attribute before first paint, so a collapsed rail
// never flashes open on load. Default (absent key) is OPEN.
export const ASK_RAIL_LEFT_KEY = 'hale.ask.rail-left';
export const ASK_RAIL_RIGHT_KEY = 'hale.ask.rail-right';

/** Root data attributes the pre-paint script + CSS drive the rail widths off. */
export const ASK_RAIL_LEFT_ATTR = 'askRailLeft';
export const ASK_RAIL_RIGHT_ATTR = 'askRailRight';
