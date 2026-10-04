import { describe, expect, it } from 'vitest';
import { matchKeyword } from '~/lib/channel/intake/keywords';
import { matchPartyLinkConfirm } from '~/lib/party/reply';
import { readAffirmative } from './affirmative';
import { matchFastPath } from './router/fast-path';

/**
 * VIL-415. The pending asks that used to say "Reply YES" now ask in a sentence.
 * Each of them reads the answer through this table (weekly-plan approvals via
 * matchFastPath, the party RSVP offer via matchPartyLinkConfirm, and the plan
 * offer, email-alert add, registration readiness, and forwarded-mail consent
 * via readAffirmative). STOP, HELP, and START stay on the keyword matcher.
 */

const YES = ['yes', 'yeah', 'sure', 'please do', 'go ahead', 'Yes!', 'PLEASE DO'] as const;
const NO = ['no thanks', 'not now', 'No thanks.', 'NOT NOW'] as const;

describe('natural replies to a pending ask', () => {
  it('reads the affirmatives and the negatives', () => {
    for (const phrase of YES) expect(readAffirmative(phrase), phrase).toBe('yes');
    for (const phrase of NO) expect(readAffirmative(phrase), phrase).toBe('no');
  });

  it('reads them for a weekly-plan approval', () => {
    for (const phrase of YES) {
      expect(matchFastPath(phrase), phrase).toEqual({ verb: 'yes', index: null });
    }
    for (const phrase of NO) {
      expect(matchFastPath(phrase), phrase).toEqual({ verb: 'no', index: null });
    }
  });

  it('reads a yes for the party RSVP offer', () => {
    for (const phrase of YES) expect(matchPartyLinkConfirm(phrase), phrase).toBe(true);
    for (const phrase of NO) expect(matchPartyLinkConfirm(phrase), phrase).toBe(false);
  });

  it('leaves STOP, HELP, and START to the keyword matcher', () => {
    for (const phrase of ['STOP', 'stop', 'HELP', 'START', 'arret']) {
      expect(matchKeyword(phrase)?.keyword).toBeTruthy();
      expect(readAffirmative(phrase)).toBe('unclear');
      expect(matchFastPath(phrase)).toBeNull();
      expect(matchPartyLinkConfirm(phrase)).toBe(false);
    }
  });
});
