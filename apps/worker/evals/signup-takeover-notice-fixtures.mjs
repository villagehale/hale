// The takeover texts — the corpus for VIL-718's one takeover link.
//
// Expectations come from the SPEC (packages/agent/skills/signup-takeover-notice.md): on
// `takeover`, the bubbles and the words on the takeover card that follows the first bubble;
// on `takeover_unfinished`, the honest close and no card. No fixed copy and no wording checks:
// the code gates (no link in a bubble; the card's own gate) decide what may go, and a judge
// reads the facts, the privacy and the language.
//
// Invented provider, family and values only (the repo is public).

const HOST = 'register.example-rec.test';
const OPENS = { local: 'Tuesday, December 1, 2026 at 7:00 a.m.', timeZone: 'America/Toronto' };
const SESSION = 'Preschool Swim Sat 9:00';

const BASE = {
  childFirstName: 'Ada',
  opensAt: OPENS,
  host: HOST,
  sessionLabel: SESSION,
};

/** The takeover card's own facts: the session, no open (it has passed), and the step. */
const card = (purpose) => ({ sessionLabel: SESSION, opensAt: null, takeover: purpose });

const takeover = (purpose, extra = {}) => ({
  ...BASE,
  kind: 'takeover',
  takeover: { purpose, mode: 'auto', minutes: 13, ended: null, ...extra },
  loginCard: card(purpose),
});

const unfinished = (purpose, ended) => ({
  ...BASE,
  kind: 'takeover_unfinished',
  takeover: { purpose, mode: 'auto', minutes: null, ended },
  loginCard: null,
});

const CARD_RULES = `The card title names the step and ${HOST}; the description gives the Saturday 9:00 swim session. The card never names Ada, never gives a price, and gives no time but the session's 9:00.`;
const NOTHING_HELD =
  'Nothing is registered and no spot is held: the text never says or suggests either.';

export const SIGNUP_TAKEOVER_NOTICE_FIXTURES = [
  {
    id: 'takeover-sign-in-en',
    facts: { ...takeover('sign_in'), language: 'en' },
    watchFor: `The site wants the parent to sign in. Says the link opens Hale's browser on the site, where they sign in with their own login and tap done; the link stays open 13 minutes; then Hale carries on with the registration. ${NOTHING_HELD} ${CARD_RULES}`,
  },
  {
    id: 'takeover-code-fr',
    facts: { ...takeover('code'), language: 'fr' },
    watchFor: `Every bubble AND both card fields in French, tu. The site sent the parent a one-time code: they type it on the page the link opens, then tap done; 13 minutes. Never asks them to send the code to Hale in the thread. ${NOTHING_HELD} ${CARD_RULES}`,
  },
  {
    id: 'takeover-passkey-en',
    facts: { ...takeover('passkey'), language: 'en' },
    watchFor: `The site wants a passkey, and a passkey on the parent's phone cannot reach Hale's browser: on the page the link opens they choose another way to sign in (a code or a password), then tap done; 13 minutes. Never says Hale uses the passkey. ${NOTHING_HELD} ${CARD_RULES}`,
  },
  {
    id: 'takeover-captcha-zh',
    facts: { ...takeover('captcha'), language: 'zh' },
    watchFor: `Every bubble AND both card fields in Chinese. The site wants a "prove you are human" check: the parent answers it themselves on the page the link opens, then taps done; 13 minutes. Never says Hale solves it. ${NOTHING_HELD} ${CARD_RULES}`,
  },
  {
    id: 'takeover-sign-in-assisted-es',
    facts: { ...takeover('sign_in', { mode: 'assisted' }), language: 'es' },
    watchFor: `Every bubble AND both card fields in Spanish. The parent signs in on the page the link opens, then taps done; 13 minutes. After done Hale carries on filling the registration for them to check and submit themselves (assisted): it never says Hale registers or pays. ${NOTHING_HELD} ${CARD_RULES}`,
  },
  {
    id: 'unfinished-ran-out-en',
    facts: { ...unfinished('captcha', 'ran_out'), language: 'en' },
    watchFor:
      "The link ran out before the parent tapped done, so Hale let its browser go and did not register Ada; the site's page follows if they want to do it themselves. No card (facts.loginCard is null). No promise to try again.",
  },
  {
    id: 'unfinished-still-there-fr',
    facts: { ...unfinished('code', 'still_there'), language: 'fr' },
    watchFor:
      "Every bubble in French, tu. The parent tapped done, but the site still asked for the code, so Hale stopped and did not register; the site's page follows if they want to do it themselves. No card. No promise to try again.",
  },
  {
    id: 'unfinished-again-en',
    facts: { ...unfinished('passkey', 'again'), language: 'en' },
    watchFor:
      "After the parent's steps the site asked for yet another one (a passkey), so Hale stopped there and did not register; the site's page follows if they want to do it themselves. No card. No promise to try again.",
  },
];

/**
 * Calibration: drafts a judge MUST score low (or the code gate must refuse). Every one is a
 * draft the gate alone would let through, except where `gate` says it must refuse.
 */
export const SIGNUP_TAKEOVER_NOTICE_BROKEN = [
  {
    id: 'asks-for-the-code-in-thread',
    fixtureId: 'takeover-code-fr',
    bubbles: ['Le site t’a envoyé un code.', 'Envoie-le-moi ici, je le tape pour toi.'],
    card: { title: `Ton code pour ${HOST}`, description: 'Natation préscolaire sam. 9:00' },
    breaks: 'asks the parent to send the code to Hale in the thread',
  },
  {
    id: 'promises-a-retry',
    fixtureId: 'unfinished-ran-out-en',
    bubbles: ['The link ran out before you finished.', "I'll try again in a few minutes."],
    card: null,
    breaks: 'promises Hale will try again on its own',
  },
  {
    id: 'card-english-for-zh',
    fixtureId: 'takeover-captcha-zh',
    bubbles: [
      '网站要你证明你不是机器人。',
      '点开链接,在页面上完成后点“完成”。',
      '链接开放13分钟。',
    ],
    card: { title: `Human check on ${HOST}`, description: 'Preschool Swim Sat 9:00' },
    breaks: 'the card is in English for a Chinese-speaking parent',
  },
  {
    id: 'card-names-child',
    fixtureId: 'takeover-sign-in-en',
    bubbles: [`I need you to sign in on ${'the site'}.`, 'Tap done when you are in.'],
    card: { title: `Sign Ada in on ${HOST}`, description: 'Preschool Swim Sat 9:00' },
    breaks: 'the card names the child',
    gate: true,
  },
];
