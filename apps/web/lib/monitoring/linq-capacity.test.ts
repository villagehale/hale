import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Database } from '@hale/db';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type LinqChatPage, LinqSendError, listLinqChatsPage } from '~/lib/channel/linq/transport';
import {
  type CapacityLatchStore,
  type CapacityThreshold,
  LINQ_CHAT_ID_LIMIT,
  LINQ_CHATS_MAX_PAGES,
  LINQ_CHATS_PAGE_LIMIT,
  type LinqCapacityDeps,
  type LinqChatCount,
  type LinqCountResult,
  checkLinqCapacity,
  composeCapacityAlert,
  countLinqChats,
  crossingThreshold,
} from './linq-capacity';

const database = {} as Database;
const NOW = new Date('2030-03-04T12:00:00Z');

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function count(total: number, groups = 0): LinqChatCount {
  return {
    total,
    direct: total - groups,
    groups,
    byService: { iMessage: total, SMS: 0, RCS: 0, other: 0 },
    pages: 1,
  };
}

function memoryLatches(): CapacityLatchStore & {
  rows: Map<CapacityThreshold, 'claimed' | 'paged'>;
} {
  const rows = new Map<CapacityThreshold, 'claimed' | 'paged'>();
  return {
    rows,
    latched: async () => new Set(rows.keys()),
    claim: async (t) => {
      if (rows.has(t)) return false;
      rows.set(t, 'claimed');
      return true;
    },
    confirm: async (t) => {
      rows.set(t, 'paged');
    },
    release: async (t) => {
      rows.delete(t);
    },
  };
}

/** A tick driver: each call runs one cron tick at the given Linq total. */
function harness(opts: { sendAlert?: LinqCapacityDeps['sendAlert'] } = {}) {
  const latches = memoryLatches();
  const posts: string[] = [];
  const sendAlert = vi.fn(
    opts.sendAlert ??
      (async (body: string) => {
        posts.push(body);
        return 'sent' as const;
      }),
  );
  const countDb = vi.fn(async () => 0);
  const tick = (total: number) =>
    checkLinqCapacity(
      database,
      {
        countApi: async () => ({ status: 'ok', count: count(total) }),
        countDb,
        latches,
        sendAlert,
      },
      NOW,
    );
  return { latches, posts, sendAlert, countDb, tick };
}

describe('crossing thresholds', () => {
  it('are 70% and 90% of the 200 chat-ID limit', () => {
    expect(LINQ_CHAT_ID_LIMIT).toBe(200);
    expect(crossingThreshold('pct70')).toBe(140);
    expect(crossingThreshold('pct90')).toBe(180);
  });
});

describe('checkLinqCapacity — once per upward crossing', () => {
  it('U1: pages at exactly 140 and exactly 180, and nowhere else', async () => {
    const h = harness();

    await expect(h.tick(139)).resolves.toEqual({ outcome: 'below', total: 139, rearmed: [] });
    expect(h.posts).toHaveLength(0);

    await expect(h.tick(140)).resolves.toEqual({
      outcome: 'alerted',
      threshold: 'pct70',
      total: 140,
      source: 'linq',
    });
    expect(h.posts).toHaveLength(1);
    expect(h.posts[0]).toContain('70%');

    await expect(h.tick(141)).resolves.toEqual({ outcome: 'latched', total: 141 });
    await expect(h.tick(179)).resolves.toEqual({ outcome: 'latched', total: 179 });
    expect(h.posts).toHaveLength(1);

    await expect(h.tick(180)).resolves.toEqual({
      outcome: 'alerted',
      threshold: 'pct90',
      total: 180,
      source: 'linq',
    });
    expect(h.posts).toHaveLength(2);
    expect(h.posts[1]).toContain('90%');
    expect([...h.latches.rows.entries()]).toEqual([
      ['pct70', 'paged'],
      ['pct90', 'paged'],
    ]);
  });

  it('U2: a jump over both thresholds is one page naming 90%, both latched', async () => {
    const h = harness();
    await h.tick(139);

    await expect(h.tick(181)).resolves.toEqual({
      outcome: 'alerted',
      threshold: 'pct90',
      total: 181,
      source: 'linq',
    });

    expect(h.posts).toHaveLength(1);
    expect(h.posts[0]).toContain('90%');
    expect(h.posts[0]).not.toContain('70%');
    expect(h.latches.rows.get('pct70')).toBe('paged');
    expect(h.latches.rows.get('pct90')).toBe('paged');
  });

  it('U3: re-arms 70% strictly below 130 and pages again on the next crossing', async () => {
    const h = harness();
    await h.tick(140);

    await expect(h.tick(130)).resolves.toEqual({ outcome: 'latched', total: 130 });
    expect(h.latches.rows.has('pct70')).toBe(true);

    await expect(h.tick(129)).resolves.toEqual({
      outcome: 'below',
      total: 129,
      rearmed: ['pct70'],
    });
    expect(h.latches.rows.has('pct70')).toBe(false);
    expect(h.posts).toHaveLength(1);

    await expect(h.tick(140)).resolves.toMatchObject({ outcome: 'alerted', threshold: 'pct70' });
    expect(h.posts).toHaveLength(2);
  });

  it('U3: re-arms 90% strictly below 170 while 70% stays latched', async () => {
    const h = harness();
    await h.tick(180);

    await expect(h.tick(170)).resolves.toEqual({ outcome: 'latched', total: 170 });
    expect(h.latches.rows.has('pct90')).toBe(true);

    await expect(h.tick(169)).resolves.toEqual({ outcome: 'latched', total: 169 });
    expect(h.latches.rows.has('pct90')).toBe(false);
    expect(h.latches.rows.get('pct70')).toBe('paged');

    await expect(h.tick(180)).resolves.toMatchObject({ outcome: 'alerted', threshold: 'pct90' });
    expect(h.posts).toHaveLength(2);
  });

  it('U4: a failed post releases the claim and the next tick posts exactly once', async () => {
    const outcomes: Array<'failed' | 'sent'> = ['failed', 'sent'];
    const h = harness({ sendAlert: async () => outcomes.shift() ?? 'sent' });

    await expect(h.tick(140)).resolves.toEqual({
      outcome: 'alert_send_failed',
      threshold: 'pct70',
    });
    expect(h.latches.rows.size).toBe(0);

    await expect(h.tick(140)).resolves.toMatchObject({ outcome: 'alerted', threshold: 'pct70' });
    await expect(h.tick(140)).resolves.toEqual({ outcome: 'latched', total: 140 });
    expect(h.sendAlert).toHaveBeenCalledTimes(2);
  });

  it('an unset webhook is a named skip and leaves the threshold armed', async () => {
    const h = harness({ sendAlert: async () => 'skipped_not_configured' });

    await expect(h.tick(150)).resolves.toEqual({
      outcome: 'skipped_not_configured',
      threshold: 'pct70',
    });
    expect(h.latches.rows.size).toBe(0);
  });

  it('a claim store that throws withholds the page', async () => {
    const h = harness();
    h.latches.claim = async () => {
      throw new Error('db down');
    };
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(h.tick(150)).resolves.toEqual({ outcome: 'claim_unavailable' });
    expect(h.sendAlert).not.toHaveBeenCalled();
  });
});

describe('checkLinqCapacity — DB fallback when Linq cannot answer', () => {
  const unreachable: LinqCountResult = { status: 'unreachable', reason: 'timeout' };

  it('U5: Linq unreachable with the DB at 145 pages once, from the DB', async () => {
    const latches = memoryLatches();
    const posts: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const outcome = await checkLinqCapacity(
      database,
      {
        countApi: async () => unreachable,
        countDb: async () => 145,
        latches,
        sendAlert: async (body) => {
          posts.push(body);
          return 'sent';
        },
      },
      NOW,
    );

    expect(outcome).toEqual({ outcome: 'alerted', threshold: 'pct70', total: 145, source: 'db' });
    expect(posts).toEqual([
      'Hale: Linq count unavailable (timeout); DB sees 145 of 200 chat IDs (undercounts parents mid-intake and erased families). Runbook: docs/linq-chat-capacity.md',
    ]);
  });

  it('U5: the DB never re-arms a latched threshold', async () => {
    const latches = memoryLatches();
    latches.rows.set('pct70', 'paged');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sendAlert = vi.fn(async () => 'sent' as const);

    const outcome = await checkLinqCapacity(
      database,
      { countApi: async () => unreachable, countDb: async () => 100, latches, sendAlert },
      NOW,
    );

    expect(outcome).toEqual({ outcome: 'linq_unavailable', reason: 'unreachable', db: 100 });
    expect(latches.rows.get('pct70')).toBe('paged');
    expect(sendAlert).not.toHaveBeenCalled();
  });

  it('U5: the DB is not read when Linq answers', async () => {
    const h = harness();
    await h.tick(100);
    await h.tick(150);
    expect(h.countDb).not.toHaveBeenCalled();
  });
});

describe('composeCapacityAlert', () => {
  it('states the threshold, the count and the split, in ASCII', () => {
    const body = composeCapacityAlert({
      source: 'linq',
      threshold: 'pct70',
      count: count(141, 13),
    });
    expect(body).toBe(
      'Hale: Linq chat IDs at 70% - 141 of 200 (1:1 128, groups 13). Runbook: docs/linq-chat-capacity.md',
    );
    expect(body).toMatch(/^[\x20-\x7e]+$/);
  });
});

describe('U6 — counts only, never an id, a handle or the key', () => {
  it('keeps every chat id, handle and key fragment out of the outcome, page and logs', async () => {
    const key = 'linq_test_key_fragment_x9q';
    vi.stubEnv('LINQ_API_KEY', key);
    const handles: string[] = [];
    const ids: string[] = [];
    const chats = Array.from({ length: 141 }, (_, i) => {
      const id = `0e5c1a2b-7d3f-4c9a-8b1e-${String(i).padStart(12, '0')}`;
      const handle = `+447700900${String(i).padStart(3, '0')}`;
      ids.push(id);
      handles.push(handle);
      return {
        id,
        is_group: i % 10 === 0,
        service: 'iMessage',
        display_name: `Example Parent ${i}`,
        handles: [{ handle, is_me: false }],
      };
    });
    const raw = { chats, next_cursor: null };
    const fakeFetch = vi.fn(async () => Response.json(raw, { status: 200 }));

    // Positive control: the raw payload really carries what must not leak.
    expect(JSON.stringify(raw)).toContain(handles[7]);
    expect(JSON.stringify(raw)).toContain(ids[7]);

    const logged: unknown[] = [];
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logged.push(args);
      });
    }
    const posts: string[] = [];
    const outcome = await checkLinqCapacity(
      database,
      {
        countApi: () =>
          countLinqChats({
            listPage: (input) => listLinqChatsPage({ ...input, fetch: fakeFetch }),
          }),
        countDb: async () => 0,
        latches: memoryLatches(),
        sendAlert: async (body) => {
          posts.push(body);
          return 'sent';
        },
      },
      NOW,
    );

    expect(outcome).toEqual({ outcome: 'alerted', threshold: 'pct70', total: 141, source: 'linq' });
    expect(posts).toHaveLength(1);
    const surfaces = [JSON.stringify(outcome), ...posts, JSON.stringify(logged)];
    for (const surface of surfaces) {
      for (const handle of handles) expect(surface).not.toContain(handle.slice(1));
      for (const id of ids) expect(surface).not.toContain(id);
      expect(surface).not.toContain('Example Parent');
      expect(surface).not.toContain(key.slice(-8));
    }
  });
});

describe('U7 — the guard reaches Linq only through transport.ts and gates no send', () => {
  const sources = [
    ['linq-capacity.ts', new URL('./linq-capacity.ts', import.meta.url)],
    ['probe-linq-capacity.ts', new URL('../../scripts/probe-linq-capacity.ts', import.meta.url)],
  ] as const;

  for (const [name, url] of sources) {
    it(`${name} imports no send path and names no provider door`, () => {
      const source = readFileSync(fileURLToPath(url), 'utf8');
      for (const forbidden of [
        'outbound-gate',
        'family-outbound',
        'outbound-transport',
        'api.linqapp.com',
        'createTwilioTransport',
        'sendLinq',
        'createLinq',
        'reactToLinq',
        'shareLinq',
        'requestLinq',
        'retrieveLinq',
      ]) {
        expect(source).not.toContain(forbidden);
      }
      expect(source).toContain('listLinqChatsPage');
    });
  }
});

describe('countLinqChats — pagination', () => {
  function chat(
    id: string,
    isGroup = false,
    service: LinqChatPage['chats'][number]['service'] = 'iMessage',
  ) {
    return { id, isGroup, service };
  }

  function pagesFake(pages: LinqChatPage[]) {
    const queue = [...pages];
    return vi.fn(async (_input: { limit: number; cursor?: string }) => {
      const next = queue.shift();
      if (!next) throw new Error('fake ran out of pages');
      return next;
    });
  }

  it('counts 100/100/37 across three pages with the group and service split', async () => {
    const services = ['iMessage', 'SMS', 'RCS', 'other'] as const;
    const all = Array.from({ length: 237 }, (_, i) => chat(`c${i}`, i < 13, services[i % 4]));
    const listPage = pagesFake([
      { chats: all.slice(0, 100), nextCursor: 'p2' },
      { chats: all.slice(100, 200), nextCursor: 'p3' },
      { chats: all.slice(200), nextCursor: null },
    ]);

    const result = await countLinqChats({ listPage });

    expect(result).toEqual({
      status: 'ok',
      count: {
        total: 237,
        direct: 224,
        groups: 13,
        byService: { iMessage: 60, SMS: 59, RCS: 59, other: 59 },
        pages: 3,
      },
    });
    expect(listPage.mock.calls.map(([input]) => input)).toEqual([
      { limit: LINQ_CHATS_PAGE_LIMIT },
      { limit: LINQ_CHATS_PAGE_LIMIT, cursor: 'p2' },
      { limit: LINQ_CHATS_PAGE_LIMIT, cursor: 'p3' },
    ]);
    expect(LINQ_CHATS_PAGE_LIMIT).toBe(100);
  });

  it('counts an id seen on two pages once', async () => {
    const listPage = pagesFake([
      { chats: [chat('a'), chat('b', true)], nextCursor: 'p2' },
      { chats: [chat('b', true), chat('c')], nextCursor: null },
    ]);
    await expect(countLinqChats({ listPage })).resolves.toMatchObject({
      status: 'ok',
      count: { total: 3, direct: 2, groups: 1, pages: 2 },
    });
  });

  it('follows an empty page that still carries a cursor', async () => {
    const listPage = pagesFake([
      { chats: [chat('a')], nextCursor: 'c2' },
      { chats: [], nextCursor: 'c3' },
      { chats: [chat('b')], nextCursor: null },
    ]);
    await expect(countLinqChats({ listPage })).resolves.toMatchObject({
      status: 'ok',
      count: { total: 2, pages: 3 },
    });
  });

  it('names a repeated cursor as a loop', async () => {
    const listPage = pagesFake([
      { chats: [chat('a')], nextCursor: 'c2' },
      { chats: [chat('b')], nextCursor: 'c3' },
      { chats: [chat('c')], nextCursor: 'c2' },
    ]);
    await expect(countLinqChats({ listPage })).resolves.toEqual({ status: 'cursor_loop' });
  });

  it('stops at the page bound on 21 distinct cursors', async () => {
    let n = 0;
    const listPage = vi.fn(async () => {
      n += 1;
      return { chats: [chat(`x${n}`)], nextCursor: `c${n}` };
    });
    await expect(countLinqChats({ listPage })).resolves.toEqual({
      status: 'page_bound_exceeded',
      seen: LINQ_CHATS_MAX_PAGES,
    });
    expect(listPage).toHaveBeenCalledTimes(LINQ_CHATS_MAX_PAGES);
    expect(LINQ_CHATS_MAX_PAGES).toBe(20);
  });

  it('names refusals, outages, a missing key and a malformed page', async () => {
    const throwing = (err: Error) => vi.fn(async () => Promise.reject(err));

    await expect(
      countLinqChats({ listPage: throwing(new LinqSendError('1003', 403, true)) }),
    ).resolves.toEqual({ status: 'refused', code: '1003', httpStatus: 403, permanent: true });
    await expect(
      countLinqChats({ listPage: throwing(new LinqSendError('http_429', 429, false)) }),
    ).resolves.toEqual({ status: 'refused', code: 'http_429', httpStatus: 429, permanent: false });
    await expect(
      countLinqChats({ listPage: throwing(new LinqSendError('3006', 500, false)) }),
    ).resolves.toEqual({ status: 'refused', code: '3006', httpStatus: 500, permanent: false });
    await expect(
      countLinqChats({ listPage: throwing(new LinqSendError('timeout', 0, false)) }),
    ).resolves.toEqual({ status: 'unreachable', reason: 'timeout' });
    await expect(
      countLinqChats({ listPage: throwing(new LinqSendError('network', 0, false)) }),
    ).resolves.toEqual({ status: 'unreachable', reason: 'network' });
    await expect(
      countLinqChats({ listPage: throwing(new LinqSendError('not_configured', 0, true)) }),
    ).resolves.toEqual({ status: 'not_configured' });
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    await expect(
      countLinqChats({
        listPage: (input) =>
          listLinqChatsPage({
            ...input,
            fetch: vi.fn(async () => Response.json({ chats: 'x' }, { status: 200 })),
          }),
      }),
    ).resolves.toEqual({ status: 'malformed' });
  });

  it('lets a non-Linq error through', async () => {
    const listPage = vi.fn(async () => Promise.reject(new TypeError('bug')));
    await expect(countLinqChats({ listPage })).rejects.toThrow(TypeError);
  });
});
