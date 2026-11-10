import { afterEach, describe, expect, it, vi } from 'vitest';
import { MODEL_READ_SWEEP_ENABLED_ENV, modelReadSweepEnabled } from './flag';

describe('modelReadSweepEnabled', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('is on only for the exact string true', () => {
    expect(modelReadSweepEnabled({ [MODEL_READ_SWEEP_ENABLED_ENV]: 'true' })).toBe(true);
    expect(modelReadSweepEnabled({})).toBe(false);
    expect(modelReadSweepEnabled({ [MODEL_READ_SWEEP_ENABLED_ENV]: undefined })).toBe(false);
  });

  it.each(['true\n', 'TRUE', 'on', '1', ' true', 'true ', ''])(
    'stays off for %j',
    (value) => {
      expect(modelReadSweepEnabled({ [MODEL_READ_SWEEP_ENABLED_ENV]: value })).toBe(false);
    },
  );

  it('reads process.env when no bag is passed', () => {
    vi.stubEnv(MODEL_READ_SWEEP_ENABLED_ENV, 'true');
    expect(modelReadSweepEnabled()).toBe(true);
    vi.stubEnv(MODEL_READ_SWEEP_ENABLED_ENV, 'true\n');
    expect(modelReadSweepEnabled()).toBe(false);
  });
});
