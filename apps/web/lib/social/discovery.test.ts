import { afterEach, describe, expect, it } from 'vitest';
import {
  type DiscoveryMedia,
  META_GRAPH_ACCESS_TOKEN_ENV,
  META_IG_USER_ID_ENV,
  businessDiscoveryUrl,
  diffNewMedia,
  pollBusinessDiscovery,
} from './discovery';

const media = (id: string): DiscoveryMedia => ({
  id,
  caption: `caption ${id}`,
  timestamp: '2026-09-27T12:00:00+0000',
  permalink: `https://www.instagram.com/p/${id}/`,
  mediaType: 'IMAGE',
});

describe('businessDiscoveryUrl', () => {
  it('asks Graph for public media on the target username and not for stories', () => {
    const url = businessDiscoveryUrl('1789', '@DowneysFarm');
    expect(url).toContain('/v21.0/1789?fields=');
    expect(decodeURIComponent(url)).toContain('business_discovery.username(DowneysFarm)');
    expect(decodeURIComponent(url)).toContain(
      'media.limit(20){id,caption,timestamp,permalink,media_type}',
    );
    expect(url.toLowerCase()).not.toContain('stories');
  });
});

describe('pollBusinessDiscovery', () => {
  afterEach(() => {
    Reflect.deleteProperty(process.env, META_GRAPH_ACCESS_TOKEN_ENV);
    Reflect.deleteProperty(process.env, META_IG_USER_ID_ENV);
  });

  it('returns a named stub and does not fetch when the token or user id is missing', async () => {
    let called = false;
    const result = await pollBusinessDiscovery('downeysfarm', {
      fetch: async () => {
        called = true;
        throw new Error('should not fetch');
      },
    });
    expect(result).toEqual({ status: 'stub', skipped: 'meta_not_configured' });
    expect(called).toBe(false);
  });

  it('names a graph error without putting the token in the result', async () => {
    process.env[META_GRAPH_ACCESS_TOKEN_ENV] = 'secret-token-value';
    process.env[META_IG_USER_ID_ENV] = '1789';
    const result = await pollBusinessDiscovery('downeysfarm', {
      fetch: async () => new Response('no', { status: 400 }),
    });
    expect(result).toEqual({ status: 'error', skipped: 'graph_error' });
    expect(JSON.stringify(result)).not.toContain('secret-token-value');
  });

  it('reads media and drops a row that has no id', async () => {
    process.env[META_GRAPH_ACCESS_TOKEN_ENV] = 'secret-token-value';
    process.env[META_IG_USER_ID_ENV] = '1789';
    const result = await pollBusinessDiscovery('downeysfarm', {
      fetch: async () =>
        Response.json({
          business_discovery: {
            media: {
              data: [
                {
                  id: '1',
                  caption: 'Pumpkinfest',
                  timestamp: '2026-09-27T12:00:00+0000',
                  permalink: 'https://www.instagram.com/p/1/',
                  media_type: 'IMAGE',
                },
                { caption: 'no id' },
              ],
            },
          },
        }),
    });
    expect(result).toEqual({
      status: 'ok',
      media: [
        {
          id: '1',
          caption: 'Pumpkinfest',
          timestamp: '2026-09-27T12:00:00+0000',
          permalink: 'https://www.instagram.com/p/1/',
          mediaType: 'IMAGE',
        },
      ],
    });
  });
});

describe('diffNewMedia', () => {
  const page = [media('c'), media('b'), media('a')];

  it('establishes a baseline and extracts nothing when there is no watermark', () => {
    expect(diffNewMedia(page, null)).toEqual({ fresh: [], nextWatermark: 'c' });
  });

  it('returns only media newer than the watermark', () => {
    expect(diffNewMedia(page, 'b').fresh.map((item) => item.id)).toEqual(['c']);
  });

  it('treats a watermark that has scrolled off the page as a full page of new media', () => {
    expect(diffNewMedia(page, 'gone').fresh).toHaveLength(3);
  });
});
