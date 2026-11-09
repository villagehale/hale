import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { AgentClient } from '@hale/agent';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registrationWindowFixture } from '~/lib/testing/registration-source';
import { createLiveRegistrationReader, windowReadTarget } from './read';

const dns = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: dns.lookup }));

const NOW = new Date('2026-10-10T12:00:00Z');
const APP_ROOT = join(__dirname, '..', '..');

/** A client that fails the test if the reader ever reaches the model. */
function unreachableClient(): { client: AgentClient; create: ReturnType<typeof vi.fn> } {
  const create = vi.fn(async () => {
    throw new Error('the model must not be called for a page that was never fetched');
  });
  return { client: { messages: { create } } as unknown as AgentClient, create };
}

function productionSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return productionSources(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  dns.lookup.mockReset();
});

describe('the production registration reader', () => {
  it('fetches through the DNS-pinned fetcher, so a public name that resolves privately is never read', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    dns.lookup.mockResolvedValue([{ address: '10.0.0.5', family: 4 }]);
    const { client, create } = unreachableClient();
    const target = windowReadTarget(
      registrationWindowFixture({ sourceUrl: 'https://registration.example.org/fall' }),
    );

    const reading = await createLiveRegistrationReader(client)(target, NOW);

    expect(reading).toMatchObject({ status: 'unreadable', reason: 'non_public_address' });
    expect(dns.lookup).toHaveBeenCalledWith('registration.example.org', { all: true });
    expect(create).not.toHaveBeenCalled();
  });

  it('is the only way production code builds a reader', () => {
    const builders = productionSources(APP_ROOT)
      .filter((path) => readFileSync(path, 'utf8').includes('createRegistrationReader('))
      .map((path) => relative(APP_ROOT, path));
    // Positive control: the scan reaches read.ts, where the builder itself calls it.
    expect(builders).toEqual(['lib/registration/read.ts']);
  });
});
