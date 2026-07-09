import { describe, expect, it } from 'vitest';

import { CONNECTORS, type ConnectorProvider, statusChip } from './connectors';

describe('CONNECTORS — the three read-only Google connectors', () => {
  it('lists gcal, gmail, gdrive in a stable order', () => {
    expect(CONNECTORS.map((c) => c.provider)).toEqual<ConnectorProvider[]>([
      'gcal',
      'gmail',
      'gdrive',
    ]);
  });

  it('gives each connector a human name, one-line benefit, and an icon', () => {
    for (const c of CONNECTORS) {
      expect(c.name.length).toBeGreaterThan(0);
      expect(c.benefit.length).toBeGreaterThan(0);
      expect(c.icon).toBeTruthy();
    }
    expect(CONNECTORS.find((c) => c.provider === 'gcal')?.name).toBe('Google Calendar');
    expect(CONNECTORS.find((c) => c.provider === 'gmail')?.name).toBe('Gmail');
    expect(CONNECTORS.find((c) => c.provider === 'gdrive')?.name).toBe('Google Drive');
    expect(CONNECTORS.find((c) => c.provider === 'gcal')?.icon).toBe('calendar');
  });
});

describe('statusChip — honest status labels (never a false green)', () => {
  it("labels a connected account 'Connected' with the done tone", () => {
    expect(statusChip('connected')).toEqual({ label: 'Connected', tone: 'done' });
  });

  it("labels an errored account 'Needs reconnecting' (not a silent green) with the attention tone", () => {
    expect(statusChip('error')).toEqual({ label: 'Needs reconnecting', tone: 'attention' });
  });

  it("labels a not-connected account 'Not connected' with the neutral tone", () => {
    expect(statusChip('not_connected')).toEqual({ label: 'Not connected', tone: 'neutral' });
  });
});
