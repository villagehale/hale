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
 * (Oakville), so the registry carries hosts and the hand-written facts below and
 * nothing else.
 *
 * VIL-338 · THE REGISTRY IS ALSO READ BACKWARDS. A registration sequence knows the
 * municipality of the M1 window it was proposed from and does not know a host until a
 * parent pastes one, so the pre-open ladder reaches a portal through
 * `portalForMunicipality`. The three fields that lookup exists to deliver are
 * hand-written for the same reason `portalLabel` is: the zone a course page's naive
 * `2026-08-11T06:30` is read in, and the account a parent has to already have at 6:29
 * a.m., are things a hostname cannot tell you and a text is going to assert.
 */

import type { Municipality } from '@hale/db';

export interface SpotPortal {
  /** How the outbound text names the source. Hand-written, never derived. */
  portalLabel: string;
  /** The M1 municipality this portal registers for, so a sequence proposed from a
   * window can find its portal and a pasted host can be checked against one. */
  municipality: Municipality;
  /** The IANA zone the portal's own naive datetimes (`StartDateValue`,
   * `PublicRegistrationStartDateValue`) are published in. */
  timeZone: string;
  /** What the parent needs to already have when the window opens, as the text says
   * it. Oakville's MemberSignIn answers 302 into the Town's Salesforce SAML SSO, so
   * this is NOT "a PerfectMind account" on every host. */
  accountLabel: string;
}

/**
 * The portals Hale has actually read. A host earns its place here only after a real
 * course page from that tenant has been fetched and parsed (availability.ts), because
 * an entry here is a promise that Hale can tell "full" from "open" on that site.
 */
export const SPOT_PORTAL_HOSTS: Record<string, SpotPortal> = {
  'cityofmarkham.perfectmind.com': {
    portalLabel: "Markham's portal",
    municipality: 'markham',
    timeZone: 'America/Toronto',
    accountLabel: 'a Markham portal account',
  },
  'townofoakville.perfectmind.com': {
    portalLabel: "Oakville's portal",
    municipality: 'oakville',
    timeZone: 'America/Toronto',
    accountLabel: 'a ServiceOakville account',
  },
};

/**
 * The portal that registers for a municipality, or null where Hale has not learned to
 * read one. Written over the registry rather than as a second hand-written map, so a
 * host added above is reachable from its municipality without a second edit.
 */
export function portalForMunicipality(municipality: Municipality): SpotPortal | null {
  return (
    Object.values(SPOT_PORTAL_HOSTS).find((portal) => portal.municipality === municipality) ?? null
  );
}

/** The one server-rendered BookMe4 route that carries a course's availability. */
export const COURSE_PAGE_PATH = /^\/(?:Clients|Contacts)\/BookMe4LandingPages\/CoursesLandingPage$/;

/**
 * The ceiling on the SANITIZED url — the string that goes into `source_url` and, more
 * to the point, into an SMS whose segment budget copy.ts computes against a 200-char
 * link. It is checked in url.test.ts and NOT at runtime, because the sanitized length
 * is `https://` + host + a vendor-fixed path + two 36-char GUIDs: nothing a parent can
 * paste moves it, and the only thing that can breach it is a new registry entry with a
 * very long host — which is a code change, so a test is where it gets caught.
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
  // The rebuild below is written from `hostname`, so a pasted `:8443` would be dropped
  // rather than honoured: Hale would store and poll a DIFFERENT address than the one
  // the parent checked. Refuse it instead. WHATWG has already dropped `:443`, which is
  // the address the registry approved, so this only ever sees a real second port.
  if (parsed.port !== '') return { ok: false, reason: 'not_a_course_page' };
  if (!COURSE_PAGE_PATH.test(parsed.pathname)) return { ok: false, reason: 'not_a_course_page' };

  const widgetId = parsed.searchParams.get('widgetId');
  const courseId = parsed.searchParams.get('courseId');
  if (widgetId === null || !GUID.test(widgetId)) return { ok: false, reason: 'not_a_course_page' };
  if (courseId === null || !GUID.test(courseId)) return { ok: false, reason: 'not_a_course_page' };

  // Lower-cased because (family_id, source_url) is the watch's identity and the portal
  // does not care: the same course pasted from an upper-case link would otherwise be a
  // second watch on one page, texting one parent twice.
  const widget = widgetId.toLowerCase();
  const course = courseId.toLowerCase();
  const url = `https://${parsed.hostname}${parsed.pathname}?widgetId=${widget}&courseId=${course}`;

  return {
    ok: true,
    url,
    host: parsed.hostname,
    portalLabel: portal.portalLabel,
    courseId: course,
  };
}
