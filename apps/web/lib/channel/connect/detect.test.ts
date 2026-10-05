import { describe, expect, it } from 'vitest';
import {
  connectOfferTarget,
  matchConnectorDisconnectRequest,
  matchFreshConnectorFollowUp,
} from './detect';

/**
 * The connect door's two shape matchers. The CONNECT ask itself is the model's reading
 * now (connect/request-intent.ts, proved by its cached eval); what is tested here is
 * the fresh-link follow-up, the disconnect instruction, and the link reader.
 */

/**
 * THE DISCONNECT HALF — the one deterministic branch in the product whose wrong answer
 * DELETES something.
 *
 * A false connect claim mints a link nobody asked for. A false disconnect claim purges
 * an OAuth token, flips the row to revoked, stops the every-15-minutes sweep and writes an
 * immutable audit row. So this table is the gate: every sentence that a reasonable
 * parent could send about calendar CONTENT is asserted null, with positive controls
 * beside them so an all-null matcher (the way an absence table fails open) cannot pass.
 */
describe('matchConnectorDisconnectRequest', () => {
  it.each([
    // The plain instruction a parent can still type. The connect card no longer
    // teaches this sentence.
    ['disconnect my calendar', 'gcal'],
    ['disconnect gmail', 'gmail'],
    ['disconnect calendar', 'gcal'],
    ['disconnect my google calendar', 'gcal'],
    ['unlink gmail', 'gmail'],
    ['unhook my google drive', 'gdrive'],
    ['stop watching my email', 'gmail'],
    ['stop syncing my calendar', 'gcal'],
    ['stop reading my gmail', 'gmail'],
    ['revoke my google calendar', 'gcal'],
    ['DISCONNECT MY GCAL', 'gcal'],
    ['disconnect my calendar please', 'gcal'],
  ])('claims %j as %s', (body, provider) => {
    expect(matchConnectorDisconnectRequest(body)).toBe(provider);
  });

  it.each([
    ['deconnecte mon Google Agenda', 'gcal'],
    ['déconnectez mon agenda', 'gcal'],
    ['arrete de lire mes courriels', 'gmail'],
    ['arrête de synchroniser mon calendrier', 'gcal'],
  ])('claims the French instruction %j as %s', (body, provider) => {
    expect(matchConnectorDisconnectRequest(body)).toBe(provider);
  });

  it.each([
    // CONTENT, not custody. "remove" is a content verb and is not a disconnect verb
    // at all — these six were live false positives of an earlier matcher.
    ['can you remove my calendar reminder for tuesday'],
    ['please remove the calendar hold for swim'],
    ['remove the calendar event for friday'],
    ['could you unlink the calendar invite'],
    // CONTENT WEARING A CUSTODY VERB. The verb really is "disconnect"/"unlink", so no
    // verb list can decline these — what makes them content is the article in front of
    // the noun (nobody ends THEIR OWN grant by calling it "the calendar") and the tail
    // behind it. Each one of these deleted a token in review.
    ['unlink the calendar invite'],
    ['disconnect the calendar event for friday'],
    ['revoke my calendar access for the nanny'],
    ['we are unhooking the calendar from the fridge lol'],
    // Somebody ELSE's connector, and a plan about a phone — neither is an instruction
    // about the grant this thread's parent holds.
    ['my husband will disconnect his calendar'],
    ["I'm disconnecting my email from my phone this weekend"],
    // The OPPOSITE instruction.
    ['dont disconnect my calendar'],
    ["don't disconnect my calendar"],
    ['never unlink our calendar please'],
    // CASL and unsubscribe words. A bare STOP never reaches the handler chain at all
    // (intake/keywords.ts matches the whole normalized body), and this is the second
    // lock: even if it did, it is not an instruction to disconnect anything.
    ['stop'],
    ['arret'],
    ['unsubscribe'],
    ['stop the swim reminders'],
    ['stop texting me'],
    // Questions about the state of a connection: the coach answers those.
    ['is my google calendar still connected'],
    ['did you disconnect my gmail'],
    ['what happens if I disconnect my calendar'],
    ['can you disconnect my google calendar'],
    // A connect ask must never be read as its own opposite.
    ['connect my google calendar'],
    ['read my gmail for me'],
    // Bare nouns with no verb, and a commute.
    ['my calendar'],
    ['disconnect'],
    ['stop the drive'],
  ])('declines %j', (body) => {
    expect(matchConnectorDisconnectRequest(body)).toBeNull();
  });

  /**
   * THE INVARIANT, not a spot check: no body can be read as both a fresh-link follow-up
   * and a disconnect instruction. It holds by construction (every disconnect verb is in
   * the follow-up matcher's NEGATION class), and this asserts it over every sentence
   * either suite names — so a verb added to one half without the other fails here rather
   * than in a parent's thread.
   */
  it('never claims the same body as both a fresh-link follow-up and a disconnect', () => {
    const bodies = [
      'give me a fresh one',
      'new link',
      'it expired',
      'another link',
      'disconnect my calendar',
      'disconnect gmail',
      'unhook my google drive',
      'stop watching my email',
      'deconnecte mon Google Agenda',
      'arrete de lire mes courriels',
      'revoke my google calendar',
      'the link expired, disconnect my calendar',
    ];
    const both = bodies.filter(
      (b) => matchFreshConnectorFollowUp(b) && matchConnectorDisconnectRequest(b) !== null,
    );
    expect(both).toEqual([]);
    // Positive control: this corpus really does exercise both halves, so the empty
    // intersection above is a fact about the matchers and not about the list.
    expect(bodies.filter((b) => matchFreshConnectorFollowUp(b)).length).toBeGreaterThan(3);
    expect(
      bodies.filter((b) => matchConnectorDisconnectRequest(b) !== null).length,
    ).toBeGreaterThan(3);
  });
});

describe('matchFreshConnectorFollowUp', () => {
  it.each([
    'give me a fresh one',
    'new link',
    'it expired',
    'the link has expired',
    'another link',
  ])('claims the follow-up %j', (body) => {
    expect(matchFreshConnectorFollowUp(body)).toBe(true);
  });

  it.each([
    'thanks',
    'the new one is Maya',
    "what's on my calendar this week",
    "don't give me a fresh one",
    'connect my gmail',
  ])('does not claim %j', (body) => {
    expect(matchFreshConnectorFollowUp(body)).toBe(false);
  });

  it('reads the provider off the LINK Hale already sent, never off its prose', () => {
    expect(
      connectOfferTarget('Here you go.\nhttps://app.villagehale.com/connect?t=abc&to=gmail'),
    ).toBe('gmail');
    expect(
      connectOfferTarget(
        'Fifteen minutes on this one.\nhttps://app.villagehale.com/connect?t=abc&to=gcal',
      ),
    ).toBe('gcal');
    expect(
      connectOfferTarget(
        'Two links.\nhttps://app.villagehale.com/connect?t=a&to=gcal\nhttps://app.villagehale.com/connect?t=b&to=gmail',
      ),
    ).toBe('both');
    // The old fixed phrases are no longer a signal: the line over the link is the model's.
    expect(connectOfferTarget('Connect your calendar - tap to connect your Gmail')).toBeNull();
    expect(connectOfferTarget('What should I call you?')).toBeNull();
  });
});
