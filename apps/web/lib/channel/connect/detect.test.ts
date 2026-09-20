import { describe, expect, it } from 'vitest';
import { matchConnectorDisconnectRequest, matchConnectorRequest } from './detect';

/**
 * The connector-request detector — the deterministic pre-coach branch that answers
 * "connect my calendar" with a real link instead of a composed refusal.
 *
 * CONSERVATIVE BY DESIGN: a miss costs one coach turn (whose skill now names the
 * branch), a false claim mints a sign-in link nobody asked for. So every ambiguous
 * shape below is asserted NOT to match, and the positives are anchored on an explicit
 * connect-verb + provider-noun pair — never a bare noun.
 */
describe('matchConnectorRequest', () => {
  // The two live sightings this branch exists for (founder screenshots, 2026-08).
  it('claims "I want you to connect my Google Calendar"', () => {
    expect(matchConnectorRequest('I want you to connect my Google Calendar')).toBe('gcal');
  });
  it('claims "Read my Gmail for me"', () => {
    expect(matchConnectorRequest('Read my Gmail for me')).toBe('gmail');
  });

  it.each([
    ['can you sync my calendar', 'gcal'],
    ['connect gmail please', 'gmail'],
    ['hook up my google drive', 'gdrive'],
    ['please link my google calendar to hale', 'gcal'],
    ['CONNECT MY GCAL', 'gcal'],
  ])('claims %j as %s', (body, provider) => {
    expect(matchConnectorRequest(body)).toBe(provider);
  });

  it('claims the French connect ask', () => {
    expect(matchConnectorRequest('Connecte mon Google Agenda')).toBe('gcal');
    expect(matchConnectorRequest('peux-tu synchroniser mon calendrier')).toBe('gcal');
  });

  // A question about the calendar's CONTENTS is the coach's turn, never a mint.
  it('declines "what\'s on my calendar this week"', () => {
    expect(matchConnectorRequest("what's on my calendar this week")).toBeNull();
  });

  it.each([
    // Bare words and unrelated bodies.
    ['yes'],
    ['thanks!'],
    ['the drive to school takes 20 minutes'],
    // The verb and the noun both present but not as one ask.
    ["let's connect after I check the calendar"],
    // Negations and revocations must never mint.
    ["don't connect my calendar"],
    ['disconnect my gmail'],
    ['stop syncing my calendar'],
    // Status and capability questions go to the coach, which can ask back.
    ['is my calendar connected?'],
    ['did you connect my gmail'],
    ['do you sync calendars?'],
    // Reading the calendar is a content ask, not a connect ask.
    ['read my calendar'],
    // "drive" without Google is somebody's commute.
    ['sync my drive'],
  ])('declines %j', (body) => {
    expect(matchConnectorRequest(body)).toBeNull();
  });
});

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
    // The plain instruction, in the words Hale's own connected receipt teaches
    // (connect/text-connect.ts: "you can say disconnect my calendar anytime").
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
   * THE INVARIANT, not a spot check: no body can be read as both a connect ask and a
   * disconnect instruction. It holds by construction (every disconnect verb is in the
   * connect matcher's NEGATION class), and this asserts it over every sentence either
   * suite names — so a verb added to one half without the other fails here rather than
   * in a parent's thread.
   */
  it('never claims the same body as both a connect and a disconnect', () => {
    const bodies = [
      'connect my google calendar',
      'I want you to connect my Google Calendar',
      'Read my Gmail for me',
      'can you sync my calendar',
      'hook up my google drive',
      'Connecte mon Google Agenda',
      'disconnect my calendar',
      'disconnect gmail',
      'unhook my google drive',
      'stop watching my email',
      'deconnecte mon Google Agenda',
      'arrete de lire mes courriels',
      'revoke my google calendar',
    ];
    const both = bodies.filter(
      (b) => matchConnectorRequest(b) !== null && matchConnectorDisconnectRequest(b) !== null,
    );
    expect(both).toEqual([]);
    // Positive control: this corpus really does exercise both halves, so the empty
    // intersection above is a fact about the matchers and not about the list.
    expect(bodies.filter((b) => matchConnectorRequest(b) !== null).length).toBeGreaterThan(3);
    expect(
      bodies.filter((b) => matchConnectorDisconnectRequest(b) !== null).length,
    ).toBeGreaterThan(3);
  });
});
