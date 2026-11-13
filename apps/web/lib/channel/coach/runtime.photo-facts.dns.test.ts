import type { Database } from '@hale/db';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * VIL-413, production wiring: the coach's media port reads a PDF only on a lit 1:1 turn,
 * and then through the vetted lookup #985 built for a `.vcf` (Devin SEC_0001), so a
 * public-looking name that resolves to a private address is never connected to.
 */
const lookup = vi.fn(async () => [{ address: '10.0.0.5', family: 4 }]);
vi.mock('node:dns/promises', () => ({ lookup, default: { lookup } }));

const { productionChannelCoachPorts } = await import('./runtime');

const PDF = [
  { kind: 'file' as const, url: 'https://cdn.example/form.pdf', mime: 'application/pdf' },
];

afterEach(() => {
  lookup.mockClear();
  vi.unstubAllEnvs();
});

describe('productionChannelCoachPorts · a PDF on this turn (VIL-413)', () => {
  it('dark: the PDF is named and its host is never looked up', async () => {
    const ports = productionChannelCoachPorts({} as Database);
    expect(ports.photoFactsEnabled?.()).toBe(false);
    const read = await ports.readInboundMedia?.(PDF, 'direct');
    expect(read).toMatchObject({ blocks: [], unwatched: [{ kind: 'file' }] });
    expect(lookup).not.toHaveBeenCalled();
  });

  it('lit, a group turn: still not looked up', async () => {
    vi.stubEnv('INBOUND_PHOTO_FACTS_ENABLED', 'true');
    const read = await productionChannelCoachPorts({} as Database).readInboundMedia?.(PDF, 'group');
    expect(read).toMatchObject({ blocks: [], unwatched: [{ kind: 'file' }] });
    expect(lookup).not.toHaveBeenCalled();
  });

  it('lit, a 1:1 turn: fetched through the vetted lookup, which refuses a private answer', async () => {
    vi.stubEnv('INBOUND_PHOTO_FACTS_ENABLED', 'true');
    const ports = productionChannelCoachPorts({} as Database);
    expect(ports.photoFactsEnabled?.()).toBe(true);
    const read = await ports.readInboundMedia?.(PDF, 'direct');
    expect(lookup).toHaveBeenCalledWith('cdn.example', { all: true });
    expect(read).toMatchObject({ blocks: [], unwatched: [{ kind: 'file' }] });
  });
});
