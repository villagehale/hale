/**
 * VIL-337 · the only links Hale will re-read on a family's behalf.
 *
 * A watched spot is a URL this process fetches every ten minutes, for weeks, without
 * anyone looking. That is a standing outbound request, so the question this file
 * answers is not "does this parse" but "is this a page we have decided to poll".
 *
 * THE REGISTRY IS HAND-WRITTEN AND THE LABEL COMES WITH IT. `portalLabel` is the
 * subject of the sentence a parent eventually receives ("Markham's portal now shows
 * 1 spot left..."), and it is a constant here rather than anything derived from the
 * host or written by a model: the attribution is the part of that message a parent
 * has to be able to trust without checking. A host absent from the registry is a
 * refusal with a sentence, never a silent watch — the registry may ship EMPTY and
 * every link then refuses.
 *
 * THE QUERY IS REBUILT, NOT FILTERED. What a parent pastes is whatever their browser
 * was carrying: PerfectMind's own `redirectedFromEmbededMode`, and — the reason this
 * is not a filter — anything else a portal decides to append later, session ids
 * included. A denylist is wrong by construction here; only two parameters are needed
 * to render the page (verified against the saved Markham course, which was fetched in
 * exactly this two-param form and served its full model), so two parameters are what
 * goes back to the portal, forever.
 *
 * The path is a VENDOR rule rather than a per-host one: PerfectMind BookMe4 serves
 * the same routes under `/Clients/` for most tenants and `/Contacts/` for others
 * (Oakville), so the registry carries hosts and labels and nothing else.
 */

export interface SpotPortal {
  /** How the outbound text names the source. Hand-written, never derived. */
  portalLabel: string;
}

/**
 * The portals Hale has actually read. A host earns its place here only after a real
 * course page from that tenant has been fetched and parsed (availability.ts), because
 * an entry here is a promise that Hale can tell "full" from "open" on that site.
 */
export const SPOT_PORTAL_HOSTS: Record<string, SpotPortal> = {
  'cityofmarkham.perfectmind.com': { portalLabel: "Markham's portal" },
  'townofoakville.perfectmind.com': { portalLabel: "Oakville's portal" },
};

/** The one server-rendered BookMe4 route that carries a course's availability. */
export const COURSE_PAGE_PATH = /^\/(?:Clients|Contacts)\/BookMe4LandingPages\/CoursesLandingPage$/;

/**
 * The ceiling on the SANITIZED url — the string that goes into `source_url` and, more
 * to the point, into an SMS whose segment budget copy.ts computes against a 200-char
 * link. The path and the two GUIDs are fixed by the vendor, so the only thing that can
 * breach this is a new registry entry with a very long host; url.test.ts checks every
 * shipped host against it.
 */
export const MAX_URL_CHARS = 200;

/**
 * The ceiling on what a parent may PASTE, which is a different number: the real
 * address-bar form of a Markham course page is 227 characters before anything is
 * dropped. This bound exists so an absurd paste is refused with a sentence instead of
 * being parsed.
 */
const MAX_PASTED_URL_CHARS = 512;

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type SpotUrlRefusal =
  | 'not_https'
  | 'has_credentials'
  | 'host_not_allowed'
  | 'not_a_course_page'
  | 'too_long';

export type SpotUrlResult =
  | { ok: true; url: string; host: string; portalLabel: string; courseId: string }
  | { ok: false; reason: SpotUrlRefusal };

export function sanitizeSpotUrl(raw: string): SpotUrlResult {
  if (raw.length > MAX_PASTED_URL_CHARS) return { ok: false, reason: 'too_long' };

  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    // A parent typing a description rather than pasting a link is the ordinary case,
    // and "that is not a course page" is the true thing to say about it.
    return { ok: false, reason: 'not_a_course_page' };
  }

  if (parsed.protocol !== 'https:') return { ok: false, reason: 'not_https' };
  if (parsed.username !== '' || parsed.password !== '') {
    return { ok: false, reason: 'has_credentials' };
  }

  const portal = SPOT_PORTAL_HOSTS[parsed.hostname];
  if (portal === undefined) return { ok: false, reason: 'host_not_allowed' };
  if (!COURSE_PAGE_PATH.test(parsed.pathname)) return { ok: false, reason: 'not_a_course_page' };

  const widgetId = parsed.searchParams.get('widgetId');
  const courseId = parsed.searchParams.get('courseId');
  if (widgetId === null || !GUID.test(widgetId)) return { ok: false, reason: 'not_a_course_page' };
  if (courseId === null || !GUID.test(courseId)) return { ok: false, reason: 'not_a_course_page' };

  const url = `https://${parsed.hostname}${parsed.pathname}?widgetId=${widgetId}&courseId=${courseId}`;
  if (url.length > MAX_URL_CHARS) return { ok: false, reason: 'too_long' };

  return { ok: true, url, host: parsed.hostname, portalLabel: portal.portalLabel, courseId };
}
