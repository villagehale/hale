import { describe, expect, it } from 'vitest';
import { groupJoinIntroClaims } from '../../web/lib/channel/linq/group-onboarding-line-input.ts';
import { GROUP_JOIN_INTRO_FIXTURES } from './group-join-intro-fixtures.mjs';

function claimsOf(fixture) {
  return groupJoinIntroClaims({
    audience: fixture.audience,
    otherPeople: fixture.otherPeople,
    turnReaderLive: fixture.turnReaderLive,
    mailNoticeLive: fixture.mailNoticeLive,
  });
}

describe('group join intro eval fixtures (VIL-727)', () => {
  it('has unique ids and covers both audiences, every ask, and three languages', () => {
    const ids = GROUP_JOIN_INTRO_FIXTURES.map((fixture) => fixture.id);
    expect(new Set(ids).size).toBe(ids.length);
    const audiences = new Set(GROUP_JOIN_INTRO_FIXTURES.map((fixture) => fixture.audience));
    expect([...audiences].sort()).toEqual(['household', 'shared']);
    const asks = new Set(GROUP_JOIN_INTRO_FIXTURES.map((fixture) => fixture.ask));
    expect([...asks].sort()).toEqual(['none', 'who_and_kid', 'who_in_family']);
    const languages = new Set(GROUP_JOIN_INTRO_FIXTURES.map((fixture) => fixture.language));
    expect(languages.size).toBeGreaterThanOrEqual(3);
  });

  it('keeps each scenario consistent with what production would ask', () => {
    for (const fixture of GROUP_JOIN_INTRO_FIXTURES) {
      if (fixture.audience === 'shared') {
        expect(fixture.knownParentName).toBeNull();
        expect(fixture.ask).toBe('who_and_kid');
      } else {
        expect(fixture.adderName).toBeNull();
        expect(fixture.ask).not.toBe('who_and_kid');
      }
      expect(fixture.watchFor.length).toBeGreaterThan(0);
    }
  });

  it('builds the household claims for a big group with the turn reader lit', () => {
    const full = GROUP_JOIN_INTRO_FIXTURES.find((fixture) => fixture.id === 'en-household-asks');
    expect(claimsOf(full)).toEqual([
      'reads_this_chat',
      'email_never_shown',
      'speaks_when_called',
      'anyone_can_remove',
    ]);
  });

  it('does not promise a private text, including in a shared group', () => {
    const shared = GROUP_JOIN_INTRO_FIXTURES.find((fixture) => fixture.id === 'en-shared-adder');
    expect(claimsOf(shared)).not.toContain('private_goes_direct');
    expect(claimsOf(shared)).toEqual([
      'reads_this_chat',
      'email_never_shown',
      'speaks_when_called',
      'anyone_can_remove',
    ]);
  });

  it('leaves removal out of every group of three', () => {
    const small = GROUP_JOIN_INTRO_FIXTURES.filter((fixture) => fixture.otherPeople < 3);
    expect(small.length).toBeGreaterThanOrEqual(2);
    for (const fixture of small) {
      expect(claimsOf(fixture)).not.toContain('anyone_can_remove');
      expect(fixture.watchFor).toMatch(/remov/i);
    }
  });

  it('leaves out what a dark turn reader and a live mail notice make untrue', () => {
    const dark = GROUP_JOIN_INTRO_FIXTURES.find(
      (fixture) => fixture.id === 'en-household-reader-dark',
    );
    expect(claimsOf(dark)).toEqual(['reads_this_chat', 'anyone_can_remove']);
  });
});
