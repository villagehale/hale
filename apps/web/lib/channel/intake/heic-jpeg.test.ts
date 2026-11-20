import { describe, expect, it } from 'vitest';
import { heicToJpeg, looksLikeHeic } from './heic-jpeg';

describe('heicToJpeg', () => {
  it('leaves a JPEG alone and does not throw on a HEIC box that is not an image', async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    expect(looksLikeHeic(jpeg)).toBe(false);
    expect(await heicToJpeg(jpeg)).toBeNull();
    const box = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypheic'), Buffer.alloc(64)]);
    expect(looksLikeHeic(box)).toBe(true);
    expect(await heicToJpeg(box)).toBeNull();
  });
});
