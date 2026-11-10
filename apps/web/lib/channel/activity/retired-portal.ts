/**
 * Portals Hale must never send a parent to for City of Toronto rec/swim.
 *
 * ActiveTO is not rec registration. eFun has been gone since late 2024. A web
 * snippet that still names either as the place to register is a leak — the live
 * activity lane drops those picks rather than handing them to the coach.
 */
const RETIRED_REC_PORTAL = /\b(activeto|e-?fun)\b/i;

export function namesRetiredRecPortal(text: string): boolean {
  return RETIRED_REC_PORTAL.test(text);
}
