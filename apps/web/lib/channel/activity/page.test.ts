import { describe, expect, it, vi } from 'vitest';
import { stripHtml } from '~/lib/registration/fetch';
import { RegistrationPageRedirect } from '~/lib/registration/page';
import burlington from './__fixtures__/burlington-occurrences-2026-11-02.json';
import montreal from './__fixtures__/montreal-location-2026-10-30.json';
import { bindActivityFacts } from './facts';
import { createActivityPageFetch, readActivityPages } from './page';

describe('dated occurrence ownership', () => {
  const [old, current] = burlington.pages;
  const session = {
    date: '2026-10-30',
    start_time: '10:30',
    end_time: '11:00',
    evidence: 'Friday, October 30, 2026, 10:30am - 11:00am',
  };
  const item = {
    name: 'Family Storytime',
    name_evidence: 'Family Storytime',
    source_name: 'Burlington Public Library',
    source_url: old!.url,
    age_fit: 'Ages 5 and under.',
    age_evidence: 'Ages 5 and under.',
    sessions: [session],
  };
  const bind = (
    raw: typeof item,
    page: Awaited<ReturnType<ReturnType<typeof createActivityPageFetch>>>,
  ) =>
    bindActivityFacts(
      [raw],
      [{ ...page, text: stripHtml(page.text) }],
      'October 2026',
      new Date('2026-10-15T12:00:00Z'),
    );

  it('rejects the recorded October 30 date on the October 23 detail URL, including reference evidence', async () => {
    const page = await createActivityPageFetch(async () => old!.html)(old!.url);
    const result = bind(item, page);
    expect(result.picks).toEqual([]);
    expect(result.references[0]).toMatchObject({
      sourceUrl: old!.url,
      when: null,
      evidence: { sessions: [] },
    });
    expect(JSON.stringify(result)).not.toContain('October 30');
  });

  it('keeps the same date on its own freshly read detail page', async () => {
    const page = await createActivityPageFetch(async () => current!.html)(current!.url);
    const result = bind(
      {
        ...item,
        source_url: current!.url,
        sessions: [{ ...session, evidence: 'Friday, October 30' }],
      },
      page,
    );
    expect(result.picks[0]).toMatchObject({
      source_url: current!.url,
      event_date: '2026-10-30',
      when: '2026-10-30 10:30–11:00',
    });
  });

  it('cannot bypass occurrence ownership by labeling a sidebar date as a regular schedule', async () => {
    const page = await createActivityPageFetch(async () => old!.html)(old!.url);
    const result = bindActivityFacts(
      [
        {
          ...item,
          sessions: [],
          schedule_kind: 'recurring',
          when: session.evidence,
          when_evidence: session.evidence,
        },
      ],
      [{ ...page, text: stripHtml(page.text) }],
      'October 2026',
      new Date('2026-10-15T12:00:00Z'),
    );
    expect(result.picks).toEqual([]);
    expect(result.references[0]).toMatchObject({ when: null, evidence: { schedule: null } });
  });

  it.each(['start_time', 'end_time'] as const)(
    'rejects a different %s despite matching quoted date',
    async (field) => {
      const page = await createActivityPageFetch(async () => current!.html)(current!.url);
      expect(
        bind(
          {
            ...item,
            source_url: current!.url,
            sessions: [{ ...session, evidence: 'Friday, October 30', [field]: '12:30' }],
          },
          page,
        ).picks,
      ).toEqual([]);
    },
  );

  it.each(['2026-02-30T10:30', '2026-10-30T25:00'])(
    'does not trust invalid source timestamps: %s',
    async (start) => {
      const page = await createActivityPageFetch(async () =>
        current!.html.replace('2026-10-30T10:30', start),
      )(current!.url);
      expect(
        bind(
          {
            ...item,
            source_url: current!.url,
            sessions: [{ ...session, evidence: 'Friday, October 30' }],
          },
          page,
        ).picks,
      ).toEqual([]);
    },
  );

  it('rejects conflicting primary metadata and does not fall back to the full-page quote', async () => {
    const page = await createActivityPageFetch(
      async () => old!.html + current!.html.replaceAll('16944995', '16944994'),
    )(old!.url);
    expect(page.occurrence).toBeNull();
    expect(bind(item, page).picks).toEqual([]);
  });

  it('retains per-page metadata inside a JSON-LD graph', async () => {
    const html = current!.html.replace(/(<script[^>]*>)(.*?)(<\/script>)/, '$1{"@graph":[$2]}$3');
    const page = await createActivityPageFetch(async () => html)(current!.url);
    expect(page.occurrence).toMatchObject({ startDate: '2026-10-30T10:30' });
  });

  it('does not invent an end time constraint when metadata only publishes the start', async () => {
    const html = current!.html.replace(/,"endDate":"[^"]*"/, '');
    const page = await createActivityPageFetch(async () => html)(current!.url);
    const result = bind(
      {
        ...item,
        source_url: current!.url,
        sessions: [{ ...session, evidence: 'Friday, October 30' }],
      },
      page,
    );
    expect(result.picks[0]?.event_date).toBe('2026-10-30');
  });

  it('reads a discovered occurrence detail and keeps its source URL within the existing budget', async () => {
    const fetch = vi.fn(
      async (url: string) => burlington.pages.find((page) => page.url === url)!.html,
    );
    const result = await readActivityPages(
      [old!.url],
      createActivityPageFetch(fetch),
      'Burlington, Ontario, Canada',
    );
    expect(fetch.mock.calls).toEqual([[old!.url], [current!.url]]);
    expect(result.pages.map((page) => [page.url, page.occurrence?.startDate])).toEqual([
      [old!.url, '2026-10-23T10:30'],
      [current!.url, '2026-10-30T10:30'],
    ]);
    expect(result.pagesRefused).toBe(0);
  });

  it('does not follow occurrence links after the three initial source slots are used', async () => {
    const fetch = vi.fn(async () => old!.html);
    await readActivityPages(
      [old!.url, 'https://a.example/', 'https://b.example/'],
      createActivityPageFetch(fetch),
    );
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls.flat()).not.toContain(current!.url);
  });

  it('keeps failed, unsafe and challenge detail links out of evidence', async () => {
    const html = old!.html.replace(
      '</aside>',
      '<a href="https://127.0.0.1/private">Family Storytime</a><a href="https://venue.example/?token=private">Family Storytime</a></aside>',
    );
    const fetch = vi.fn(async (url: string) =>
      url === old!.url ? html : '<title>Verify you are human</title>',
    );
    const result = await readActivityPages([old!.url], createActivityPageFetch(fetch));
    expect(fetch.mock.calls).toEqual([[old!.url], [current!.url]]);
    expect(result.pages).toHaveLength(1);
    expect(result.pagesRefused).toBe(1);
    expect(bind(item, result.pages[0]!).picks).toEqual([]);
  });

  it('keeps a genuine multi-session listing without treating one linked event as the whole page', async () => {
    const listing = { ...item, source_url: 'https://venue.example/events' };
    const page = await createActivityPageFetch(async () => old!.html)(listing.source_url);
    expect(page.occurrence).toBeUndefined();
    const result = bindActivityFacts(
      [
        {
          ...listing,
          sessions: [{ ...session, date: '2026-10-23', evidence: 'Friday, October 23' }, session],
        },
      ],
      [
        {
          url: listing.source_url,
          text: stripHtml(page.text),
        },
      ],
      'October 2026',
      new Date('2026-10-15T12:00:00Z'),
    );
    expect(result.picks[0]?.when).toBe('2026-10-23 10:30–11:00; 2026-10-30 10:30–11:00');
  });
});

describe('activity source redirects', () => {
  it.each([
    '<title>Verify you are human</title><p>Please enable JavaScript and cookies.</p>',
    '<title>Just a moment...</title><p>Checking your browser before accessing the site.</p>',
    '<title>Vérification de sécurité</title><p>Veuillez activer JavaScript.</p>',
    '<title>Radware Bot Manager Captcha</title><p>Complete the CAPTCHA to continue.</p>',
    '<p>Verify you are human. Please enable JavaScript.</p>',
  ])('refuses a successful HTTP response containing a challenge: %s', async (html) => {
    const fetch = vi.fn().mockResolvedValue(html);
    await expect(createActivityPageFetch(fetch)('https://venue.example/event')).rejects.toThrow(
      'challenge',
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('keeps an activity about CAPTCHA rather than treating the topic as a challenge', async () => {
    const text =
      '<title>Human verification workshop</title><p>Montréal (Québec) H2S 0C4. Learn about CAPTCHA and cookies.</p>';
    expect(await createActivityPageFetch(async () => text)('https://venue.example/event')).toEqual({
      url: 'https://venue.example/event',
      text,
    });
  });

  it.each(['https://venue.example/check', 'https://challenge.example/check'])(
    'refuses a challenge redirect to %s',
    async (target) => {
      const fetch = vi
        .fn()
        .mockRejectedValueOnce(new RegistrationPageRedirect(target))
        .mockResolvedValueOnce(
          '<title>Human Verification</title><p>Complete the security check.</p>',
        );
      await expect(createActivityPageFetch(fetch)('https://venue.example/event')).rejects.toThrow(
        'challenge',
      );
    },
  );

  it('keeps a normal cross-site booking redirect and CAPTCHA instructions', async () => {
    const target = 'https://booking.example/event';
    const text =
      '<title>Library storytime</title><p>Montréal, Québec, Canada. Complete a CAPTCHA when registering.</p>';
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new RegistrationPageRedirect(target))
      .mockResolvedValueOnce(text);
    expect(await createActivityPageFetch(fetch)('https://venue.example/event')).toEqual({
      url: target,
      text,
    });
  });

  it('verifies the captured Montreal event through its explicitly linked venue without mixing venue facts into event text', async () => {
    const fetch = vi.fn(async (url: string) => {
      if (url === montreal.event.url) return montreal.event.html;
      if (url === montreal.venue.url)
        return `${montreal.venue.html}<p>Other event: December 25, $99.</p>`;
      throw Error('unexpected source');
    });
    const page = await createActivityPageFetch(fetch)(
      montreal.event.url,
      'Montréal, Quebec, Canada',
    );
    expect(page).toEqual({
      url: montreal.event.url,
      text: montreal.event.html,
      locationVerified: true,
      locationSource: montreal.venue.url,
    });
    expect(fetch.mock.calls).toEqual([[montreal.event.url], [montreal.venue.url]]);
    expect(page.text).not.toContain('$99');
  });

  it.each([
    '<p>Bibliothèque Marc-Favreau. Montréal, Texas, United States</p>',
    '<p>Bibliothèque Marc-Favreau. Montréal (Ontario) Canada</p>',
    '<p>A different venue. Montréal (Québec) H2S 0C4</p>',
    '<title>Verify you are human</title><p>Enable JavaScript</p>',
    '<p>Bibliothèque Marc-Favreau, Montréal</p>',
  ])('does not verify an unreadable or unqualified linked venue: %s', async (venue) => {
    const fetch = vi.fn(async (url: string) =>
      url === montreal.event.url ? montreal.event.html : venue,
    );
    expect(
      await createActivityPageFetch(fetch)(montreal.event.url, 'Montréal, Quebec, Canada'),
    ).toMatchObject({ locationVerified: false });
  });

  it('does not follow arbitrary links or malformed structured data for location', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        '<p>Ville de Montréal <a href="/contact">Contact</a></p><script type="application/ld+json">{broken}</script>',
      );
    expect(
      await createActivityPageFetch(fetch)(
        'https://venue.example/event',
        'Montréal, Quebec, Canada',
      ),
    ).toMatchObject({ locationVerified: false });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not make a venue request when the event already publishes a qualified address', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(`${montreal.event.html}<p>Montréal (Québec) H2S 0C4</p>`);
    expect(
      await createActivityPageFetch(fetch)(montreal.event.url, 'Montréal, Quebec, Canada'),
    ).toMatchObject({ locationVerified: true });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    'http://venue.example/private',
    'https://127.0.0.1/private',
    'https://venue.example/?token=private',
  ])('validates a structured venue URL before requesting %s', async (url) => {
    const fetch = vi
      .fn()
      .mockResolvedValue(montreal.event.html.replaceAll(montreal.venue.url, url));
    expect(
      await createActivityPageFetch(fetch)(montreal.event.url, 'Montréal, Quebec, Canada'),
    ).toMatchObject({ locationVerified: false });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not recursively follow another event from the linked venue', async () => {
    const fetch = vi.fn().mockResolvedValue(montreal.event.html);
    expect(
      await createActivityPageFetch(fetch)(montreal.event.url, 'Montréal, Quebec, Canada'),
    ).toMatchObject({ locationVerified: false });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('does not use a related event or ambiguous venues as the primary event location', async () => {
    const other = montreal.event.html.replaceAll(montreal.venue.url, 'https://venue.example/other');
    for (const html of [
      montreal.event.html.replace(
        '<title>Heure du conte pour les 3 à 5 ans',
        '<title>A different activity',
      ),
      montreal.event.html + other,
    ]) {
      const fetch = vi.fn().mockResolvedValue(html);
      expect(
        await createActivityPageFetch(fetch)(montreal.event.url, 'Montréal, Quebec, Canada'),
      ).toMatchObject({ locationVerified: false });
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });

  it('reads a moved official page and retains the final source URL', async () => {
    const old = 'https://venue.example/old';
    const current = 'https://venue.example/programs';
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new RegistrationPageRedirect(current))
      .mockResolvedValueOnce('Current official page');
    expect(await createActivityPageFetch(fetch)(old)).toEqual({
      url: current,
      text: 'Current official page',
    });
    expect(fetch.mock.calls).toEqual([[old], [current]]);
  });

  it.each([
    'http://venue.example/a',
    'https://127.0.0.1/a',
    'https://venue.example/a?token=private',
  ])('refuses unsafe redirect %s before another request', async (target) => {
    const fetch = vi.fn().mockRejectedValue(new RegistrationPageRedirect(target));
    await expect(createActivityPageFetch(fetch)('https://venue.example/old')).rejects.toThrow(
      'unsafe URL',
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('bounds redirect loops without retrying ordinary fetch failures', async () => {
    const loop = vi
      .fn()
      .mockRejectedValue(new RegistrationPageRedirect('https://venue.example/loop'));
    await expect(createActivityPageFetch(loop)('https://venue.example/old')).rejects.toThrow();
    expect(loop).toHaveBeenCalledTimes(4);
    const failed = vi.fn().mockRejectedValue(new Error('timeout'));
    await expect(createActivityPageFetch(failed)('https://venue.example/old')).rejects.toThrow(
      'timeout',
    );
    expect(failed).toHaveBeenCalledTimes(1);
  });
});
