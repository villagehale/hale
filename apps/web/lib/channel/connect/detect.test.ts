import { describe, expect, it } from 'vitest';
import { matchConnectorRequest } from './detect';

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
