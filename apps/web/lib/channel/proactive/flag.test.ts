import { setFlagEvaluatorForTests } from '@hale/flags';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PROACTIVE_ROUTING,
  familyDecisionCapEnabled,
  proactiveCadence,
  proactiveNoRepeatEnabled,
  proactiveReviewGuardsEnabled,
  proactiveSendsPaused,
  requestedCadence,
  unroutedKinds,
} from './flag';

afterEach(() => {
  vi.unstubAllEnvs();
  setFlagEvaluatorForTests(null);
});

describe('proactive no-repeat flag', () => {
  it('is on only for exact true', () => {
    vi.stubEnv('PROACTIVE_NO_REPEAT_ENABLED', undefined);
    expect(proactiveNoRepeatEnabled()).toBe(false);
    vi.stubEnv('PROACTIVE_NO_REPEAT_ENABLED', 'true\n');
    expect(proactiveNoRepeatEnabled()).toBe(false);
    vi.stubEnv('PROACTIVE_NO_REPEAT_ENABLED', 'true');
    expect(proactiveNoRepeatEnabled()).toBe(true);
  });
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
    expect(PROACTIVE_ROUTING.next_day_checkback).toBe('decider');
  });

  it('arms the review guards, the daily decision cap, and the send pause only on exact true', () => {
    expect(proactiveReviewGuardsEnabled()).toBe(false);
    expect(familyDecisionCapEnabled()).toBe(false);
    expect(proactiveSendsPaused()).toBe(false);
    vi.stubEnv('PROACTIVE_REVIEW_GUARDS_ENABLED', 'true\n');
    vi.stubEnv('PROACTIVE_FAMILY_DECISION_CAP_ENABLED', 'TRUE');
    vi.stubEnv('PROACTIVE_SENDS_PAUSED', ' true');
    expect(proactiveReviewGuardsEnabled()).toBe(false);
    expect(familyDecisionCapEnabled()).toBe(false);
    expect(proactiveSendsPaused()).toBe(false);
    vi.stubEnv('PROACTIVE_REVIEW_GUARDS_ENABLED', 'true');
    vi.stubEnv('PROACTIVE_FAMILY_DECISION_CAP_ENABLED', 'true');
    vi.stubEnv('PROACTIVE_SENDS_PAUSED', 'true');
    expect(proactiveReviewGuardsEnabled()).toBe(true);
    expect(familyDecisionCapEnabled()).toBe(true);
    expect(proactiveSendsPaused()).toBe(true);
  });

  it('keeps an exact env pause when PostHog has the flag loaded as false', () => {
    setFlagEvaluatorForTests(() => false);
    vi.stubEnv('POSTHOG_FLAGS_ENABLED', 'true');
    vi.stubEnv('POSTHOG_ID_SALT', 'test-salt');
    vi.stubEnv('PROACTIVE_SENDS_PAUSED', 'true');
    expect(proactiveSendsPaused()).toBe(true);
    vi.stubEnv('PROACTIVE_SENDS_PAUSED', 'true\n');
    expect(proactiveSendsPaused()).toBe(false);
  });
});
