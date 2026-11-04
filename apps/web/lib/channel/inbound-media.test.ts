import { describe, expect, it, vi } from 'vitest';
import {
  classifyInboundMedia,
  httpsMediaUrl,
  inboundMediaFromStored,
  mediaPartFromLinq,
  persistableMedia,
  readInboundMedia,
} from './inbound-media';

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

  it('classifies a .vcf as a contact card, and lets a real image mime win', () => {
    expect(classifyInboundMedia('text/vcard', null, null)).toBe('contact');
    expect(classifyInboundMedia('text/x-vcard; charset=utf-8', null, null)).toBe('contact');
    expect(classifyInboundMedia('application/octet-stream', null, 'Mom.VCF')).toBe('contact');
    expect(classifyInboundMedia(null, 'https://cdn.example/cards/jane.vcf?sig=1', null)).toBe(
      'contact',
    );
    expect(classifyInboundMedia('image/jpeg', null, 'card.vcf')).toBe('image');
    expect(classifyInboundMedia('application/pdf', null, 'form.pdf')).toBe('file');
  });
});

describe('a stored contact card', () => {
  it('keeps kind contact, and drops a url that is not https', () => {
    const part = mediaPartFromLinq({
      type: 'media',
      url: 'https://cdn.example/files/abc',
      mime_type: 'text/vcard; charset=utf-8',
      filename: 'Mom.vcf',
    });
    expect(part).toEqual({
      kind: 'contact',
      url: 'https://cdn.example/files/abc',
      mime: 'text/vcard',
    });
    expect(persistableMedia([part])).toEqual([part]);
    expect(inboundMediaFromStored(persistableMedia([part]))).toEqual([part]);
    expect(
      persistableMedia([{ kind: 'contact', url: 'http://cdn.example/a.vcf', mime: 'text/vcard' }]),
    ).toEqual([{ kind: 'contact', url: null, mime: 'text/vcard' }]);
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

  it('fetches a .vcf into name and number, and does not fetch a generic file', async () => {
    const vcf = ['BEGIN:VCARD', 'FN:Jane Smith', 'TEL;TYPE=CELL:+14165550100', 'END:VCARD'].join(
      '\n',
    );
    const fetchImpl = vi.fn(async () => new Response(vcf, { status: 200 }));
    const read = await readInboundMedia(
      [
        { kind: 'contact', url: 'https://cdn.example/Jane.vcf', mime: 'text/vcard' },
        { kind: 'file', url: 'https://cdn.example/form.pdf', mime: 'application/pdf' },
      ],
      fetchImpl as unknown as typeof fetch,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(read.blocks).toEqual([]);
    expect(read.unwatched).toEqual([{ kind: 'file' }]);
    expect(read.contacts).toEqual([
      {
        name: 'Jane Smith',
        phones: [{ number: '+14165550100', e164: '+14165550100', label: 'cell' }],
      },
    ]);
  });

  it('names a contact card it could not read, and does not follow a redirect off https', async () => {
    const offHttps = new Response('BEGIN:VCARD\nFN:Jane\nEND:VCARD', { status: 200 });
    Object.defineProperty(offHttps, 'url', { value: 'http://cdn.example/card.vcf' });
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/gone.vcf')) return new Response('not a card', { status: 200 });
      return offHttps;
    });
    const read = await readInboundMedia(
      [
        { kind: 'contact', url: 'http://cdn.example/card.vcf', mime: 'text/vcard' },
        { kind: 'contact', url: 'https://cdn.example/gone.vcf', mime: 'text/vcard' },
        { kind: 'contact', url: 'https://cdn.example/redirect.vcf', mime: 'text/vcard' },
      ],
      fetchImpl as unknown as typeof fetch,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(read.contacts).toEqual([]);
    expect(read.unwatched).toEqual([{ kind: 'contact' }, { kind: 'contact' }, { kind: 'contact' }]);
  });

  it('does not read a contact card over the size cap', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response('BEGIN:VCARD\nFN:Jane\nEND:VCARD', {
          status: 200,
          headers: { 'content-length': '3000000' },
        }),
    );
    const read = await readInboundMedia(
      [{ kind: 'contact', url: 'https://cdn.example/huge.vcf', mime: 'text/vcard' }],
      fetchImpl as unknown as typeof fetch,
    );
    expect(read.contacts).toEqual([]);
    expect(read.unwatched).toEqual([{ kind: 'contact' }]);
  });

  it('does not fetch a contact card on a private or metadata host, and checks every redirect hop', async () => {
    const vcf = 'BEGIN:VCARD\nFN:Jane\nTEL:+14165550100\nEND:VCARD';
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === 'https://cdn.example/hop.vcf') {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://169.254.169.254/latest/meta-data' },
        });
      }
      if (url === 'https://cdn.example/ok-hop.vcf') {
        return new Response(null, { status: 302, headers: { location: '/real.vcf' } });
      }
      return new Response(vcf, { status: 200 });
    });
    const read = await readInboundMedia(
      [
        { kind: 'contact', url: 'https://127.0.0.1/card.vcf', mime: 'text/vcard' },
        { kind: 'contact', url: 'https://10.0.0.5/card.vcf', mime: 'text/vcard' },
        { kind: 'contact', url: 'https://[::1]/card.vcf', mime: 'text/vcard' },
        { kind: 'contact', url: 'https://metadata.google.internal/card.vcf', mime: 'text/vcard' },
        { kind: 'contact', url: 'https://localhost/card.vcf', mime: 'text/vcard' },
        { kind: 'contact', url: 'https://cdn.example/hop.vcf', mime: 'text/vcard' },
        { kind: 'contact', url: 'https://cdn.example/ok-hop.vcf', mime: 'text/vcard' },
      ],
      fetchImpl as unknown as typeof fetch,
    );
    const called = fetchImpl.mock.calls.map(([url]) => url);
    expect(called).toEqual([
      'https://cdn.example/hop.vcf',
      'https://cdn.example/ok-hop.vcf',
      'https://cdn.example/real.vcf',
    ]);
    for (const [, init] of fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>) {
      expect(init.redirect).toBe('manual');
    }
    expect(read.contacts).toEqual([
      { name: 'Jane', phones: [{ number: '+14165550100', e164: '+14165550100', label: null }] },
    ]);
    expect(read.unwatched).toHaveLength(6);
  });
});
