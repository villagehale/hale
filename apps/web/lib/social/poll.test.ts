import { describe, expect, it } from 'vitest';
import type { DiscoveryPoll } from './discovery';
import { extractSocialSpotPlaceholder } from './extract';
import {
  type DueSource,
  SOCIAL_POLL_BATCH,
  type SocialWatchPorts,
  type SpotInsert,
  runSocialWatch,
} from './poll';
import type { SignupWatchStore } from './signup-watch';

const NOW = new Date('2026-10-01T13:00:00.000Z');

function source(over: Partial<DueSource> = {}): DueSource {
  return {
    id: 'src-1',
    handle: 'downeysfarm',
    displayName: "Downey's Farm",
    category: 'T2',
    region: 'peel',
    geoFsa: 'L7C',
    lastMediaId: null,
    ...over,
  };
}

function ports(
  over: Partial<SocialWatchPorts> = {},
): SocialWatchPorts & { spots: SpotInsert[]; marks: string[] } {
  const spots: SpotInsert[] = [];
  const marks: string[] = [];
  const signupStore: SignupWatchStore = {
    async due() {
      return [];
    },
    async save() {},
  };
  return {
    spots,
    marks,
    now: NOW,
    listDue: async (limit) => {
      expect(limit).toBe(SOCIAL_POLL_BATCH);
      return [source()];
    },
    poll: async () => ({ status: 'ok', media: [] }) satisfies DiscoveryPoll,
    extract: async (caption, title) => extractSocialSpotPlaceholder(caption, title),
    markPolled: async (_id, lastMediaId) => {
      marks.push(lastMediaId ?? '');
    },
    insertSpot: async (spot) => {
      spots.push(spot);
      return { id: `spot-${spots.length}` };
    },
    signupStore,
    fetchPage: async () => ({ ok: true, html: '' }),
    llm: 'not_configured',
    ...over,
  };
}

describe('runSocialWatch', () => {
  it('does nothing when the flag is off', async () => {
    let listed = false;
    const result = await runSocialWatch(
      false,
      true,
      ports({
        listDue: async () => {
          listed = true;
          return [];
        },
      }),
    );
    expect(result).toEqual({ skipped: 'flag_off' });
    expect(listed).toBe(false);
  });

  it('names a missing Meta token and still ticks signup watches', async () => {
    let checked = false;
    const signupStore: SignupWatchStore = {
      async due() {
        checked = true;
        return [];
      },
      async save() {},
    };
    const result = await runSocialWatch(true, false, ports({ signupStore }));
    expect(checked).toBe(true);
    expect(result).toMatchObject({ poll: { skipped: 'meta_not_configured' } });
  });

  it('sets a watermark and extracts nothing on the first poll', async () => {
    const store = ports({
      poll: async () => ({
        status: 'ok',
        media: [
          {
            id: 'newest',
            caption: 'Ages 3-5 years on 2026-10-10',
            timestamp: '2026-09-27T12:00:00+0000',
            permalink: 'https://www.instagram.com/p/newest/',
            mediaType: 'IMAGE',
          },
        ],
      }),
    });
    const result = await runSocialWatch(true, true, store);
    expect(store.spots).toHaveLength(0);
    expect(store.marks).toEqual(['newest']);
    expect(result).toMatchObject({ poll: { baseline: 1, inserted: 0, llm: 'not_configured' } });
  });

  it('inserts a new caption and schedules a signup watch when the clock and url are both present', async () => {
    const store = ports({
      listDue: async () => [source({ lastMediaId: 'old' })],
      poll: async () => ({
        status: 'ok',
        media: [
          {
            id: 'new',
            caption:
              'Registration opens 2026-10-01T09:00:00-04:00. Ages 3-5 years. https://downeysfarm.com/reg',
            timestamp: '2026-09-28T12:00:00+0000',
            permalink: 'https://www.instagram.com/p/new/',
            mediaType: 'REEL',
          },
          {
            id: 'old',
            caption: 'seen',
            timestamp: '2026-09-01T12:00:00+0000',
            permalink: 'https://www.instagram.com/p/old/',
            mediaType: 'IMAGE',
          },
        ],
      }),
    });
    const result = await runSocialWatch(true, true, store);
    expect(store.spots).toHaveLength(1);
    expect(store.spots[0]?.mediaKind).toBe('reel');
    expect(store.spots[0]?.watchStatus).toBe('scheduled');
    expect(store.spots[0]?.registrationUrl).toBe('https://downeysfarm.com/reg');
    expect(store.spots[0]?.nextWakeAt).not.toBeNull();
    expect(result).toMatchObject({ poll: { inserted: 1, baseline: 0 } });
  });
});
