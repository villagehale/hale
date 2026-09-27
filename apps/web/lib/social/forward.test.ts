import { describe, expect, it } from 'vitest';
import {
  type ForwardStore,
  acceptParentForward,
  detectSocialForward,
  forwardMediaId,
  queueParentForward,
} from './forward';

function memoryStore(): ForwardStore & {
  spots: { familyId: string; permalink: string; mediaKind: string }[];
} {
  const spots: { familyId: string; permalink: string; mediaKind: string }[] = [];
  return {
    spots,
    async ensureSource() {
      return { id: 'source-1', region: 'toronto' };
    },
    async insertSpot(input) {
      spots.push({
        familyId: input.familyId,
        permalink: input.permalink,
        mediaKind: input.mediaKind,
      });
      return { id: `spot-${spots.length}` };
    },
  };
}

describe('detectSocialForward', () => {
  it('takes an instagram link and a screenshot url', () => {
    expect(detectSocialForward('look https://www.instagram.com/p/abc123/')).toEqual({
      url: 'https://www.instagram.com/p/abc123/',
      kind: 'link',
    });
    expect(detectSocialForward('https://files.example/flyer.png?sig=1')).toEqual({
      url: 'https://files.example/flyer.png?sig=1',
      kind: 'screenshot',
    });
  });

  it('ignores a plain web page', () => {
    expect(detectSocialForward('https://downeysfarm.com/pumpkinfest')).toBeNull();
  });
});

describe('queueParentForward', () => {
  it('queues the url for extraction and does not invent a caption', async () => {
    const store = memoryStore();
    const familyId = '11111111-1111-4111-8111-111111111111';
    const queued = await queueParentForward(store, {
      familyId,
      url: 'https://www.instagram.com/stories/highlights/1/',
      kind: 'link',
    });
    expect(queued.status).toBe('queued');
    expect(store.spots[0]?.mediaKind).toBe('story_forward');
    expect(store.spots[0]?.permalink).toContain('instagram.com');
    expect(forwardMediaId(store.spots[0]?.permalink ?? '')).toHaveLength(32);
  });
});

describe('acceptParentForward', () => {
  it('rejects a body that is not a social url and queues one that is', async () => {
    const store = memoryStore();
    const familyId = '11111111-1111-4111-8111-111111111111';
    expect(await acceptParentForward(store, { familyId, url: 'https://example.com/x' })).toEqual({
      status: 'skipped',
      skipped: 'not_a_forward',
    });
    const queued = await acceptParentForward(store, {
      familyId,
      url: 'https://www.facebook.com/events/1',
    });
    expect(queued.status).toBe('queued');
    expect(store.spots).toHaveLength(1);
  });
});
