/**
 * Judge-only fixtures for the evening check-in screen (evening-request.md).
 *
 * The model decides whether a reply asks Hale for something, in any wording
 * and any language. These fixtures are not imported by a CI runner, not listed
 * in package.json, and not a CI step. Scoring them would be a paid model call.
 * `consent-and-evening-eval.mjs --estimate` prices that call and does not make it.
 */

export const EVENING_REQUEST_FIXTURES = [
  {
    id: 'en-diary',
    text: 'Park after daycare and both asleep by 7.',
    expect: { asks: false },
  },
  {
    id: 'en-request-no-mark',
    text: 'Fine can you find a swim class on Saturdays',
    expect: { asks: true },
  },
  {
    id: 'zh-request',
    text: '帮我找周六的游泳课',
    expect: { asks: true },
  },
  {
    id: 'ar-request',
    text: 'ساعدني أجد درس سباحة يوم السبت',
    expect: { asks: true },
  },
];
