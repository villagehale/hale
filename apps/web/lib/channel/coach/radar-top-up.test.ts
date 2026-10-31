import { describe, expect, it, vi } from 'vitest';
import type { ActivityPick } from '~/lib/channel/activity/lane';
import { isSuitableFind, mergeTopUp, topUpShortRadar } from './radar-top-up';

function find(overrides: Partial<ActivityPick> = {}): ActivityPick {
  return {
    name: 'Story time',
    ageFit: 'ages 2-5',
    when: 'Saturday 10:00',
    price: null,
    sourceName: 'Central Library',
    source: 'web',
    sourceUrl: 'https://library.example/story',
    ...overrides,
  };
}

const fair = find({
  name: 'Harvest fair',
  sourceName: 'Fairgrounds',
  sourceUrl: 'https://fair.example/harvest',
});

const wiki = find({
  name: 'Public library',
  sourceName: 'Wikipedia',
  sourceUrl: 'https://en.wikipedia.org/wiki/Public_library',
});

describe('VIL-522 radar top-up', () => {
  it('fires one live search when the radar has a single suitable find', async () => {
    const liveSearch = vi.fn(async () => [fair]);
    const result = await topUpShortRadar({ radar: [find()], liveSearch });

    expect(liveSearch).toHaveBeenCalledTimes(1);
    expect(result.outcome).toBe('searched');
    expect(result.picks.map((pick) => pick.name)).toEqual(['Story time', 'Harvest fair']);
  });

  it('does not search when the radar already has two suitable finds', async () => {
    const liveSearch = vi.fn(async () => [find({ name: 'Should not be fetched' })]);
    const result = await topUpShortRadar({
      radar: [find(), fair],
      liveSearch,
    });

    expect(liveSearch).not.toHaveBeenCalled();
    expect(result.outcome).toBe('not_needed');
    expect(result.picks.map((pick) => pick.name)).toEqual(['Story time', 'Harvest fair']);
  });

  it('does not search when the radar already has three suitable finds', async () => {
    const third = find({ name: 'Open gym', sourceUrl: 'https://gym.example/open' });
    const liveSearch = vi.fn(async () => []);
    const result = await topUpShortRadar({
      radar: [find(), fair, third],
      liveSearch,
    });

    expect(liveSearch).not.toHaveBeenCalled();
    expect(result.outcome).toBe('not_needed');
    expect(result.picks).toHaveLength(3);
  });

  it('fires a live search when the only radar page is Wikipedia', async () => {
    const liveSearch = vi.fn(async () => [fair]);
    const result = await topUpShortRadar({ radar: [wiki], liveSearch });

    expect(liveSearch).toHaveBeenCalledTimes(1);
    expect(result.picks.map((pick) => pick.name)).toEqual(['Harvest fair']);
  });

  it('treats a Wikipedia page as not suitable, so one real find still searches', async () => {
    expect(isSuitableFind(wiki)).toBe(false);
    const liveSearch = vi.fn(async () => [fair]);
    const result = await topUpShortRadar({ radar: [find(), wiki], liveSearch });

    expect(liveSearch).toHaveBeenCalledTimes(1);
    expect(result.picks.map((pick) => pick.name)).toEqual(['Story time', 'Harvest fair']);
    expect(result.picks.some((pick) => pick.sourceUrl?.includes('wikipedia'))).toBe(false);
  });

  it('does not search when two real finds sit beside a Wikipedia page', async () => {
    const liveSearch = vi.fn(async () => []);
    const result = await topUpShortRadar({ radar: [find(), fair, wiki], liveSearch });

    expect(liveSearch).not.toHaveBeenCalled();
    expect(result.picks.map((pick) => pick.name)).toEqual(['Story time', 'Harvest fair']);
  });

  it('keeps a find that has no page yet, and searches when it is the only one', async () => {
    const unlinked = find({ sourceUrl: undefined, url: undefined });
    expect(isSuitableFind(unlinked)).toBe(true);
    const liveSearch = vi.fn(async () => [fair]);
    const result = await topUpShortRadar({ radar: [unlinked], liveSearch });

    expect(liveSearch).toHaveBeenCalledTimes(1);
    expect(result.picks.map((pick) => pick.name)).toEqual(['Story time', 'Harvest fair']);
  });

  it('stops at three finds and does not call the live search twice', async () => {
    const extra = ['One', 'Two', 'Three', 'Four'].map((name) =>
      find({ name, sourceUrl: `https://venue.example/${name}` }),
    );
    const liveSearch = vi.fn(async () => extra);
    const result = await topUpShortRadar({ radar: [find()], liveSearch });

    expect(liveSearch).toHaveBeenCalledTimes(1);
    expect(result.picks.map((pick) => pick.name)).toEqual(['Story time', 'One', 'Two']);
  });

  it('prefers the venue page over a listing of the same find', () => {
    const listing = find({
      name: 'Harvest fair',
      sourceName: 'Fairgrounds',
      sourceUrl: 'https://news.example/weekend-listing',
    });
    const venue = find({
      name: 'Harvest fair',
      sourceName: 'Fairgrounds',
      sourceUrl: 'https://fairgrounds.example/harvest',
    });
    const merged = mergeTopUp([listing], [venue]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.sourceUrl).toBe('https://fairgrounds.example/harvest');
  });

  it('keeps two venues or two dates that share a title as two finds (Devin)', () => {
    const north = find({ name: 'Story time', sourceName: 'North Library' });
    const south = find({ name: 'Story time', sourceName: 'South Library' });
    expect(mergeTopUp([north], [south])).toHaveLength(2);

    const sat = find({ eventDate: '2026-11-07', when: 'Saturday 10:00' });
    const sun = find({ eventDate: '2026-11-08', when: 'Sunday 10:00' });
    expect(mergeTopUp([sat], [sun])).toHaveLength(2);
  });

  it('keeps known time, price, and venue identity when the venue link wins (Devin)', () => {
    const radar = find({
      name: 'Harvest fair',
      sourceName: 'Fairgrounds',
      when: 'Sat 9am-4pm',
      price: '$5',
      placeId: 'place-1',
      sourceUrl: 'https://news.example/weekend-listing',
    });
    const live = find({
      name: 'Harvest fair',
      sourceName: 'Fairgrounds',
      when: null,
      price: null,
      sourceUrl: 'https://fairgrounds.example/harvest',
    });
    const merged = mergeTopUp([radar], [live]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      sourceUrl: 'https://fairgrounds.example/harvest',
      when: 'Sat 9am-4pm',
      price: '$5',
      placeId: 'place-1',
    });
  });

  it('treats one event with differently written times as one find (Devin)', () => {
    const radar = find({ when: 'Saturday 10:00 AM', eventDate: '2026-11-07' });
    const live = find({
      when: 'Sat 10am',
      eventDate: '2026-11-07',
      sourceUrl: 'https://listing.example/story',
    });
    const picks = mergeTopUp([radar], [live, fair]);
    expect(picks.map((pick) => pick.name)).toEqual(['Story time', 'Harvest fair']);
  });

  it('names a failed live search and still returns the radar find', async () => {
    const liveSearch = vi.fn(async () => {
      throw new Error('socket hang up');
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await topUpShortRadar({ radar: [find()], liveSearch });

    expect(liveSearch).toHaveBeenCalledTimes(1);
    expect(result.outcome).toBe('failed');
    expect(result.picks.map((pick) => pick.name)).toEqual(['Story time']);
    expect(error).toHaveBeenCalledWith({ err: 'Error' }, 'coach find: live top-up failed');
    error.mockRestore();
  });
});
