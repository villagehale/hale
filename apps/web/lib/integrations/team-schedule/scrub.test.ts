import { describe, expect, it } from 'vitest';
import { scrubScheduleFacts } from './scrub';

describe('scrubScheduleFacts', () => {
  it('keeps a rink and a team name', () => {
    expect(
      scrubScheduleFacts({ title: 'U11 Lightning', location: 'Scotiabank Arena' }),
    ).toEqual({ team: 'U11 Lightning', place: 'Scotiabank Arena' });
  });

  it('drops a field that holds a link', () => {
    expect(
      scrubScheduleFacts({
        title: 'Hockey bit.ly/x',
        location: 'https://evil.example/join',
        address: '100 Front St',
      }),
    ).toEqual({ team: null, place: '100 Front St' });
  });

  it('drops a field that holds a phone number', () => {
    expect(
      scrubScheduleFacts({
        title: 'Practice',
        location: 'Call 416-555-0199 at the rink',
      }),
    ).toEqual({ team: 'Practice', place: null });
  });

  it('does not pass a planted URL through the address', () => {
    expect(
      scrubScheduleFacts({
        title: 'Soccer',
        location: null,
        address: 'Meet at evil.app/pay then 6475550100',
      }),
    ).toEqual({ team: 'Soccer', place: null });
  });
});
