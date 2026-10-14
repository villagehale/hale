/**
 * Judge-only fixtures for the consent screen (consent-reply.md).
 *
 * The model decides whether a reply agrees, refuses, or does neither, in any
 * wording and any language. These fixtures are not imported by a CI runner,
 * not listed in package.json, and not a CI step. Scoring them would be a paid
 * model call. `consent-and-evening-eval.mjs --estimate` prices that call and
 * does not make it.
 */

export const CONSENT_REPLY_FIXTURES = [
  {
    id: 'founder-yes',
    question: 'founder_welcome',
    text: 'sure, send it',
    expect: { verdict: 'yes', target: 'none' },
  },
  {
    id: 'caregiver-zh-no',
    question: 'caregiver_scope',
    text: '不要',
    expect: { verdict: 'no', target: 'none' },
  },
  {
    id: 'coparent-oui',
    question: 'coparent_scope',
    text: 'oui',
    expect: { verdict: 'yes', target: 'none' },
  },
  {
    id: 'invite-neither',
    question: 'caregiver_invite',
    text: 'who is this?',
    expect: { verdict: 'neither', target: 'none' },
  },
  {
    id: 'forward-no',
    question: 'forward_revoke',
    text: 'leave it on',
    expect: { verdict: 'no', target: 'none' },
  },
  {
    id: 'intro-zh-yes',
    question: 'intro',
    text: '我想认识附近的家庭',
    expect: { verdict: 'yes', target: 'discoverability' },
  },
  {
    id: 'intro-ar-no',
    question: 'intro',
    text: 'لا أريد تعارف',
    expect: { verdict: 'no', target: 'discoverability' },
  },
];
