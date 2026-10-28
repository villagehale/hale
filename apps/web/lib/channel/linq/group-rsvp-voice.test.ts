import { describe, expect, it } from 'vitest';
import { groupRsvpLineInput } from './group-rsvp-line-input';
import { rsvpLineUsable } from './group-rsvp-voice';

const tally = {
  yes: 2,
  no: 1,
  pending: 3,
  yesNames: ['Priya', 'Jordan'],
  noNames: ['Sam'],
  pendingNames: [],
};

describe('rsvpLineUsable', () => {
  const input = groupRsvpLineInput({
    kind: 'tally',
    language: 'en',
    parentWords: 'how many',
    tally,
    title: "Maya's party",
    whenText: 'Saturday',
    location: 'the park',
    justChanged: 'Jordan',
    calendarAskFor: null,
    calendarPlacedFor: null,
    inviteSent: false,
    send: true,
  });

  it('accepts a short fact-bound line', () => {
    expect(rsvpLineUsable('2 yes, 1 no, 3 still out for Maya\'s party.', input)).toBe(true);
  });

  it('rejects a link, a second question, or a count that is not in the facts', () => {
    expect(rsvpLineUsable('2 yes — https://example.com', input)).toBe(false);
    expect(rsvpLineUsable('2 yes. Who is driving? What time?', input)).toBe(false);
    expect(rsvpLineUsable('6 yes, 2 to go.', input)).toBe(false);
  });

  it('rejects on everyone\'s calendar unless that write happened', () => {
    expect(rsvpLineUsable('2 yes, on everyone\'s calendar.', input)).toBe(false);
    const written = groupRsvpLineInput({
      kind: 'tally',
      language: 'en',
      parentWords: 'how many',
      tally,
      title: "Maya's party",
      whenText: 'Saturday',
      location: 'the park',
      justChanged: 'Jordan',
      calendarAskFor: null,
      calendarPlacedFor: null,
      inviteSent: true,
      send: true,
    });
    expect(rsvpLineUsable("2 yes, on everyone's calendar.", written)).toBe(true);
  });
});
