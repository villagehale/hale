import { afterEach, describe, expect, it, vi } from 'vitest';
import { candidateDedupeKey, routeLane } from './queue';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('routeLane', () => {
  it('sends everything while the flag is off or shadow', () => {
    vi.stubEnv('PROACTIVE_CADENCE', undefined);
    expect(routeLane('candidate')).toBe('send');
    vi.stubEnv('PROACTIVE_CADENCE', 'shadow');
    expect(routeLane('candidate')).toBe('send');
  });

  it('queues ordinary candidates when live and still sends replies and time-critical items', () => {
    vi.stubEnv('PROACTIVE_CADENCE', 'live');
    expect(routeLane('candidate')).toBe('queued');
    expect(routeLane('reply')).toBe('send');
    expect(routeLane('immediate')).toBe('send');
  });
});

describe('candidateDedupeKey', () => {
  it('is stable for the same family and parts', () => {
    expect(candidateDedupeKey('fam', 'lantern')).toBe(candidateDedupeKey('fam', 'lantern'));
    expect(candidateDedupeKey('fam', 'lantern')).not.toBe(candidateDedupeKey('fam', 'soccer'));
  });
});
