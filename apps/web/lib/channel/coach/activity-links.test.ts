import { describe, expect, it } from 'vitest';
import { activityLinkSuffix, restoreActivityLinks } from './activity-links';

const FANOUS = {
  title: 'Fanous lantern craft',
  url: 'https://www.torontopubliclibrary.ca/programs-and-classes/',
  venue: 'North York Central Library',
};

const RIVERDALE = {
  title: 'Riverdale story time',
  url: 'https://www.torontopubliclibrary.ca/riverdale-story-time',
  venue: 'Riverdale Library',
};

const ROBOTICS = {
  title: 'Robotics workshops',
  url: 'https://www.torontopubliclibrary.ca/robotics',
};

describe('activityLinkSuffix', () => {
  it('does not treat a different case-sensitive query value as the exact source', () => {
    const link = { title: 'STEAM Storytime', url: 'https://www.lpl.ca/whats-on?audience=Kids' };
    expect(
      activityLinkSuffix('STEAM Storytime: https://www.lpl.ca/whats-on?audience=kids', [link]),
    ).toBe(link.url);
  });
  it('does not treat a longer query value as the exact source', () => {
    const link = { title: 'STEAM Storytime', url: 'https://www.lpl.ca/whats-on?page=1' };
    expect(activityLinkSuffix('STEAM Storytime: https://www.lpl.ca/whats-on?page=12', [link])).toBe(
      link.url,
    );
  });

  it('appends the Fanous page when the reply says lantern craft and drops the first word', () => {
    const suffix = activityLinkSuffix('Saturday afternoon there is a lantern craft.', [
      FANOUS,
      ROBOTICS,
    ]);
    expect(suffix).toBe(FANOUS.url);
  });

  it('appends the Riverdale page when the reply names the library and story time', () => {
    const suffix = activityLinkSuffix('Riverdale Library has story time on Saturday.', [
      RIVERDALE,
      ROBOTICS,
    ]);
    expect(suffix).toBe(RIVERDALE.url);
  });

  it('appends the only offered page when the title was shortened to one distinctive word', () => {
    const suffix = activityLinkSuffix('The lantern thing is on Saturday afternoon.', [FANOUS]);
    expect(suffix).toContain(FANOUS.url);
  });

  it('does not append a page the reply never referred to', () => {
    const suffix = activityLinkSuffix('Thanks, that is plenty.', [FANOUS]);
    expect(suffix).toBe('');
  });
});

describe('restoring exact offered activity URLs', () => {
  const full = 'https://www.lpl.ca/whats-on?audience=Kids&date=2026-10#events';
  const link = { title: 'STEAM Storytime', url: full };

  it.each([
    'https://www.lpl.ca/whats-on',
    'https://lpl.ca/whats-on',
    'www.lpl.ca/whats-on',
    'lpl.ca/whats-on',
  ])('restores a unique shortened page: %s', (short) => {
    expect(restoreActivityLinks(`Source: ${short}.`, [link])).toBe(`Source: ${full}.`);
  });

  it('leaves complete source bytes, other queries and longer paths unchanged', () => {
    for (const url of [
      full,
      'https://www.lpl.ca/whats-on?audience=Adults',
      'https://www.lpl.ca/whats-on/other',
      'https://www.lpl.ca/whats-on.other',
    ]) {
      expect(restoreActivityLinks(`Source: ${url}`, [link])).toBe(`Source: ${url}`);
    }
  });

  it('does not choose between different filtered pages sharing a path', () => {
    const body = 'Source: lpl.ca/whats-on.';
    expect(
      restoreActivityLinks(body, [link, { title: 'Other storytime', url: `${full}&other=1` }]),
    ).toBe(body);
  });

  it('does not invent a link for an unrelated reply or accept invalid tool URLs', () => {
    expect(restoreActivityLinks('Thanks, that is plenty.', [link])).toBe('Thanks, that is plenty.');
    expect(
      restoreActivityLinks('Source: lpl.ca/whats-on', [
        { title: 'Bad link', url: 'javascript:alert(1)' },
      ]),
    ).toBe('Source: lpl.ca/whats-on');
  });
});
