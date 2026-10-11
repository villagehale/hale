import { afterEach, describe, expect, it, vi } from 'vitest';
import { cadenceSkipsNumericCaps, capDefersToDecider, proactiveCadence } from './flag';

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
    vi.stubEnv('PROACTIVE_CADENCE', ' shadow');
    expect(proactiveCadence()).toBe('off');
    vi.stubEnv('PROACTIVE_CADENCE', 'Live');
    expect(proactiveCadence()).toBe('off');
    vi.stubEnv('PROACTIVE_CADENCE', 'shadow');
    expect(proactiveCadence()).toBe('shadow');
    vi.stubEnv('PROACTIVE_CADENCE', 'live');
    expect(proactiveCadence()).toBe('live');
  });

  it('skips numeric caps only when live', () => {
    vi.stubEnv('PROACTIVE_CADENCE', undefined);
    expect(cadenceSkipsNumericCaps()).toBe(false);
    vi.stubEnv('PROACTIVE_CADENCE', 'shadow');
    expect(cadenceSkipsNumericCaps()).toBe(false);
    vi.stubEnv('PROACTIVE_CADENCE', 'live');
    expect(cadenceSkipsNumericCaps()).toBe(true);
  });
});

describe('which caps give way to the decider', () => {
  it('only the routed classes, and only when live', () => {
    vi.stubEnv('PROACTIVE_CADENCE', 'live');
    expect(capDefersToDecider('nudge')).toBe(true);
    expect(capDefersToDecider('email_alert')).toBe(false);
    vi.stubEnv('PROACTIVE_CADENCE', 'shadow');
    expect(capDefersToDecider('nudge')).toBe(false);
  });
});
