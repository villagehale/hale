// The sign-up outcome reply — the corpus (VIL-558 step 0).
//
// Expectations come from the SPEC (packages/agent/skills/signup-outcome-reply.md): one text
// telling the parent what happened after they said yes, and what they do next. Every
// Browser Use outcome a yes can end in, in en, fr and zh. No fixed copy and no wording
// checks: the code gate holds the link, a judge reads the facts and the tone.
//
// Invented provider, family and values only (the repo is public).

const REC = 'https://register.example-rec.test/activity/42';
const LIVE = 'https://live.browser-use.com/s/fixture-live-view-token';

const SESSION = { en: 'Sat 9:30 AM', fr: 'sam. 9 h 30', zh: '周六上午9:30' };
const PACK = [
  { slot: 'child_first_name', value: 'Lena' },
  { slot: 'child_last_name', value: 'Ferreira' },
  { slot: 'parent_first_name', value: 'Sam' },
  { slot: 'parent_email', value: 'sam@example.test' },
];

const NO_PACK = 'There is no pack: the text names no child and lists no personal details.';
const NO_RETRY = 'No promise that Hale will retry, keep watching or follow up.';

/** One case per outcome. `facts` omits sessionLabel and language, set per language. */
const CASES = [
  {
    id: 'needs-login-no-session',
    facts: {
      outcome: 'needs_login',
      reason: 'no_provider_session',
      link: REC,
      linkIs: 'registration_page',
      pack: PACK,
    },
    watchFor: `Says Hale can't complete sign-ups on this site yet and the parent signs up at the link, with the pack values to have ready. Never says a login failed or was tried. ${NO_RETRY}`,
  },
  {
    id: 'needs-login-login-wall',
    facts: {
      outcome: 'needs_login',
      reason: 'login_wall',
      link: LIVE,
      linkIs: 'live_browser',
      holdMinutes: 8,
    },
    watchFor: `Says Hale could not get into the parent's account on the site; the parent can sign in and finish in the open browser at the link, in about 8 minutes. ${NO_PACK} ${NO_RETRY}`,
  },
  {
    id: 'needs-login-group',
    facts: {
      outcome: 'needs_login',
      reason: 'no_provider_session',
      link: REC,
      linkIs: 'registration_page',
      audience: 'group',
    },
    watchFor: `Says Hale can't complete sign-ups on this site yet and the parent signs up at the link. Never says a login failed. ${NO_PACK} ${NO_RETRY}`,
  },
  {
    id: 'error-not-configured',
    facts: {
      outcome: 'error',
      reason: 'not_configured',
      link: REC,
      linkIs: 'registration_page',
      pack: PACK,
    },
    watchFor: `Says Hale could not do this one and the parent can sign up at the link, with the pack values to have ready. No system talk. ${NO_RETRY}`,
  },
  {
    id: 'error-engine-threw',
    facts: {
      outcome: 'error',
      reason: 'engine_threw',
      link: REC,
      linkIs: 'registration_page',
      pack: PACK,
    },
    watchFor: `Says Hale could not finish this one and the parent can sign up at the link, with the pack values. No blame, no technical detail. ${NO_RETRY}`,
  },
  {
    id: 'rush-timed-open',
    facts: {
      outcome: 'rush',
      reason: 'timed_open',
      link: REC,
      linkIs: 'registration_page',
      pack: PACK,
      rush: {
        signal: 'timed_open',
        opensAt: 'Monday, January 12 at 7:00 AM',
        prefillSlots: PACK.map((item) => item.slot),
      },
    },
    watchFor: `Says registration opens Monday, January 12 at 7:00 AM and the parent signs up at the link then, with the pack values ready. Does not say it is full or signed up. ${NO_RETRY}`,
  },
  {
    id: 'reached-checkout-live',
    facts: {
      outcome: 'reached_checkout',
      reason: null,
      link: LIVE,
      linkIs: 'live_browser',
      holdMinutes: 12,
    },
    watchFor: `Says Hale got to the payment step and the parent pays in the open browser at the link, within about 12 minutes. Never says it is booked or paid. ${NO_PACK} ${NO_RETRY}`,
  },
  {
    id: 'needs-human-captcha-live',
    facts: {
      outcome: 'needs_human',
      reason: 'captcha',
      link: LIVE,
      linkIs: 'live_browser',
    },
    watchFor: `Says the site needs a step only the parent can do (a check that they are a person) and they finish in the open browser at the link. No invented time limit. ${NO_PACK} ${NO_RETRY}`,
  },
  {
    id: 'needs-human-unconfirmed',
    facts: {
      outcome: 'needs_human',
      reason: 'unconfirmed',
      link: REC,
      linkIs: 'registration_page',
    },
    watchFor: `Says Hale could not confirm it went through and the parent should check on the provider's page at the link. Never says signed up, never says it failed. ${NO_PACK} ${NO_RETRY}`,
  },
  {
    id: 'sold-out',
    facts: {
      outcome: 'sold_out',
      reason: null,
      link: REC,
      linkIs: 'registration_page',
    },
    watchFor: `Says the session is full. The link is the provider's page. ${NO_PACK} ${NO_RETRY}`,
  },
  {
    id: 'waitlist',
    facts: {
      outcome: 'waitlist',
      reason: null,
      link: REC,
      linkIs: 'registration_page',
    },
    watchFor: `Says only a waitlist is open and Hale did not join it; the parent can join at the link if they want. Never says they are on the waitlist. ${NO_PACK} ${NO_RETRY}`,
  },
  {
    id: 'payment-not-approved-live',
    facts: {
      outcome: 'payment_not_approved',
      reason: null,
      link: LIVE,
      linkIs: 'live_browser',
      holdMinutes: 5,
    },
    watchFor: `Says the payment was not approved so nothing was paid, and the parent can pay in the open browser at the link within about 5 minutes. Never says booked. ${NO_PACK} ${NO_RETRY}`,
  },
  {
    id: 'completed-confirmed',
    facts: {
      outcome: 'completed',
      reason: null,
      confirmed: true,
      link: '',
      linkIs: null,
    },
    watchFor: `Says the child is signed up for the session; the provider confirmed it. No link, no confirmation number, no name. ${NO_RETRY}`,
  },
];

export const SIGNUP_OUTCOME_REPLY_LANGUAGES = ['en', 'fr', 'zh'];

function facts(base, language) {
  return {
    outcome: base.outcome,
    reason: base.reason,
    confirmed: base.confirmed ?? false,
    sessionLabel: SESSION[language],
    link: base.link,
    linkIs: base.linkIs,
    holdMinutes: base.holdMinutes ?? null,
    audience: base.audience ?? 'direct',
    prefilled: [],
    ...(base.pack ? { pack: base.pack } : {}),
    rush: base.rush ?? null,
    question: null,
    language,
  };
}

export const SIGNUP_OUTCOME_REPLY_FIXTURES = CASES.flatMap((item) =>
  SIGNUP_OUTCOME_REPLY_LANGUAGES.map((language) => ({
    id: `${language}-${item.id}`,
    facts: facts(item.facts, language),
    watchFor: `${item.watchFor} Written in ${language}${language === 'fr' ? (item.facts.audience === 'group' ? ' (vous, the group)' : ' (tu, not vous)') : ''}.`,
  })),
);

/**
 * --broken: each text breaks one rule of the spec. The code gate or the judge must catch
 * every one; one that passes both is a calibration failure.
 */
export const SIGNUP_OUTCOME_REPLY_BROKEN = [
  {
    id: 'claims-booking',
    fixtureId: 'en-reached-checkout-live',
    text: `All booked and paid for Sat 9:30 AM, you're set. ${LIVE}`,
    breaks: 'claims a booking the run did not confirm',
  },
  {
    id: 'promises-retry',
    fixtureId: 'en-error-engine-threw',
    text: `That one didn't go through on my end. I'll try again tonight and let you know. Meanwhile: ${REC}`,
    breaks: 'promises a retry and a follow-up',
  },
  {
    id: 'drops-link',
    fixtureId: 'en-needs-login-no-session',
    text: "I can't do sign-ups on that site yet, so this one is yours to do.",
    breaks: 'drops the link',
  },
  {
    id: 'says-login-failed',
    fixtureId: 'en-needs-login-no-session',
    text: `I tried logging into your account there but the login failed. You can sign up here: ${REC}`,
    breaks: 'says a login was tried and failed on no_provider_session',
  },
  {
    id: 'leaks-pack',
    fixtureId: 'en-sold-out',
    text: `Sat 9:30 AM is full. For next time, have Lena Ferreira and sam@example.test ready: ${REC}`,
    breaks: 'lists personal details on an outcome with no pack',
  },
  {
    id: 'unconfirmed-says-signed-up',
    fixtureId: 'fr-needs-human-unconfirmed',
    text: `C'est fait, l'inscription pour sam. 9 h 30 est confirmée. Tu peux vérifier ici : ${REC}`,
    breaks: 'says signed up when the run could not confirm it',
  },
];
