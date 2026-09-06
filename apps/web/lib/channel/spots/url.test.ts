import { describe, expect, it } from 'vitest';
import {
  COURSE_PAGE_PATH,
  MAX_URL_CHARS,
  SPOT_PORTAL_HOSTS,
  portalForMunicipality,
  sanitizeSpotUrl,
} from './url';

/**
 * VIL-337 · the gate every watched link passes through.
 *
 * Two things are being proved here, and the second is the one that keeps a family's
 * data out of a municipal server's access log: a link Hale re-fetches every ten
 * minutes must be a link Hale knows how to read (the registry and the vendor path),
 * and the query that goes back to the portal must carry NOTHING the parent's own
 * browser happened to be carrying — a session id, an embed flag, a tracking tail.
 * The sanitizer therefore REBUILDS the query from two parsed GUIDs rather than
 * filtering the one it was handed.
 */

const WIDGET = 'bfd08479-60d6-43d9-b586-5b4c8305a003';
const COURSE = '4241ad2f-9b67-464f-9f19-ad5f46d4a92d';
const MARKHAM = 'https://cityofmarkham.perfectmind.com';
const COURSE_PAGE = `${MARKHAM}/Clients/BookMe4LandingPages/CoursesLandingPage`;
const CLEAN = `${COURSE_PAGE}?widgetId=${WIDGET}&courseId=${COURSE}`;
/** The address the saved oakville-course.html was fetched from, verbatim. */
const OAKVILLE_WIDGET = '15f6af07-39c5-473e-b053-96653f77a406';
const OAKVILLE_COURSE = '16765c8e-835f-4ba6-9803-bbc84bd5ff8f';
const OAKVILLE_PAGE =
  'https://townofoakville.perfectmind.com/Contacts/BookMe4LandingPages/CoursesLandingPage';

describe('sanitizeSpotUrl — what it accepts', () => {
  it('rebuilds the query from the two GUIDs and drops everything else', () => {
    // The form a parent's address bar actually carries: PerfectMind's own embed flag,
    // plus a session id standing in for whatever else a portal decides to append.
    const pasted =
      `${COURSE_PAGE}?widgetId=${WIDGET}&redirectedFromEmbededMode=False` +
      `&courseId=${COURSE}&sessionId=SECRET#dates`;

    const result = sanitizeSpotUrl(pasted);

    expect(result).toEqual({
      ok: true,
      url: CLEAN,
      host: 'cityofmarkham.perfectmind.com',
      portalLabel: "Markham's portal",
      courseId: COURSE,
    });
    expect(result.ok && result.url).not.toContain('SECRET');
  });

  it('leaves a clean two-param link byte-identical', () => {
    // The positive control for the rebuild: it must be a no-op on what it emits, or
    // (family_id, source_url) identity would depend on how the parent copied the link.
    const result = sanitizeSpotUrl(CLEAN);

    expect(result.ok && result.url).toBe(CLEAN);
  });

  it('lower-cases the GUIDs, so one course is one watch however it was copied', () => {
    // (family_id, source_url) is the watch's identity and `readSpot` compares EventId
    // case-insensitively, so an upper-case paste that sanitized to its own string would
    // be a SECOND watch polling the same page and texting the same parent twice.
    const result = sanitizeSpotUrl(
      `${COURSE_PAGE}?widgetId=${WIDGET.toUpperCase()}&courseId=${COURSE.toUpperCase()}`,
    );

    expect(result).toEqual({
      ok: true,
      url: CLEAN,
      host: 'cityofmarkham.perfectmind.com',
      portalLabel: "Markham's portal",
      courseId: COURSE,
    });
  });

  it("sanitizes Oakville's real /Contacts/ address to its own label", () => {
    // The exact link oakville-course.html was fetched from, with the embed flag a
    // parent's address bar carries. Oakville serves these routes under /Contacts/
    // rather than /Clients/, and its label is Oakville's, never the first entry's.
    const result = sanitizeSpotUrl(
      `${OAKVILLE_PAGE}?widgetId=${OAKVILLE_WIDGET}&redirectedFromEmbededMode=False&courseId=${OAKVILLE_COURSE}`,
    );

    expect(result).toEqual({
      ok: true,
      url: `${OAKVILLE_PAGE}?widgetId=${OAKVILLE_WIDGET}&courseId=${OAKVILLE_COURSE}`,
      host: 'townofoakville.perfectmind.com',
      portalLabel: "Oakville's portal",
      courseId: OAKVILLE_COURSE,
    });
  });

  it('takes /Contacts/ as a vendor rule rather than a per-host one', () => {
    // The prefix is tenant configuration, not something the registry records, so the
    // path check must not be keyed to the host it was first measured on.
    const result = sanitizeSpotUrl(
      `${MARKHAM}/Contacts/BookMe4LandingPages/CoursesLandingPage?widgetId=${WIDGET}&courseId=${COURSE}`,
    );

    expect(result.ok).toBe(true);
    expect(result.ok && result.url).toContain('/Contacts/BookMe4LandingPages/CoursesLandingPage');
  });
});

describe('sanitizeSpotUrl — what it refuses', () => {
  it.each([
    [
      'http, so a watched link cannot be read in transit',
      CLEAN.replace('https:', 'http:'),
      'not_https',
    ],
    [
      'embedded credentials, which would be re-sent every ten minutes',
      `https://parent:hunter2@cityofmarkham.perfectmind.com/Clients/BookMe4LandingPages/CoursesLandingPage?widgetId=${WIDGET}&courseId=${COURSE}`,
      'has_credentials',
    ],
    [
      'a portal nobody has taught Hale to read',
      `https://anytown.perfectmind.com/Clients/BookMe4LandingPages/CoursesLandingPage?widgetId=${WIDGET}&courseId=${COURSE}`,
      'host_not_allowed',
    ],
    [
      'the widget shell rather than a course page',
      `${MARKHAM}/Clients/BookMe4?widgetId=${WIDGET}`,
      'not_a_course_page',
    ],
    [
      'a course id that is not a GUID',
      `${COURSE_PAGE}?widgetId=${WIDGET}&courseId=283993`,
      'not_a_course_page',
    ],
    ['no widget id at all', `${COURSE_PAGE}?courseId=${COURSE}`, 'not_a_course_page'],
    ['something that is not a link', 'the swim one on markham dot ca', 'not_a_course_page'],
    ['600 characters of paste', `${CLEAN}&${'junk=1&'.repeat(80)}`, 'too_long'],
    [
      'an explicit port, which the rebuild would have silently dropped',
      `https://cityofmarkham.perfectmind.com:8443/Clients/BookMe4LandingPages/CoursesLandingPage?widgetId=${WIDGET}&courseId=${COURSE}`,
      'not_a_course_page',
    ],
  ])('refuses %s', (_why, raw, reason) => {
    expect(sanitizeSpotUrl(raw)).toEqual({ ok: false, reason });
  });

  it('still takes the canonical port written out in full', () => {
    // The positive control for the row above: :443 IS the address the registry
    // approved, and WHATWG drops it at parse, so refusing every written port would
    // refuse a link that is already the one we would have rebuilt.
    expect(sanitizeSpotUrl(CLEAN.replace(MARKHAM, `${MARKHAM}:443`))).toMatchObject({
      ok: true,
      url: CLEAN,
    });
  });
});

describe('SPOT_PORTAL_HOSTS', () => {
  it('carries a hand-written label for every host, and none of them can outgrow the SMS', () => {
    // MAX_URL_CHARS is the ceiling copy.ts's segment budget is written against, and the
    // only thing that can breach it is a new registry entry: the path and the two GUIDs
    // are fixed by the vendor. So the registry is where the ceiling is checked.
    for (const [host, entry] of Object.entries(SPOT_PORTAL_HOSTS)) {
      const url = `https://${host}/Clients/BookMe4LandingPages/CoursesLandingPage?widgetId=${WIDGET}&courseId=${COURSE}`;
      const result = sanitizeSpotUrl(url);
      expect(result).toEqual({
        ok: true,
        url,
        host,
        portalLabel: entry.portalLabel,
        courseId: COURSE,
      });
      expect(url.length).toBeLessThanOrEqual(MAX_URL_CHARS);
    }
    expect(Object.keys(SPOT_PORTAL_HOSTS).length).toBeGreaterThan(0);
  });

  it('names the vendor route and nothing wider', () => {
    expect(COURSE_PAGE_PATH.test('/Clients/BookMe4LandingPages/CoursesLandingPage')).toBe(true);
    expect(COURSE_PAGE_PATH.test('/Contacts/BookMe4LandingPages/CoursesLandingPage')).toBe(true);
    expect(COURSE_PAGE_PATH.test('/Clients/BookMe4LandingPages/CoursesLandingPageX')).toBe(false);
    expect(COURSE_PAGE_PATH.test('/Other/BookMe4LandingPages/CoursesLandingPage')).toBe(false);
  });
});

/**
 * VIL-338 · the three fields a registry entry gained, and the lookup that runs the
 * other way.
 *
 * A registration sequence knows a MUNICIPALITY (the M1 window it was proposed from);
 * it does not know a host until a parent pastes one. Everything the pre-open ladder
 * says about a portal — the account a parent needs before 6:30 a.m., and the zone the
 * course page's naive `2026-08-11T06:30` is read in — is therefore reached from the
 * municipality, and every value is hand-written beside the label for the same reason
 * the label is: none of it can be derived from a hostname, and all of it is in a text.
 */

/** Transcribed from the design, not from the module: these are the four things Hale
 * asserts about a portal in a parent's inbox. */
const EXPECTED_PORTALS = {
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
} as const;

describe('SPOT_PORTAL_HOSTS — every entry carries all four hand-written fields', () => {
  it('holds exactly the hosts transcribed above', () => {
    // Kills the mutation that adds a host with a label and leaves the other three to
    // be inferred later: an entry missing its zone would read a 6:30 a.m. course clock
    // in whatever zone the runtime happens to be in, and the compiler cannot see the
    // difference between a wrong zone and a right one.
    expect(Object.keys(SPOT_PORTAL_HOSTS).sort()).toEqual(Object.keys(EXPECTED_PORTALS).sort());
  });

  it.each(Object.entries(EXPECTED_PORTALS))('%s carries its four values', (host, expected) => {
    // Kills the mutation that copies one entry's account sentence onto the other:
    // Oakville's sign-in is the Town's ServiceOakville SSO, not a PerfectMind account,
    // and telling an Oakville parent to make "a Markham portal account" is the kind of
    // wrong that only a parent at 6:29 a.m. would discover.
    const entry = SPOT_PORTAL_HOSTS[host];
    if (entry === undefined) throw new Error(`${host} left the registry`);
    expect(entry).toEqual(expected);
    // Kills a zone string the platform cannot resolve ('Amercia/Toronto', 'EDT'),
    // which would throw inside the clock arithmetic rather than at the registry.
    expect(() => new Intl.DateTimeFormat('en-CA', { timeZone: entry.timeZone })).not.toThrow();
  });

  it('names each municipality once, so the reverse lookup has one answer', () => {
    // Kills a second host on the same municipality, which would make
    // portalForMunicipality's answer depend on key order.
    const municipalities = Object.values(SPOT_PORTAL_HOSTS).map((entry) => entry.municipality);

    expect(new Set(municipalities).size).toBe(municipalities.length);
  });
});

describe('portalForMunicipality', () => {
  it('answers markham with the Markham entry', () => {
    expect(portalForMunicipality('markham')).toEqual(
      EXPECTED_PORTALS['cityofmarkham.perfectmind.com'],
    );
  });

  it("answers oakville with Oakville's entry, never the first one in the registry", () => {
    // Kills `Object.values(SPOT_PORTAL_HOSTS)[0]` and any lookup that stops at the
    // first entry — the same failure the sanitizer's Oakville test exists for.
    expect(portalForMunicipality('oakville')).toEqual(
      EXPECTED_PORTALS['townofoakville.perfectmind.com'],
    );
  });

  it('answers a covered municipality with no portal with null', () => {
    // Toronto is a real M1 municipality with real registration windows and NO portal
    // Hale has learned to read. Kills a lookup that returns `undefined` (which reads
    // as "not asked" at a call site testing `=== null`) or a default entry, either of
    // which would point a Toronto family at Markham's portal.
    expect(portalForMunicipality('toronto')).toBeNull();
  });

  it('round-trips every registry entry through its own municipality', () => {
    // Kills a hand-written switch that drifts from the registry it is written beside:
    // a new host whose municipality nobody added to the lookup would be watchable by
    // paste and invisible to the ladder that offers to watch it.
    for (const entry of Object.values(SPOT_PORTAL_HOSTS)) {
      expect(portalForMunicipality(entry.municipality)).toEqual(entry);
    }
  });
});
