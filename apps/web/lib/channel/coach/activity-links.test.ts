import { describe, expect, it } from 'vitest';
import { activityLinkSuffix } from './activity-links';

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
