import { describe, expect, it } from 'vitest';
import {
  PROACTIVE_DECIDER_FIXTURES,
  PROACTIVE_DECIDER_LIVE_KINDS,
} from './proactive-decider-fixtures.mjs';

describe('VIL-691 proactive decider fixtures', () => {
  it('expects send_now for each news and time-critical class', () => {
    const covered = new Set(
      PROACTIVE_DECIDER_FIXTURES.flatMap((fixture) =>
        fixture.expect.action === 'send_now'
          ? fixture.snapshot.candidates.map((item) => item.kind)
          : [],
      ),
    );
    for (const kind of PROACTIVE_DECIDER_LIVE_KINDS) {
      expect(covered.has(kind), kind).toBe(true);
    }
  });
});
