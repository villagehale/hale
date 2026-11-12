// The registration notices — the corpus for the login card's words (VIL-682 K2).
//
// Expectations come from the SPEC (packages/agent/skills/signup-provider-notice.md): the
// bubbles, and when `facts.loginCard` is set, the words on the login card that follows the
// first bubble, in the parent's language. No fixed copy and no wording checks: the code
// gates (no link in a bubble; the card's own gate) decide what may go, a judge reads the
// facts, the privacy and the language.
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

// A site whose options do not match what the parent asked for (`options_mismatch`): the
// site's real options with each non-waitlist billing note, one open question, and, with the
// mismatch plan lit, an email offered only when Hale can leave one in the parent's Gmail
// (`emailDraft`). Without `emailDraft` (the lane dark), the notice is the one it always was.
const SITE_CHOICES = [
  {
    id: 'nov-21',
    label: 'Nov 21 start',
    starts_at: '2026-11-21',
    price_cents: 12000,
    waitlist: false,
    billing_note: 'December is billed while you are away',
    provider_email: 'rec@example.test',
  },
  {
    id: 'jan-wait',
    label: 'January waitlist',
    starts_at: '2027-01-09',
    price_cents: 9800,
    waitlist: true,
    billing_note: null,
    provider_email: 'rec@example.test',
  },
];

const MISMATCH = {
  kind: 'options_mismatch',
  childFirstName: 'Ada',
  opensAt: OPENS,
  host: HOST,
  passwordRejectionMessage: null,
  passwordRule: null,
  siteChoices: SITE_CHOICES,
  askedStart: SESSION,
  loginCard: null,
};

const PICKS =
  'Says the site does not have what they asked for, names the Nov 21 start with its billing note (December is billed while they are away) and the January waitlist, and ends on one open question. Never picks. No card.';

const CARD_RULES =
  'The card never names Ada, never gives a price, and gives no time that is not in facts.loginCard.';

export const SIGNUP_PROVIDER_NOTICE_FIXTURES = [
  {
    id: 'login-ask-en',
    facts: {
      ...BASE,
      kind: 'login_ask',
      language: 'en',
      loginCard: { sessionLabel: SESSION, opensAt: OPENS },
    },
    watchFor: `Asks for the login to ${HOST} before registration opens Tuesday December 1 at 7:00 a.m., so Hale can sign in at the open. The card title names ${HOST} and what the login is for; the description gives the Saturday 9:00 swim session and the 7:00 a.m. open. ${CARD_RULES}`,
  },
  {
    id: 'login-ask-zh',
    facts: {
      ...BASE,
      kind: 'login_ask',
      language: 'zh',
      loginCard: { sessionLabel: SESSION, opensAt: OPENS },
    },
    watchFor: `Every bubble AND both card fields in Chinese. Asks for the login to ${HOST} before the open (December 1, 7:00). The card title names ${HOST}; the description gives the swim session and the open. ${CARD_RULES}`,
  },
  {
    id: 'login-ask-fr',
    facts: {
      ...BASE,
      kind: 'login_ask',
      language: 'fr',
      loginCard: { sessionLabel: SESSION, opensAt: OPENS },
    },
    watchFor: `Every bubble AND both card fields in French, tu. Asks for the login to ${HOST} before the open (December 1, 7:00). The card title names ${HOST}; the description gives the swim session and the open. ${CARD_RULES}`,
  },
  {
    id: 'password-rejected-es',
    facts: {
      ...BASE,
      kind: 'password_rejected',
      language: 'es',
      passwordRejectionMessage: 'Password must include a number',
      passwordRule: '8 characters and a number',
      loginCard: { sessionLabel: SESSION, opensAt: null },
    },
    watchFor: `Every bubble AND both card fields in Spanish. Says the site did not take the password, that a fresh link follows, and the site's rule (8 characters and a number). facts.loginCard.opensAt is null (registration opens before the card expires, or already has): the card title names ${HOST}, and the description says the login is for signing up for the swim session, with NO opening time and no claim about whether registration has opened. ${CARD_RULES}`,
  },
  {
    id: 'pre-open-no-card',
    facts: { ...BASE, kind: 'pre_open', language: 'en', loginCard: null },
    watchFor:
      'The reminder before the 7:00 a.m. open on December 1: Hale will be there at the open. There is no login card (facts.loginCard is null), so there are no card words at all.',
  },
  {
    id: 'mismatch-email-ready-zh',
    facts: { ...MISMATCH, language: 'zh', emailDraft: 'ready' },
    watchFor: `In Chinese. ${PICKS} May offer to write an email in their Gmail for them to send; never says Hale will send it.`,
  },
  {
    id: 'mismatch-not-connected-zh',
    facts: { ...MISMATCH, language: 'zh', emailDraft: 'not_connected' },
    watchFor: `In Chinese. ${PICKS} Does NOT offer to email the provider.`,
  },
  {
    id: 'mismatch-no-address-en',
    facts: { ...MISMATCH, language: 'en', emailDraft: 'no_provider_email' },
    watchFor: `In English. ${PICKS} Does NOT offer to email the provider.`,
  },
  {
    id: 'mismatch-dark-en',
    facts: { ...MISMATCH, language: 'en' },
    watchFor: `In English. ${PICKS} May offer to email the provider.`,
  },
];

/**
 * Calibration: card words a judge MUST score low (or the code gate must refuse). Every
 * line is one the gate alone would let through, except where `gate` says it must refuse.
 */
export const SIGNUP_PROVIDER_NOTICE_BROKEN = [
  {
    id: 'card-english-for-zh',
    fixtureId: 'login-ask-zh',
    bubbles: ['我需要你在 register.example-rec.test 的登录。', '12月1日7:00开放报名前存好就行。'],
    card: { title: `Login for ${HOST}`, description: 'Preschool Swim Sat 9:00, opens 7:00 a.m.' },
    breaks: 'the card is in English for a Chinese-speaking parent',
  },
  {
    id: 'card-open-after-open',
    fixtureId: 'password-rejected-es',
    bubbles: [
      'No aceptaron esa contraseña.',
      'Aquí va un enlace nuevo.',
      'Su regla: 8 caracteres y un número.',
    ],
    card: {
      title: `Inicio de sesión para ${HOST}`,
      description: 'Natación sáb. 9:00 · abre el martes',
    },
    breaks: 'the card says when registration opens after the open has passed',
  },
  {
    id: 'card-names-child',
    fixtureId: 'login-ask-en',
    bubbles: [`I need your login for ${HOST}.`, 'Save it before the 7:00 a.m. open.'],
    card: { title: `Ada's swim login for ${HOST}`, description: 'Preschool Swim Sat 9:00' },
    breaks: 'the card names the child',
    gate: true,
  },
];
