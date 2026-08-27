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
    introLine:
      'Rec, swim and camp registration — caught before it fills.<br>Your week, planned. Nothing without your say-so.',
    // The Georgetown gift-card layout: the comp IS the card (eyebrow + big serif
    // title + one explainer), and the scan pill echoes it.
    eyebrow: 'A gift for Markham EarlyON families',
    cardTitle: 'The Family plan — free, for&nbsp;life.',
    localLine:
      "Hale's top tier — full autonomy with your OK, bookings handled, priority support. Free forever when you join from this poster.",
    scanPill: 'Scan → your Family plan is free, for life',
    qrValue: 'https://www.villagehale.com/text?s=earlyon-markham&utm_source=earlyon-markham&utm_medium=flyer',
    qrEcc: 'H',
    scan: { title: 'Scan to start', hint: 'Point your phone camera at the code — it opens villagehale.com.', site: 'villagehale.com' },
  },
  {
    // Indoor EarlyON board at West Neighbourhood House, 248 Ossington Ave.
    // Registry: earlyon-ossington (M6J, poster 'Ossington') — no lifetime comp.
    code: 'earlyon-ossington',
    band: 'Ossington',
    eyebrow: 'A gift for Ossington EarlyON families',
    cardTitle: 'The Family plan — free, for&nbsp;life.',
    localLine:
      "Hale's top tier — full autonomy with your OK, bookings handled, priority support. Free forever when you join from this poster.",
    scanPill: 'Scan → your Family plan is free, for life',
    qrValue: 'sms:+12892172279?&body=Hi%20(via%20earlyon-ossington)',
  },
];
