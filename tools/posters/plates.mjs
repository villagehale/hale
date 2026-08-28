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
    // Outdoor Town boards, Oakville — 7 copies, founder-pinned, no form, Town
    // may remove: River Oaks CC, Glen Abbey CC, Town Hall, Central Library
    // (outside), Town Square, Bronte Boardwalk, Kerr St at Normandy Pl.
    // No comp (outdoor, no partner cost). oakville.ca: fall registration "now
    // open", no open date published — so the plate says open, never a date.
    code: 'oakville-outdoor',
    outName: 'oakville-outdoor-poster',
    band: 'Oakville',
    introLine:
      'Rec, swim and camp registration — caught before it fills.<br>Your week, planned. Nothing without your say-so.',
    cardTitle: 'Leftover spots, watched.',
    localLine:
      'Oakville fall opened Aug 11. Hale watches leftover swim, camp, and rec spots, and texts you when the next date is posted.',
    qrValue: 'https://www.villagehale.com/?utm_source=oakville-outdoor-board&utm_medium=flyer',
    qrEcc: 'H',
    scan: { title: 'Scan to start', hint: 'Point your phone camera at the code — it opens villagehale.com.', site: 'villagehale.com' },
  },
  {
    // Indoor board at 3990 14th Avenue, Markham. "EarlyON" is a trademarked term
    // (Ontario) — it appears in no plate copy and no new code. The earlier
    // earlyon-markham cut is already hanging at the venue; its code stays live as
    // a registry alias (copy.ts) until this reprint replaces it.
    code: 'markham',
    outName: 'markham-poster',
    band: 'Markham',
    introLine:
      'Rec, swim and camp registration — caught before it fills.<br>Your week, planned. Nothing without your say-so.',
    // The Georgetown gift-card layout: the comp IS the card (eyebrow + big serif
    // title + one explainer), and the scan pill echoes it.
    eyebrow: 'A gift for Markham families',
    cardTitle: 'The Family plan — free, for&nbsp;life.',
    localLine:
      "Hale's top tier — full autonomy with your OK, bookings handled, priority support. Free forever when you join from this poster.",
    scanPill: 'Scan → your Family plan is free, for life',
    qrValue: 'https://www.villagehale.com/text?s=markham&utm_source=markham&utm_medium=flyer',
    qrEcc: 'H',
    scan: { title: 'Scan to start', hint: 'Point your phone camera at the code — it opens villagehale.com.', site: 'villagehale.com' },
  },
  {
    // Indoor board at West Neighbourhood House, 248 Ossington Ave.
    // Registry: ossington (M6J, poster 'Ossington') — carries the lifetime comp.
    code: 'ossington',
    band: 'Ossington',
    eyebrow: 'A gift for Ossington families',
    cardTitle: 'The Family plan — free, for&nbsp;life.',
    localLine:
      "Hale's top tier — full autonomy with your OK, bookings handled, priority support. Free forever when you join from this poster.",
    scanPill: 'Scan → your Family plan is free, for life',
    qrValue: 'sms:+12892172279?&body=Hi%20(via%20ossington)',
  },
];
