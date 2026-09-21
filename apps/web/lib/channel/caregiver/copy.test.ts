import { describe, expect, it } from 'vitest';
import { looksLikeJoinRequest } from '~/lib/channel/join/parse';
import { CONTENT_CLASSES, type ContentClass, roleAllows } from '~/lib/channel/role-scope';
import { CO_PARENT_REDIRECT, inviteBody, scopeConfirm } from './copy';

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

  /**
   * The refusal has to end somewhere a parent can actually go. It names the exact words
   * that mint a join link, so the sentence is checkable against the parser rather than
   * being a paraphrase that drifts from it.
   */
  it('points the refused co-parent add at the command that does work', () => {
    expect(looksLikeJoinRequest('add my partner')).toBe(true);
    expect(CO_PARENT_REDIRECT).toContain('add my partner');
    expect(CO_PARENT_REDIRECT).not.toMatch(/sign in|the app|https?:/i);
  });

  it('names the inviter BEFORE the first third-person pronoun — no dangling referent', () => {
    // A stranger's first message: a sentence about "their family's week" ahead of "A
    // parent added you" leaves 'their' pointing at nobody.
    //
    // ASSERTED AS THE INVARIANT, NOT AS A PHRASE. The old form compared the index of
    // 'added you' against the index of the literal 'their family', which makes a rewrite
    // that drops those two words pass trivially on one side (-1 < anything is false, so
    // it fails) — for the wrong reason, and it says nothing about the pronoun that
    // actually dangles. The first THIRD-PERSON word in the body is what has to come
    // second, whatever sentence carries it.
    const THIRD_PERSON = /\b(?:their|theirs|they|them)\b/i;
    for (const body of [inviteBody('Ana', 'nanny'), inviteBody(null, 'nanny')]) {
      const pronoun = body.search(THIRD_PERSON);
      expect(pronoun, body).toBeGreaterThan(-1);
      expect(body.indexOf('added you'), body).toBeLessThan(pronoun);
    }
    // The mutation this must catch: the same two sentences in the other order.
    const dangling =
      "Hi - I'm Hale, I keep their family's week straight. A parent added you as nanny.";
    expect(dangling.indexOf('added you')).toBeGreaterThan(dangling.search(THIRD_PERSON));
  });

  it('says what Hale DOES and never what Hale is', () => {
    // docs/voice.md rule 3: *assistant* as positioning is the word that moves. The
    // carve-out (a parent asking who is behind the number) does not reach a caregiver
    // invite, which nobody asked for.
    for (const body of [inviteBody('Ana', 'grandparent'), inviteBody(null, 'babysitter')]) {
      expect(body).not.toMatch(/assistant|AI-powered|the app|your account/i);
      expect(body).toContain("I keep their family's week straight");
    }
  });
});
