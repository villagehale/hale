import { EventEmitter } from 'node:events';
import type { RequestOptions } from 'node:https';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_PAGE_BYTES } from './fetch';
import {
  RegistrationPageRedirect,
  createRegistrationPageBytesFetch,
  createRegistrationPageFetch,
} from './page';

const network = vi.hoisted(() => ({ request: vi.fn(), lookup: vi.fn() }));
vi.mock('node:https', () => ({ request: network.request }));
vi.mock('node:dns/promises', () => ({ lookup: network.lookup }));
let options: RequestOptions;
let respond: (response: EventEmitter) => void;
let req: EventEmitter & { end: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> };
beforeEach(() => {
  vi.useFakeTimers();
  req = Object.assign(new EventEmitter(), {
    end: vi.fn(),
    destroy: vi.fn((error: Error) => req.emit('error', error)),
  });
  network.request.mockImplementation(
    (_url: string, input: RequestOptions, callback: typeof respond) => {
      options = input;
      respond = callback;
      return req;
    },
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});
function response(status = 200, length?: string) {
  const res = Object.assign(new EventEmitter(), {
    statusCode: status,
    headers: { 'content-length': length },
    destroy: vi.fn(),
  });
  res.destroy.mockImplementation((error?: Error) => {
    if (error) res.emit('error', error);
  });
  return res;
}

describe('registration HTTPS fetch wiring', () => {
  it('exposes a validated redirect target but does not follow it automatically', async () => {
    const pending = createRegistrationPageFetch()('https://example.org/old');
    const res = response(301);
    Object.assign(res.headers, { location: '/current?program=kids' });
    respond(res);
    await expect(pending).rejects.toMatchObject({
      location: 'https://example.org/current?program=kids',
    });
    expect(network.request).toHaveBeenCalledTimes(1);
    expect(RegistrationPageRedirect.prototype).toBeInstanceOf(Error);
  });
  it('preserves non-UTF-8 PDF bytes for the registration reader', async () => {
    const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0xff, 0x80, 0x00]);
    const pending = createRegistrationPageBytesFetch()('https://example.org/download/123');
    const res = response();
    respond(res);
    res.emit('data', bytes.subarray(0, 4));
    res.emit('data', bytes.subarray(4));
    res.emit('end');
    req.emit('close');
    expect(await pending).toEqual(bytes);
  });
  it('validates all DNS answers inside the socket lookup and pins a public address', async () => {
    network.lookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
    const pending = createRegistrationPageFetch()('https://example.org/course');
    const callback = vi.fn();
    options.lookup!('example.org', {}, callback);
    await Promise.resolve();
    expect(network.lookup).toHaveBeenCalledWith('example.org', { all: true });
    expect(callback).toHaveBeenCalledWith(null, '8.8.8.8', 4);
    expect(options).toMatchObject({ agent: false, autoSelectFamily: false });
    const res = response();
    respond(res);
    res.emit('data', Buffer.from('page'));
    res.emit('end');
    req.emit('close');
    expect(await pending).toBe('page');
  });
  it('rejects a mixed public/private DNS answer rather than choosing the public address', async () => {
    network.lookup.mockResolvedValue([
      { address: '8.8.8.8', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ]);
    const pending = createRegistrationPageFetch()('https://example.org/course');
    const callback = vi.fn((error: Error | null) => {
      if (error) req.emit('error', error);
    });
    const rejected = expect(pending).rejects.toThrow('non-public DNS');
    options.lookup!('example.org', {}, callback);
    await rejected;
  });
  it.each([302, 404])('refuses HTTP %s without following redirects', async (status) => {
    const pending = createRegistrationPageFetch()('https://example.org/course');
    respond(response(status));
    await expect(pending).rejects.toThrow('status or size refusal');
    expect(network.request).toHaveBeenCalledTimes(1);
  });
  it('rejects the declared size before buffering and enforces the actual streaming size', async () => {
    const declared = createRegistrationPageFetch()('https://example.org/course');
    respond(response(200, String(MAX_PAGE_BYTES + 1)));
    await expect(declared).rejects.toThrow('size refusal');
    const pending = createRegistrationPageFetch()('https://example.org/course');
    const res = response();
    res.destroy.mockImplementation((error?: Error) => {
      res.emit('error', error);
    });
    respond(res);
    res.emit('data', Buffer.alloc(MAX_PAGE_BYTES + 1));
    await expect(pending).rejects.toThrow('size refusal');
  });
  it('aborts a stalled request at its wall-clock budget', async () => {
    const pending = createRegistrationPageFetch(100)('https://example.org/course');
    const rejected = expect(pending).rejects.toThrow('timeout');
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
  });
});
