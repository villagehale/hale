// VIL-558 registration voice corpus. Not wired to a CI eval: there is no recorded
// cache yet, and this branch does not run paid evals. Keep these facts + watchFor
// next to the existing cached plan-reply / outcome-reply cases. Re-record later.
//
// Invented provider, family and values only (the repo is public). Quoted lines in
// watchFor are tone, never copy.

const OPENS = { local: 'Tuesday, December 1, 2026 at 7:00 p.m.', timeZone: 'America/New_York' };

const FEES = {
  session_cents: 9800,
  admin_cents: 2500,
  membership_cents: 0,
  total_cents: 12300,
  billing_note: 'charged when you register',
};

const SITE_CHOICES = [
  {
    id: 'nov-21',
    label: 'Nov 21',
    starts_at: '2026-11-21',
    price_cents: 12000,
    waitlist: false,
    billing_note: 'billed December',
    provider_email: 'rec@example.test',
  },
  {
    id: 'nov-28',
    label: 'Nov 28',
    starts_at: '2026-11-28',
    price_cents: 12000,
    waitlist: false,
    billing_note: 'billed December',
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

const VOICE =
  'Texts like a friend in short bubbles, one fact each. Exact about money and dates, using only the facts. Asks before any choice or commitment.';

export const SIGNUP_REGISTRATION_VOICE_FIXTURES = [
  {
    id: 'voice-1-several-bubbles',
    kind: 'seats',
    facts: {
      kind: 'seats',
      childFirstName: 'Ada',
      opensAt: OPENS,
      host: 'register.example-rec.test',
      language: 'en',
      sessionLabel: 'Saturday 9:00',
      fees: FEES,
    },
    watchFor: `${VOICE} Several short bubbles. Saturday 9:00. $98 a month. $25 admin the first time. Charged when you register. One yes/no.`,
  },
  {
    id: 'voice-2-age-fit',
    kind: 'seats',
    facts: {
      kind: 'seats',
      childFirstName: 'Ada',
      opensAt: OPENS,
      host: 'register.example-rec.test',
      language: 'en',
      sessionLabel: 'Sunday 10:00',
      fees: FEES,
    },
    watchFor: `${VOICE} Offers the real session with its time and price. Does not invent another class.`,
  },
  {
    id: 'voice-3-switch',
    kind: 'account_prep',
    facts: {
      kind: 'account_prep',
      childFirstName: 'Ada',
      opensAt: OPENS,
      host: 'register.example-rec.test',
      language: 'en',
    },
    watchFor: `${VOICE} A switch is handled plainly. No recap of the whole plan.`,
  },
  {
    id: 'voice-4-exact-then-ask',
    kind: 'seats',
    facts: {
      kind: 'seats',
      childFirstName: 'Ada',
      opensAt: OPENS,
      host: 'register.example-rec.test',
      language: 'en',
      sessionLabel: 'Saturday 9:00',
      fees: FEES,
    },
    watchFor: `${VOICE} Exact time and price from the facts, then one yes/no. Never invents a fee.`,
  },
  {
    id: 'voice-5-login-then-account',
    kind: 'login_ask',
    facts: {
      kind: 'login_ask',
      childFirstName: 'Ada',
      opensAt: OPENS,
      host: 'register.example-rec.test',
      language: 'en',
    },
    watchFor: `${VOICE} Asks them to save the city login. Does not write a link. May say Hale can make the account once that is in. Asks before creating one.`,
  },
  {
    id: 'voice-6-when-money-moves',
    kind: 'receipt',
    facts: {
      kind: 'receipt',
      childFirstName: 'Ada',
      opensAt: OPENS,
      host: 'register.example-rec.test',
      language: 'en',
      sessionLabel: 'Saturday 9:00',
      fees: FEES,
      confirmed: true,
    },
    watchFor: `${VOICE} Says when money actually moved only from the facts. Registered only if confirmed.`,
  },
  {
    id: 'password-rejected',
    kind: 'password_rejected',
    facts: {
      kind: 'password_rejected',
      childFirstName: 'Ada',
      opensAt: OPENS,
      host: 'register.example-rec.test',
      language: 'en',
      passwordRejectionMessage: 'Password must include a number',
      passwordRule: '8 characters and a number',
    },
    watchFor: `${VOICE} They didn't take that password. Does not write a link (Hale inserts the fresh one). Then the site's real rule from passwordRule — eight characters and a number. Invents no other rule.`,
  },
  {
    id: 'options-mismatch',
    kind: 'options_mismatch',
    facts: {
      kind: 'options_mismatch',
      childFirstName: 'Ada',
      opensAt: OPENS,
      host: 'register.example-rec.test',
      language: 'en',
      askedStart: 'January',
      siteChoices: SITE_CHOICES,
    },
    watchFor: `${VOICE} No January start. Names Nov 21 and Nov 28 and the January waitlist, with the December billing note, all from siteChoices. Offers to email the provider from the parent's Gmail after they say yes. One open question. Never picks.`,
  },
];
