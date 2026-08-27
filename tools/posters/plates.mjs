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
    // Indoor EarlyON board at West Neighbourhood House, 248 Ossington Ave.
    // Registry: earlyon-ossington (M6J, poster 'Ossington') — no lifetime comp.
    code: 'earlyon-ossington',
    band: 'Ossington',
    localLine:
      'Swim lessons, day camps and rec programs at Trinity-Bellwoods and around Ossington sell out minutes after registration opens. Hale watches the dates that matter to your family — and texts you before they open.',
    qrValue: 'sms:+12892172279?&body=Hi%20(via%20earlyon-ossington)',
  },
];
