import { describe, expect, it, vi } from 'vitest';
import { classifyInboundMedia, httpsMediaUrl, readInboundMedia } from './inbound-media';

describe('classifyInboundMedia', () => {
  it('reads an image mime, a video mime, and a file otherwise', () => {
    expect(classifyInboundMedia('image/jpeg', null, null)).toBe('image');
    expect(classifyInboundMedia('video/mp4', null, null)).toBe('video');
    expect(classifyInboundMedia('application/pdf', null, 'form.pdf')).toBe('file');
  });

  it('classifies from the filename when the mime is missing', () => {
    expect(classifyInboundMedia(null, null, 'flyer.PNG')).toBe('image');
    expect(classifyInboundMedia(null, 'https://cdn.example/clip.mov', null)).toBe('video');
  });
});

describe('httpsMediaUrl', () => {
  it('keeps https and drops everything else', () => {
    expect(httpsMediaUrl('https://cdn.example/a.jpg')).toBe('https://cdn.example/a.jpg');
    expect(httpsMediaUrl('http://cdn.example/a.jpg')).toBeNull();
    expect(httpsMediaUrl('https://user:pw@cdn.example/a.jpg')).toBeNull();
    expect(httpsMediaUrl('not a url')).toBeNull();
  });
});

describe('readInboundMedia', () => {
  it('turns a jpeg into an image block and names a video instead of fetching it', async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0xd9]);
    const fetchImpl = vi.fn(async () => new Response(jpeg, { status: 200 }));
    const read = await readInboundMedia(
      [
        { kind: 'image', url: 'https://cdn.example/flyer.jpg', mime: 'image/jpeg' },
        { kind: 'video', url: 'https://cdn.example/clip.mp4', mime: 'video/mp4' },
      ],
      fetchImpl as unknown as typeof fetch,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(read.blocks[0]).toMatchObject({ type: 'image' });
    expect(read.unwatched).toEqual([{ kind: 'video' }]);
  });

  it('names an image it could not open, and does not throw', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('down');
    });
    const read = await readInboundMedia(
      [{ kind: 'image', url: 'https://cdn.example/flyer.jpg', mime: 'image/jpeg' }],
      fetchImpl as unknown as typeof fetch,
    );
    expect(read.blocks).toEqual([]);
    expect(read.unwatched).toEqual([{ kind: 'image' }]);
  });
});
