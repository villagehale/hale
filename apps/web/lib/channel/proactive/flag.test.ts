import { afterEach, describe, expect, it, vi } from 'vitest';
import { cadenceSkipsNumericCaps, proactiveCadence } from './flag';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('proactive cadence flag', () => {
  it('is off unless the env is exactly shadow or live', () => {
    vi.stubEnv('PROACTIVE_CADENCE', undefined);
    expect(proactiveCadence()).toBe('off');
    vi.stubEnv('PROACTIVE_CADENCE', 'true');
    expect(proactiveCadence()).toBe('off');
    vi.stubEnv('PROACTIVE_CADENCE', 'live\n');
    expect(proactiveCadence()).toBe('off');
    vi.stubEnv('PROACTIVE_CADENCE', 'shadow');
    expect(proactiveCadence()).toBe('shadow');
    vi.stubEnv('PROACTIVE_CADENCE', 'live');
    expect(proactiveCadence()).toBe('live');
  });

  it('skips numeric caps only when live', () => {
    vi.stubEnv('PROACTIVE_CADENCE', 'shadow');
    expect(cadenceSkipsNumericCaps()).toBe(false);
    vi.stubEnv('PROACTIVE_CADENCE', 'live');
    expect(cadenceSkipsNumericCaps()).toBe(true);
  });
});
