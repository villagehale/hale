// One entry per poster plate. A plate changes exactly three things against the
// pack chrome (render.mjs): the neighborhood band, the local sentence, and the
// QR payload. Everything else is the deck.
//
// QR payloads: street columns use the /text?s= page (a passerby gets the landing
// with the prefilled composer); indoor boards at a partner venue use the sms:
// deep link directly — the person is standing still, phone in hand, and the code
// must resolve to the venue in SOURCE_VENUES (apps/web/lib/channel/intake/copy.ts)
// via the "(via <code>)" suffix the site would otherwise add.
export const PLATES = [
  {
    // Indoor EarlyON board at EarlyON Markham / Family Day, 3990 14th Avenue —
    // board placement pending Sheri's yes. Pure web attribution (UTM on the
    // homepage; PostHog replay + utm capture live) — no source code, no phone
    // number on the plate, camera opens the site.
    code: 'earlyon-markham',
    outName: 'earlyon-markham-poster',
    band: 'Markham',
    // Facts from markham.ca (Registration and General Information): e-reg opens
    // 6:30 AM; "2026 Fall Programs, Swim Lessons and Winter Break Camps —
    // Register starting Aug. 11 at 6:30 AM". Winter 2027 dates unpublished, so
    // the plate promises watching, never a date we don't have.
    introLine:
      'Markham rec, swim and camp registration — caught before it fills.<br>Your week, planned. Nothing without your say-so.',
    cardTitle: 'Gone by 6:32 a.m.? Not&nbsp;anymore.',
    localLine:
      'Markham registration opens at 6:30 a.m. — winter dates are next. Hale watches the ones that matter to your family and texts you before they open.',
    qrValue: 'https://www.villagehale.com/?utm_source=earlyon-markham&utm_medium=flyer',
    qrEcc: 'H',
    scan: { title: 'Scan to start', hint: 'Point your phone camera at the code — it opens villagehale.com.', site: 'villagehale.com' },
  },
  {
    // Indoor EarlyON board at West Neighbourhood House, 248 Ossington Ave.
    // Registry: earlyon-ossington (M6J, poster 'Ossington') — no lifetime comp.
    code: 'earlyon-ossington',
    band: 'Ossington',
    localLine:
      'Swim lessons, day camps and rec programs at Trinity-Bellwoods and around Ossington sell out minutes after registration opens. Hale watches the dates that matter to your family — and texts you before they open.',
    qrValue: 'sms:+12892172279?&body=Hi%20(via%20earlyon-ossington)',
  },
];
