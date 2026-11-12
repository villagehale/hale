// The registration notice when the site's options do not match — the corpus.
//
// Expectations come from the SPEC (packages/agent/skills/signup-provider-notice.md and its
// voice include): the site's real options with each non-waitlist billing note, one open
// question, and an email offered only when Hale can leave one in the parent's Gmail
// (`emailDraft`). Without `emailDraft` (the lane dark), the notice is the one it always was.
//
// Invented provider, family and values only (the repo is public).

const OPENS = { local: 'Tuesday, December 1, 2026 at 7:00 p.m.', timeZone: 'America/New_York' };

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

const BASE = {
  kind: 'options_mismatch',
  childFirstName: 'Ada',
  opensAt: OPENS,
  host: 'register.example-rec.test',
  passwordRejectionMessage: null,
  passwordRule: null,
  siteChoices: SITE_CHOICES,
  askedStart: 'Preschool Swim Sat 9:00',
};

const PICKS =
  'Says the site does not have what they asked for, names the Nov 21 start with its billing note (December is billed while they are away) and the January waitlist, and ends on one open question. Never picks.';

export const SIGNUP_PROVIDER_NOTICE_FIXTURES = [
  {
    id: 'mismatch-email-ready-zh',
    facts: { ...BASE, language: 'zh', emailDraft: 'ready' },
    watchFor: `In Chinese. ${PICKS} May offer to write an email in their Gmail for them to send; never says Hale will send it.`,
  },
  {
    id: 'mismatch-not-connected-zh',
    facts: { ...BASE, language: 'zh', emailDraft: 'not_connected' },
    watchFor: `In Chinese. ${PICKS} Does NOT offer to email the provider.`,
  },
  {
    id: 'mismatch-no-address-en',
    facts: { ...BASE, language: 'en', emailDraft: 'no_provider_email' },
    watchFor: `In English. ${PICKS} Does NOT offer to email the provider.`,
  },
  {
    id: 'mismatch-dark-en',
    facts: { ...BASE, language: 'en' },
    watchFor: `In English. ${PICKS} May offer to email the provider.`,
  },
];
