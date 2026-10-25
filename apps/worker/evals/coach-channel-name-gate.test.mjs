import { describe, expect, it } from 'vitest';
import { inventedName, weekdayGrounded } from './coach-channel-name-gate.mjs';

// The hay the coach-channel gate builds: this family's children, parent and town,
// lowercased and flattened (groundedHay in run-coach-channel-eval.mjs).
const HAY = 'remy theo sam toronto swim lesson thu';

describe('inventedName', () => {
  it('catches a name this family was never handed', () => {
    expect(inventedName('Marcus', HAY)).toBe('Marcus');
  });

  it('catches it through a possessive too, whatever punctuation follows', () => {
    expect(inventedName("Marcus's", HAY)).toBe('Marcus');
    expect(inventedName("Marcus's...", HAY)).toBe('Marcus');
    expect(inventedName('Marcus.', HAY)).toBe('Marcus');
  });

  it('clears a known name in every form the composer can leave it in', () => {
    // The 2-segment trim cuts mid-sentence and appends an ellipsis, so a possessive
    // reaches the gate wearing punctuation the model never wrote.
    expect(inventedName('Remy', HAY)).toBeNull();
    expect(inventedName("Remy's", HAY)).toBeNull();
    expect(inventedName("Remy's...", HAY)).toBeNull();
    expect(inventedName('Remy’s.', HAY)).toBeNull();
    expect(inventedName('"Theo\'s"', HAY)).toBeNull();
  });

  it('ignores words that make no claim about this family', () => {
    expect(inventedName('sitting', HAY)).toBeNull();
    expect(inventedName('Want', HAY)).toBeNull();
    expect(inventedName('Canada', HAY)).toBeNull();
    expect(inventedName('YES', HAY)).toBeNull();
  });
});

describe('a weekday name', () => {
  // capability-park-nearby-again: the farm's own when is "Sun, Aug 9", and Aug 9 2026 is a Sunday.
  const FARM = 'riverdale farm visit sun, aug 9 cedarvale park';

  it('is grounded when a date in the facts falls on that weekday', () => {
    expect(weekdayGrounded('Sunday', FARM, 2026)).toBe(true);
    expect(inventedName('Sunday,', FARM, 2026)).toBeNull();
  });

  it('is a wrong fact when no date in the facts falls on it', () => {
    expect(weekdayGrounded('Saturday', FARM, 2026)).toBe(false);
    expect(inventedName('Saturday', FARM, 2026)).toBe('Saturday');
  });

  it('is computed from the year, not aliased from an abbreviation', () => {
    // Aug 9 2025 is a Saturday, so "Sunday" is not backed even though "sun" is in the hay.
    expect(weekdayGrounded('Sunday', FARM, 2025)).toBe(false);
    expect(weekdayGrounded('Saturday', FARM, 2025)).toBe(true);
  });
});
