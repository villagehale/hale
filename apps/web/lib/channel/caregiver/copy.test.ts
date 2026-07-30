import { describe, expect, it } from 'vitest';
import { CONTENT_CLASSES, type ContentClass, roleAllows } from '~/lib/channel/role-scope';
import { inviteBody, scopeConfirm } from './copy';

/**
 * The copy is what a caregiver AGREES to, so it has to say what the matrix actually
 * does. These tests tie the two together: widening `CAREGIVER_SCOPE` without rewriting
 * the invite fails here rather than in production, where the failure mode is a person
 * consenting to one thing and then receiving another.
 */

/** The classes the copy names in so many words. */
const NAMED: Partial<Record<ContentClass, string>> = {
  schedule: "the week's schedule",
  pickup_duty: 'pickup reminders',
  event_logistics: 'time and address',
  health: 'health or appointments',
  teen_content: 'teenager',
  registration: 'sign-ups or money',
  family_settings: 'account settings',
};

/** Closed off by the sentence that ends the list rather than named individually —
 * there is no useful way to explain "the ranked village pick" to a babysitter. */
const CLOSING_PHRASE = 'nothing else';

describe('caregiver copy · promises match the matrix', () => {
  const both = [scopeConfirm('grandma', 'grandparent'), inviteBody('Ana', 'grandparent')];

  it('accounts for every content class — named, or closed off by the final clause', () => {
    const unnamed = CONTENT_CLASSES.filter((c) => !(c in NAMED));
    expect(unnamed).toEqual(['village_suggestion']);
    for (const body of both) {
      expect(body).toContain(CLOSING_PHRASE);
    }
  });

  it.each(Object.entries(NAMED))('names %s in both the confirmation and the invite', (_cls, phrase) => {
    for (const body of both) {
      expect(body).toContain(phrase);
    }
  });

  it('puts every denied class after the word "Never", where a reader can see the boundary', () => {
    const denied = CONTENT_CLASSES.filter((c) => !roleAllows('grandparent', c) && c in NAMED);
    for (const body of both) {
      const never = body.slice(body.indexOf('Never'));
      for (const cls of denied) {
        expect(never).toContain(NAMED[cls]);
      }
    }
  });

  it('keeps every allowed class in the PROMISE, ahead of the never-list', () => {
    const allowed = CONTENT_CLASSES.filter((c) => roleAllows('grandparent', c));
    for (const body of both) {
      const promise = body.slice(0, body.indexOf('Never'));
      for (const cls of allowed) {
        expect(promise).toContain(NAMED[cls]);
      }
    }
  });

  it('carries the CASL opt-out on the first message a stranger ever gets', () => {
    expect(inviteBody('Ana', 'nanny')).toContain('Reply STOP anytime');
  });

  it('says who asked, and falls back honestly when the parent has no name on file', () => {
    expect(inviteBody('Ana', 'babysitter')).toContain('Ana added you');
    expect(inviteBody(null, 'babysitter')).toContain('A parent added you');
  });
});
