/**
 * Neighborhood poster plates — the same system as the Toronto pack.
 *
 * Shared chrome (wordmark, lede, amber bar, navy scan footer) is identical on
 * every plate. The plate supplies the neighborhood band and the QR source code.
 * The QR is an sms: deep link with a prefilled `Hi (via <code>)` body — never a
 * marketing-site URL.
 *
 * Indoor EarlyON boards use `earlyon-*` codes (same family as Georgetown /
 * Richmond Hill / Acton). City columns use `poster-*` and are not listed here.
 */

/** The live Hale number printed on the existing pack. */
export const PRINT_SMS_NUMBER = '+12892172279';

export const CHROME = {
  pronunciation: '/HAH-LEH/ · HAWAIIAN FOR HOME',
  headline: 'The family assistant you text.',
  subhead: 'It takes the family admin off your plate.',
  lines: [
    'Toronto rec, swim and camp registration — caught before it fills.',
    'Your week, planned. Nothing without your say-so.',
  ],
  cta: 'No app to install — Hale lives in your texts. Free to start.',
  scanTitle: 'Scan to text Hale',
  scanHelp: 'Point your phone camera at the code — it opens a text to Hale, already started.',
};

/**
 * @typedef {object} Plate
 * @property {string} sourceCode  SOURCE_VENUES key; rides the SMS body
 * @property {string} neighborhood  All-caps band, e.g. FOR OSSINGTON FAMILIES
 * @property {string} bandHeadline
 * @property {string} bandBody
 * @property {string} filename
 */

/** @type {Record<string, Plate>} */
export const PLATES = {
  'earlyon-ossington': {
    sourceCode: 'earlyon-ossington',
    neighborhood: 'FOR OSSINGTON FAMILIES',
    bandHeadline: 'Gone by 7:02 a.m.? Not anymore.',
    bandBody:
      'Swim lessons, day camps and rec programs around Trinity-Bellwoods sell out minutes after registration opens. Hale watches the dates that matter to your family — and texts you before they open.',
    filename: 'earlyon-ossington',
  },
};

export function displaySmsNumber(number = PRINT_SMS_NUMBER) {
  const nanp = number.match(/^\+1(\d{3})(\d{3})(\d{4})$/);
  return nanp ? `+1 (${nanp[1]}) ${nanp[2]}-${nanp[3]}` : number;
}

/** Cross-platform composer deep link — same `?&body=` form as apps/site/lib/text-entry.ts. */
export function smsHref(sourceCode, number = PRINT_SMS_NUMBER) {
  const body = `Hi (via ${sourceCode})`;
  return `sms:${number}?&body=${encodeURIComponent(body)}`;
}

export function plateFor(id) {
  const plate = PLATES[id];
  if (!plate) throw new Error(`unknown poster plate: ${id}`);
  return plate;
}
