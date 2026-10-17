import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_PAGE_BYTES,
  MAX_PAGE_TEXT_CHARS,
  createFetchBody,
  createFetchPage,
  stripHtml,
} from './fetch';

it('preserves published non-dollar currencies in page text', () => {
  expect(stripHtml('<td>&pound;31 per Month</td><td>&euro;12</td><td>&yen;500</td>')).toBe(
    '£31 per Month €12 ¥500',
  );
});
// ── createFetchBody / createFetchPage ────────────────────────────────────────

/**
 * VIL-261. The first live sweep recorded Vaughan as `fetch_failed`, and behind that
 * 403 sat a second failure that would have outlived it: vaughan.ca is ~890 KB of
 * markup and its "Key Dates" block starts at raw offset ~837 K, so the old
 * `stripHtml(body.slice(0, 500_000))` threw the dates away and handed the model a
 * page that genuinely appears to publish nothing.
 *
 * That is the worst shape a failure can take here — a silent truncation does not
 * look like an error, it looks like a municipality that has not announced its dates.
 * So the cap moved to where it belongs (the text the model reads, which is 44 K even
 * for Vaughan) and anything too large to be a page is REFUSED rather than trimmed.
 */
interface TestOrigin {
  url: string;
  redirectTo: string | null;
  close: () => Promise<void>;
}

/** A real origin on localhost, so `fetch` is the one under test rather than a spy. */
async function listen(bodies: Record<string, string>): Promise<TestOrigin> {
  const origin: TestOrigin = { url: '', redirectTo: null, close: () => Promise.resolve() };
  const server: Server = createServer((req, res) => {
    if (origin.redirectTo !== null) {
      res.writeHead(302, { location: origin.redirectTo });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(bodies[req.url ?? ''] ?? '<p>?</p>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  origin.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return origin;
}

describe('createFetchBody / createFetchPage', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(body: string, init: ResponseInit = {}) {
    const spy = vi.fn(async () => new Response(body, { status: 200, ...init }));
    vi.stubGlobal('fetch', spy);
    return spy;
  }

  /** Vaughan's real shape: the readable text is small, the markup around it is not. */
  function pageWithDatesAtRawOffset(offset: number): string {
    const filler = '<div class="menu-item"><span class="icon"></span></div>';
    const dates =
      '<p>Fall Session eGuide is viewable beginning Wednesday, August 5. Registration for ' +
      'general programs begins Tuesday, August 18 at 7 a.m. for residents.</p>';
    return `<html><body>${filler.repeat(Math.ceil(offset / filler.length))}${dates}</body></html>`;
  }

  it('keeps registration dates that sit past the old 500 KB raw-html cap', async () => {
    const html = pageWithDatesAtRawOffset(837_000);
    expect(html.length).toBeGreaterThan(500_000);
    stubFetch(html);

    const text = await createFetchPage()('https://www.vaughan.ca/recreation-programs');

    expect(text).toContain('Registration for general programs begins Tuesday, August 18 at 7 a.m.');
    expect(text).toContain('Fall Session eGuide is viewable beginning Wednesday, August 5');
  });

  it('bounds the text handed to the model, not the markup it was stripped from', async () => {
    // Readable text well past the ceiling: this is the case the cap exists for, and
    // the only one in which losing the tail is the right trade.
    const sentence = 'Registration information for the fall session follows. ';
    stubFetch(`<html><body><p>${sentence.repeat(6_000)}</p></body></html>`);

    const text = await createFetchPage()('https://example.ca/huge');

    expect(sentence.length * 6_000).toBeGreaterThan(MAX_PAGE_TEXT_CHARS);
    expect(text.length).toBe(MAX_PAGE_TEXT_CHARS);
  });

  it('refuses a body too large to be a page instead of silently trimming it', async () => {
    // A refusal becomes a visible `fetch_failed` line in the founder digest. A trim
    // becomes "this town publishes no dates", which is a lie nobody would question.
    stubFetch('x'.repeat(MAX_PAGE_BYTES + 1));

    await expect(createFetchPage()('https://example.ca/video.mp4')).rejects.toThrow(
      /exceeds the .* ceiling/,
    );
  });

  it('sends no User-Agent of its own', async () => {
    // MEASURED, NOT ASSUMED (VIL-261): vaughan.ca's Akamai bot manager 403s a request
    // carrying `Mozilla/5.0 (compatible; HaleRegistrationVerifier/1.0; +https://…)`
    // and 200s the same request under Node's default `user-agent: node`. Introducing
    // a descriptive crawler UA — the obvious "be a polite citizen" change — silently
    // costs us a municipality, and the sweep reports it as an ordinary fetch failure.
    const spy = stubFetch('<p>ok</p>');

    await createFetchPage()('https://www.vaughan.ca/recreation-programs');

    const headers = (spy.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Record<
      string,
      string
    >;
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain('user-agent');
  });

  it('returns the raw body, and createFetchPage is the strip over it', async () => {
    // VIL-337. A PerfectMind course page publishes nothing readable about availability
    // and carries the whole record as a JSON object literal inside a <script> block —
    // which `stripHtml` deletes outright. So the two callers cannot share one function:
    // the verify sweep reads a page's words, the spot watcher reads a page's model.
    const html =
      '<html><body><script>var eventInfo = {"SpotsLeft":11};</script><p>Course Dates</p></body></html>';
    stubFetch(html);

    const body = await createFetchBody()('https://cityofmarkham.perfectmind.com/course');
    const text = await createFetchPage()('https://cityofmarkham.perfectmind.com/course');

    expect(body).toBe(html);
    expect(body).toContain('"SpotsLeft":11');
    expect(text).toBe('Course Dates');
  });

  it('refuses below the strip, so both callers inherit the ceiling and the status throw', async () => {
    stubFetch('x'.repeat(MAX_PAGE_BYTES + 1));
    await expect(createFetchBody()('https://example.ca/video.mp4')).rejects.toThrow(
      /exceeds the .* ceiling/,
    );

    stubFetch('<p>nope</p>', { status: 404 });
    await expect(createFetchBody()('https://example.ca/gone')).rejects.toThrow(/HTTP 404/);
  });

  it('refuses on the declared length, before a byte of the body is buffered', async () => {
    // A misbehaving origin (or one serving a video by mistake) can otherwise force the
    // whole body into memory before the post-read ceiling gets a say — and this
    // primitive now runs INSIDE an inbound SMS turn, on a URL a parent pasted.
    let buffered = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          ({
            ok: true,
            status: 200,
            headers: new Headers({ 'content-length': String(5 * 1024 * 1024) }),
            text: async () => {
              buffered = true;
              return 'x'.repeat(5 * 1024 * 1024);
            },
          }) as unknown as Response,
      ),
    );

    await expect(createFetchBody()('https://example.ca/huge')).rejects.toThrow(
      /exceeds the .* ceiling/,
    );
    expect(buffered).toBe(false);
  });

  it('refuses a redirect rather than poll a host nobody approved', async () => {
    // NOT STUBBED, because the flag is not the property: only the real fetch can show
    // that a 302 becomes a failure. The spot watcher polls one sanitized, allowlisted
    // course URL every ten minutes for sixty days (VIL-337); an SSO bounce, a CDN
    // challenge or a tenant migration that silently moves the poll to another origin
    // would keep returning 200s from a page the host registry never approved, and the
    // watch would look healthy the whole time.
    const bodies = { '/course': '<p>the real course page</p>', '/moved': '<p>somewhere else</p>' };
    const [origin, elsewhere] = await Promise.all([listen(bodies), listen(bodies)]);
    try {
      await expect(createFetchBody()(`${origin.url}/course`)).resolves.toContain('real course');

      origin.redirectTo = `${elsewhere.url}/moved`;

      const followed = await createFetchBody()(`${origin.url}/course`).catch((err) => err);

      expect(followed).toBeInstanceOf(Error);
      expect(String(followed)).not.toContain('somewhere else');
    } finally {
      await Promise.all([origin.close(), elsewhere.close()]);
    }
  });

  it('names the fetch, not the sweep that used to own it', async () => {
    // The spot watcher (VIL-337) fetches through this primitive too, and its refusals
    // are logged. A message that says "registration verify" would send whoever reads
    // that log to the wrong sweep.
    stubFetch('<p>nope</p>', { status: 404 });

    await expect(createFetchBody()('https://example.ca/gone')).rejects.toThrow(
      /^page fetch https:\/\/example\.ca\/gone/,
    );
  });
});
