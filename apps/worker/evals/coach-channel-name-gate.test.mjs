import { describe, expect, it } from 'vitest';
import { inventedName } from './coach-channel-name-gate.mjs';

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
