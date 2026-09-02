import type { Database } from '@hale/db';
import { describe, expect, it, vi } from 'vitest';
import type { DeepSlot } from './deep';
import {
  type ActivitySharePorts,
  mintActivitySharePage,
  shareSummary,
  withSharePage,
} from './share-page';

const database = {} as Database;

function slot(overrides: Partial<DeepSlot> = {}): DeepSlot {
  return {
    name: 'Tiny Gym, Cartwheels Gym Centre',
    ageFit: 'walking to 3.5 years',
    when: 'Sundays 9:30-10:15, Sept 14 to Oct 26',
    price: '$124 per term',
    registration: 'Registration open since July 22',
    sourceName: 'Cartwheels Gym Centre',
    sourceUrl: 'https://cartwheelsgymcentre.com/programs.php',
    source: 'web',
    ...overrides,
  };
}

function ports(overrides: Partial<ActivitySharePorts> = {}): {
  ports: ActivitySharePorts;
  written: Record<string, unknown>[];
  audited: Record<string, unknown>[];
} {
  const written: Record<string, unknown>[] = [];
  const audited: Record<string, unknown>[] = [];
  return {
    written,
    audited,
    ports: {
      writeCandidate: async (_db, row) => {
        written.push(row);
        return 'candidate-1';
      },
      audit: async (_db, row) => {
        audited.push(row);
      },
      ...overrides,
    },
  };
}

describe('shareSummary', () => {
  it('renders a slot as one line carrying the day, the price and the registration fact', () => {
    expect(shareSummary([slot()]).summary).toBe(
      'Tiny Gym, Cartwheels Gym Centre - Sundays 9:30-10:15, Sept 14 to Oct 26 - $124 per term - Registration open since July 22',
    );
  });

  it('leaves out what no page published rather than writing a placeholder', () => {
    const line = shareSummary([slot({ price: null, registration: null })]).summary;

    expect(line).toBe('Tiny Gym, Cartwheels Gym Centre - Sundays 9:30-10:15, Sept 14 to Oct 26');
    expect(line).not.toContain('null');
    expect(line).not.toContain('undefined');
  });

  it('drops a whole slot rather than publishing half a price', () => {
    // The public card truncates a summary at 600 characters. A cut landing inside
    // "$124 per te" is a wrong price on a public page, so assembly stops at whole rows.
    const many = Array.from({ length: 12 }, (_, i) => slot({ name: `Class number ${i}` }));

    const { summary, carried } = shareSummary(many);

    expect(summary.length).toBeLessThanOrEqual(600);
    expect(carried).toBeLessThan(12);
    expect(carried).toBeGreaterThan(0);
    // Every line that made it is whole.
    for (const line of summary.split('\n')) {
      expect(line).toContain('Registration open since July 22');
    }
  });
});

describe('mintActivitySharePage', () => {
  it('writes a family-wide candidate with a token and returns the /a/ link', async () => {
    const harness = ports();

    const page = await mintActivitySharePage(
      database,
      { familyId: 'fam-1', slots: [slot(), slot({ name: 'Mini Gym' })] },
      harness.ports,
    );

    expect(page.status).toBe('minted');
    if (page.status !== 'minted') throw new Error('expected minted');
    expect(page.url).toMatch(/^https:\/\/[^/]+\/a\/[A-Za-z0-9_-]{20,}$/);
    expect(page.slots).toBe(2);

    const row = harness.written[0];
    expect(row?.familyId).toBe('fam-1');
    expect(row?.title).toBe('Cartwheels Gym Centre');
    expect(row?.sourceUrl).toBe('https://cartwheelsgymcentre.com/programs.php');
    expect(String(row?.summary)).toContain('Mini Gym');
    // The token in the URL is the token that was written — the page resolves.
    expect(page.url.endsWith(String(row?.shareToken))).toBe(true);
  });

  it('audits the mint with a COUNT and never the venue names (rule #1/#6)', async () => {
    const harness = ports();

    await mintActivitySharePage(database, { familyId: 'fam-1', slots: [slot()] }, harness.ports);

    const audit = harness.audited[0];
    expect(audit?.actionTaken).toBe('activity_followup_shared');
    expect(audit?.after).toEqual({ slots: 1 });
    expect(JSON.stringify(audit)).not.toContain('Cartwheels');
  });

  it('mints a fresh token every time, so two families never share a page', async () => {
    const harness = ports();

    const a = await mintActivitySharePage(
      database,
      { familyId: 'f1', slots: [slot()] },
      harness.ports,
    );
    const b = await mintActivitySharePage(
      database,
      { familyId: 'f2', slots: [slot()] },
      harness.ports,
    );

    expect(a.status === 'minted' && b.status === 'minted' && a.url !== b.url).toBe(true);
  });

  it('skips with a named reason when there is nothing to put on a page', async () => {
    const harness = ports();

    await expect(
      mintActivitySharePage(database, { familyId: 'fam-1', slots: [] }, harness.ports),
    ).resolves.toEqual({ status: 'skipped', reason: 'nothing_to_share' });
    expect(harness.written).toEqual([]);
  });

  it('a failed write skips the link instead of taking the follow-up down', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const harness = ports({
      writeCandidate: async () => {
        throw new Error('insert failed');
      },
    });

    const page = await mintActivitySharePage(
      database,
      { familyId: 'fam-1', slots: [slot()] },
      harness.ports,
    );

    expect(page).toEqual({ status: 'skipped', reason: 'write_failed' });
    expect(spy).toHaveBeenCalled();
    expect(harness.audited).toEqual([]);
    spy.mockRestore();
  });
});

describe('withSharePage', () => {
  it('appends the link on its own line, leaving the composed sentence untouched', () => {
    expect(withSharePage('Their site says Sundays 9:30.', 'https://app.example/a/tok')).toBe(
      'Their site says Sundays 9:30.\nThe rest: https://app.example/a/tok',
    );
  });
});
