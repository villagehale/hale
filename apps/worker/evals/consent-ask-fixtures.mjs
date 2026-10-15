/**
 * Judge-only fixtures for the consent draft (consent-ask.md).
 *
 * The model writes the one text a parent, founder, caregiver, or co-parent
 * sees. These fixtures are not imported by a CI runner, not listed in
 * package.json, and not a CI step. Scoring them would be a paid model call.
 * `consent-and-evening-eval.mjs --estimate` prices that call and does not make it.
 */

export const CONSENT_ASK_FIXTURES = [
  { id: 'founder-ping', ask: { kind: 'founder_ping', location: 'Georgetown' } },
  { id: 'founder-retry', ask: { kind: 'founder_retry' } },
  { id: 'partial-failure', ask: { kind: 'partial_failure', draftCount: 2 } },
  { id: 'checkup', ask: { kind: 'checkup_drafted' } },
  { id: 'caregiver-scope', ask: { kind: 'caregiver_scope', name: 'Sam', role: 'nanny' } },
  { id: 'caregiver-invite', ask: { kind: 'caregiver_invite', who: 'Ana', role: 'nanny' } },
  { id: 'caregiver-nudge', ask: { kind: 'caregiver_nudge' } },
  {
    id: 'coparent-scope-en',
    ask: { kind: 'coparent_scope', name: 'Sam', language: 'en' },
  },
  {
    id: 'coparent-scope-fr',
    ask: { kind: 'coparent_scope', name: 'Sam', language: 'fr' },
  },
  {
    id: 'coparent-invite-en',
    ask: { kind: 'coparent_invite', inviterName: 'Ana', language: 'en' },
  },
  {
    id: 'coparent-invite-fr',
    ask: { kind: 'coparent_invite', inviterName: 'Ana', language: 'fr' },
  },
  { id: 'coparent-nudge-en', ask: { kind: 'coparent_nudge', language: 'en' } },
  { id: 'coparent-nudge-fr', ask: { kind: 'coparent_nudge', language: 'fr' } },
  { id: 'forward-en', ask: { kind: 'forward_revoke', language: 'en' } },
  { id: 'forward-fr', ask: { kind: 'forward_revoke', language: 'fr' } },
];
