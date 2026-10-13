import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PROACTIVE_ROUTING,
  capDefersToDecider,
  proactiveCadence,
  requestedCadence,
  unroutedKinds,
} from './flag';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('proactive cadence flag', () => {
  it('reads off unless the env is exactly shadow or live', () => {
    vi.stubEnv('PROACTIVE_CADENCE', undefined);
    expect(requestedCadence()).toBe('off');
    vi.stubEnv('PROACTIVE_CADENCE', 'true');
    expect(requestedCadence()).toBe('off');
    vi.stubEnv('PROACTIVE_CADENCE', 'live\n');
    expect(requestedCadence()).toBe('off');
    vi.stubEnv('PROACTIVE_CADENCE', ' shadow');
    expect(requestedCadence()).toBe('off');
    vi.stubEnv('PROACTIVE_CADENCE', 'Live');
    expect(requestedCadence()).toBe('off');
    vi.stubEnv('PROACTIVE_CADENCE', 'shadow');
    expect(requestedCadence()).toBe('shadow');
    vi.stubEnv('PROACTIVE_CADENCE', 'live');
    expect(requestedCadence()).toBe('live');
  });

  it('runs a requested live as shadow while any class still sends on its own', () => {
    expect(unroutedKinds()).toContain('followup');
    expect(unroutedKinds()).not.toContain('nudge');
    vi.stubEnv('PROACTIVE_CADENCE', 'live');
    expect(proactiveCadence()).toBe('shadow');
    vi.stubEnv('PROACTIVE_CADENCE', 'shadow');
    expect(proactiveCadence()).toBe('shadow');
    vi.stubEnv('PROACTIVE_CADENCE', undefined);
    expect(proactiveCadence()).toBe('off');
  });

  it('keeps the registration ladder and instant spots out of the queue', () => {
    expect(PROACTIVE_ROUTING.registration_sequence).toBe('immediate');
    expect(PROACTIVE_ROUTING.spot_open_instant).toBe('immediate');
    expect(PROACTIVE_ROUTING.nudge).toBe('decider');
  });
});

describe('which caps give way to the decider', () => {
  it('only the routed classes, and only when live', () => {
    expect(capDefersToDecider('nudge', 'live')).toBe(true);
    expect(capDefersToDecider('email_alert', 'live')).toBe(false);
    expect(capDefersToDecider('registration_sequence', 'live')).toBe(false);
    expect(capDefersToDecider('nudge', 'shadow')).toBe(false);
    expect(capDefersToDecider('nudge', 'off')).toBe(false);
  });
});
