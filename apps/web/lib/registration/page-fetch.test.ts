import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import type { RequestOptions } from 'node:https';
import type { AddressInfo } from 'node:net';
import {
  type MockInstance,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { MAX_PAGE_BYTES } from './fetch';
import {
  REGISTRATION_PAGE_USER_AGENT,
  type RegistrationPageFetch,
  createRegistrationPageBytesFetch,
} from './page';

const network = vi.hoisted(() => ({ request: vi.fn(), lookup: vi.fn() }));
vi.mock('node:https', () => ({ request: network.request }));
vi.mock('node:dns/promises', () => ({ lookup: network.lookup }));

type FakeRequest = EventEmitter & {
  end: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
};
type Opened = {
  options: RequestOptions;
  respond: (response: EventEmitter) => void;
  req: FakeRequest;
};
let opened: Opened[];
let info: MockInstance<typeof console.info>;
const latest = () => opened[opened.length - 1]!;

let nodeFetchUserAgent: string | undefined;
beforeAll(async () => {
  vi.useRealTimers();
  const server = createServer((req, res) => {
    nodeFetchUserAgent = req.headers['user-agent'];
    res.end('ok');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await (await fetch(`http://127.0.0.1:${port}/`)).text();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  vi.useFakeTimers();
  opened = [];
  info = vi.spyOn(console, 'info').mockImplementation(() => {});
  network.request.mockImplementation(
    (_url: string, options: RequestOptions, respond: Opened['respond']) => {
      const req: FakeRequest = Object.assign(new EventEmitter(), {
        end: vi.fn(),
        destroy: vi.fn((error?: Error) => {
          if (error) req.emit('error', error);
        }),
      });
      opened.push({ options, respond, req });
      return req;
    },
  );
});

// Host slots are module state: a fetch that never released its slot fails here, at the test
// that leaked it, because two fresh same-host fetches must both reach the network.
afterEach(async () => {
  const before = network.request.mock.calls.length;
  const fetchPage = createRegistrationPageBytesFetch();
  const probes = [
    fetchPage('https://example.org/slot-check'),
    fetchPage('https://example.org/slot-check'),
  ];
  expect(network.request).toHaveBeenCalledTimes(before + 2);
  for (const { respond } of opened.slice(-2)) respond(response(404));
  await Promise.all(probes);
  info.mockRestore();
  vi.useRealTimers();
  vi.clearAllMocks();
});

function response(status = 200, headers: Record<string, string> = {}) {
  return Object.assign(new EventEmitter(), { statusCode: status, headers, destroy: vi.fn() });
}

describe('registration HTTPS fetch wiring', () => {
  it('exposes a validated redirect target but does not follow it automatically', async () => {
    const pending = createRegistrationPageBytesFetch()('https://example.org/old');
    latest().respond(response(301, { location: '/current?program=kids' }));
    await expect(pending).resolves.toEqual({
      outcome: 'redirected',
      location: 'https://example.org/current?program=kids',
    });
    expect(network.request).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['https://127.0.0.1/admin', 'non_public_host'],
    ['https://example.org/login?ticket=ST-1', 'ambiguous_query_key'],
    ['http://example.org/x', 'not_https'],
    ['https://example.org/sso?token=a', 'credential_link'],
    ['http://[', 'malformed_url'],
  ])(
    'names a redirect to %s refused as %s and never exposes the target',
    async (location, target) => {
      const pending = createRegistrationPageBytesFetch()('https://example.org/old');
      latest().respond(response(302, { location }));
      await expect(pending).resolves.toEqual({
        outcome: 'refused',
        reason: 'redirect_refused',
        target,
      });
      expect(await pending).not.toHaveProperty('location');
      expect(network.request).toHaveBeenCalledTimes(1);
    },
  );

  it('sends exactly the headers Node’s own fetch sends, so a city site sees one client', async () => {
    expect(nodeFetchUserAgent).toEqual(expect.any(String));
    const pending = createRegistrationPageBytesFetch()('https://example.org/course');
    expect(latest().options.headers).toEqual({
      Accept: 'text/html,application/xhtml+xml',
      'User-Agent': nodeFetchUserAgent,
    });
    expect(REGISTRATION_PAGE_USER_AGENT).toBe(nodeFetchUserAgent);
    latest().respond(response(404));
    await pending;
  });

  it('preserves non-UTF-8 PDF bytes for the registration reader', async () => {
    const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0xff, 0x80, 0x00]);
    const pending = createRegistrationPageBytesFetch()('https://example.org/download/123');
    const res = response();
    latest().respond(res);
    res.emit('data', bytes.subarray(0, 4));
    res.emit('data', bytes.subarray(4));
    res.emit('end');
    await expect(pending).resolves.toEqual({ outcome: 'fetched', body: bytes });
  });

  it('validates all DNS answers inside the socket lookup and pins a public address', async () => {
    network.lookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
    const pending = createRegistrationPageBytesFetch()('https://example.org/course');
    const callback = vi.fn();
    latest().options.lookup!('example.org', {}, callback);
    await Promise.resolve();
    expect(network.lookup).toHaveBeenCalledWith('example.org', { all: true });
    expect(callback).toHaveBeenCalledWith(null, '8.8.8.8', 4);
    expect(latest().options).toMatchObject({ agent: false, autoSelectFamily: false });
    const res = response();
    latest().respond(res);
    res.emit('data', Buffer.from('page'));
    res.emit('end');
    await expect(pending).resolves.toEqual({ outcome: 'fetched', body: Buffer.from('page') });
  });

  it('names a mixed public/private DNS answer rather than choosing the public address', async () => {
    network.lookup.mockResolvedValue([
      { address: '8.8.8.8', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ]);
    const pending = createRegistrationPageBytesFetch()('https://example.org/course');
    const { options, req } = latest();
    options.lookup!('example.org', {}, (error: Error | null) => {
      if (error) req.emit('error', error);
    });
    await expect(pending).resolves.toEqual({ outcome: 'refused', reason: 'non_public_address' });
  });

  it('names a lookup that fails a network error, not an unsafe address', async () => {
    network.lookup.mockRejectedValue(
      Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }),
    );
    const pending = createRegistrationPageBytesFetch()('https://example.org/course');
    const { options, req } = latest();
    options.lookup!('example.org', {}, (error: Error | null) => {
      if (error) req.emit('error', error);
    });
    await expect(pending).resolves.toEqual({ outcome: 'failed', reason: 'network_error' });
  });

  it.each([302, 404])('names HTTP %s by its status without following redirects', async (status) => {
    const pending = createRegistrationPageBytesFetch()('https://example.org/course');
    latest().respond(response(status));
    await expect(pending).resolves.toEqual({ outcome: 'refused', reason: 'http_status', status });
    expect(network.request).toHaveBeenCalledTimes(1);
  });

  it('refuses the declared size before buffering and enforces the actual streaming size', async () => {
    const fetchPage = createRegistrationPageBytesFetch();
    const declared = fetchPage('https://example.org/course');
    latest().respond(response(200, { 'content-length': String(MAX_PAGE_BYTES + 1) }));
    await expect(declared).resolves.toEqual({ outcome: 'refused', reason: 'too_large' });

    const streamed = fetchPage('https://example.org/course');
    const big = response();
    latest().respond(big);
    big.emit('data', Buffer.alloc(MAX_PAGE_BYTES + 1));
    await expect(streamed).resolves.toEqual({ outcome: 'refused', reason: 'too_large' });

    const atLimit = fetchPage('https://example.org/course');
    const full = response();
    latest().respond(full);
    full.emit('data', Buffer.alloc(MAX_PAGE_BYTES));
    full.emit('end');
    const result = await atLimit;
    expect(result.outcome).toBe('fetched');
    expect(result.outcome === 'fetched' && result.body.length).toBe(MAX_PAGE_BYTES);
  });

  it('names a stalled request a timeout at its wall-clock budget', async () => {
    const pending = createRegistrationPageBytesFetch(100)('https://example.org/course');
    await vi.advanceTimersByTimeAsync(100);
    await expect(pending).resolves.toEqual({ outcome: 'failed', reason: 'timeout' });
  });
});

describe('per-host bound on concurrent fetches (instance protection, not a send rule)', () => {
  it('lets two fetches run per host and names a third busy without opening a socket', async () => {
    const fetchPage = createRegistrationPageBytesFetch();
    const started: Promise<RegistrationPageFetch>[] = [];
    try {
      started.push(fetchPage('https://example.org/a'), fetchPage('https://example.org/a'));
      await expect(fetchPage('https://example.org/a')).resolves.toEqual({
        outcome: 'busy',
        reason: 'host_busy',
      });
      expect(network.request).toHaveBeenCalledTimes(2);

      await expect(fetchPage('https://example.org/sso?token=a')).resolves.toEqual({
        outcome: 'refused',
        reason: 'credential_link',
      });
      started.push(fetchPage('https://example.net/a'));
      expect(network.request).toHaveBeenCalledTimes(3);

      opened[0]!.respond(response(404));
      await started[0];
      started.push(fetchPage('https://example.org/b'));
      expect(network.request).toHaveBeenCalledTimes(4);
    } finally {
      for (const { respond } of opened) respond(response(404));
      await Promise.all(started);
    }
  });

  it('counts a trailing-dot or upper-case spelling of a host as the same host', async () => {
    const fetchPage = createRegistrationPageBytesFetch();
    const started: Promise<RegistrationPageFetch>[] = [];
    try {
      started.push(fetchPage('https://example.org/a'), fetchPage('https://example.org/a'));
      await expect(fetchPage('https://EXAMPLE.org./a')).resolves.toEqual({
        outcome: 'busy',
        reason: 'host_busy',
      });
      expect(info).toHaveBeenLastCalledWith(
        { outcome: 'busy', reason: 'host_busy', host: 'example.org' },
        'registration page: not fetched',
      );
      expect(network.request).toHaveBeenCalledTimes(2);
      started.push(fetchPage('https://example.net./a'));
      expect(network.request).toHaveBeenCalledTimes(3);
    } finally {
      for (const { respond } of opened) respond(response(404));
      await Promise.all(started);
    }
  });

  it('releases the host slot after a timeout and after a size refusal', async () => {
    const fetchPage = createRegistrationPageBytesFetch(100);
    const started: Promise<RegistrationPageFetch>[] = [];
    try {
      const timedOut = fetchPage('https://example.org/slow');
      const tooLarge = fetchPage('https://example.org/big');
      opened[1]!.respond(response(200, { 'content-length': String(MAX_PAGE_BYTES + 1) }));
      await vi.advanceTimersByTimeAsync(100);
      await expect(timedOut).resolves.toEqual({ outcome: 'failed', reason: 'timeout' });
      await expect(tooLarge).resolves.toEqual({ outcome: 'refused', reason: 'too_large' });

      started.push(fetchPage('https://example.org/a'), fetchPage('https://example.org/b'));
      expect(network.request).toHaveBeenCalledTimes(4);
    } finally {
      for (const { respond } of opened.slice(2)) respond(response(404));
      await Promise.all(started);
    }
  });
});

describe('outcome logging', () => {
  it('logs a refusal by outcome and host only, never the path or query', async () => {
    const pending = createRegistrationPageBytesFetch()('https://example.org/a/b?program=kids');
    latest().respond(response(404));
    await pending;
    expect(info).toHaveBeenCalledWith(
      { outcome: 'refused', reason: 'http_status', status: 404, host: 'example.org' },
      'registration page: not fetched',
    );
    const logged = JSON.stringify(info.mock.calls);
    expect(logged).toContain('example.org');
    expect(logged).not.toContain('/a/b');
    expect(logged).not.toContain('program=kids');
  });

  it.each([
    ['https://u:pw-canary@example.org/a/b?program=kids#frag', 'credential_link', 'example.org'],
    ['https://example.org/a/b?token=tok-canary#frag', 'credential_link', 'example.org'],
    ['https://example.org/a/b#/cb?password=pw-canary', 'credential_link', 'example.org'],
    ['https://example.org/a/b?session=fall-canary', 'ambiguous_query_key', 'example.org'],
    ['http://example.org/a/b?program=kids', 'not_https', 'example.org'],
    ['https://example.org:8443/a/b', 'nonstandard_port', 'example.org'],
    ['https://localhost/a/b?program=kids', 'non_public_host', 'localhost'],
    ['not a url /a/b', 'malformed_url', null],
  ])(
    'logs a refusal of %s before any fetch as %s and its host, never the URL',
    async (url, reason, host) => {
      await expect(createRegistrationPageBytesFetch()(url)).resolves.toEqual({
        outcome: 'refused',
        reason,
      });
      expect(network.request).not.toHaveBeenCalled();
      expect(info).toHaveBeenCalledTimes(1);
      expect(info).toHaveBeenCalledWith(
        { outcome: 'refused', reason, host },
        'registration page: not fetched',
      );
      const logged = JSON.stringify(info.mock.calls);
      expect(logged).toContain(reason);
      for (const part of ['/a/b', 'canary', 'program', 'frag', 'u:']) {
        expect(logged).not.toContain(part);
      }
    },
  );

  it('logs a busy host by outcome and host only, never the URL', async () => {
    const fetchPage = createRegistrationPageBytesFetch();
    const started = [fetchPage('https://example.org/x'), fetchPage('https://example.org/x')];
    try {
      await expect(fetchPage('https://example.org/a/b?program=kids#frag')).resolves.toEqual({
        outcome: 'busy',
        reason: 'host_busy',
      });
      expect(info).toHaveBeenCalledTimes(1);
      expect(info).toHaveBeenCalledWith(
        { outcome: 'busy', reason: 'host_busy', host: 'example.org' },
        'registration page: not fetched',
      );
      const logged = JSON.stringify(info.mock.calls);
      expect(logged).toContain('example.org');
      for (const part of ['/a/b', 'program', 'frag']) expect(logged).not.toContain(part);
    } finally {
      for (const { respond } of opened) respond(response(404));
      await Promise.all(started);
    }
  });

  it('logs nothing for a fetched page', async () => {
    const fetchPage = createRegistrationPageBytesFetch();
    const fetched = fetchPage('https://example.org/course');
    const res = response();
    latest().respond(res);
    res.emit('data', Buffer.from('page'));
    res.emit('end');
    await fetched;
    expect(info).not.toHaveBeenCalled();

    const missing = fetchPage('https://example.org/gone');
    latest().respond(response(404));
    await missing;
    expect(info).toHaveBeenCalledTimes(1);
  });
});
