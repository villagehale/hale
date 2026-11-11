import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROACTIVE_ROUTING, proactiveCadence, requestedCadence, unroutedKinds } from './flag';

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

  it('arms live once every class is routed', () => {
    expect(unroutedKinds()).toEqual([]);
    expect(unroutedKinds()).not.toContain('nudge');
    expect(unroutedKinds()).not.toContain('evening_check_in');
    vi.stubEnv('PROACTIVE_CADENCE', 'live');
    expect(proactiveCadence()).toBe('live');
    vi.stubEnv('PROACTIVE_CADENCE', 'shadow');
    expect(proactiveCadence()).toBe('shadow');
    vi.stubEnv('PROACTIVE_CADENCE', undefined);
    expect(proactiveCadence()).toBe('off');
  });

  it('keeps the registration ladder and instant spots out of the queue', () => {
    expect(PROACTIVE_ROUTING.registration_sequence).toBe('immediate');
    expect(PROACTIVE_ROUTING.spot_open_instant).toBe('immediate');
    expect(PROACTIVE_ROUTING.nudge).toBe('decider');
    expect(PROACTIVE_ROUTING.evening_check_in).toBe('decider');
  });

  it('routes every remaining class through the decider', () => {
    expect(PROACTIVE_ROUTING.village_intro).toBe('decider');
    expect(PROACTIVE_ROUTING.followup).toBe('decider');
    expect(PROACTIVE_ROUTING.plan_check_in).toBe('decider');
    expect(PROACTIVE_ROUTING.activity_followup).toBe('decider');
    expect(PROACTIVE_ROUTING.spot_open).toBe('decider');
    expect(PROACTIVE_ROUTING.email_alert).toBe('decider');
    expect(PROACTIVE_ROUTING.calendar_alert).toBe('decider');
    expect(PROACTIVE_ROUTING.duty_ask).toBe('decider');
    expect(PROACTIVE_ROUTING.co_parent_departed).toBe('decider');
    expect(PROACTIVE_ROUTING.travel_brief).toBe('decider');
  });
});
