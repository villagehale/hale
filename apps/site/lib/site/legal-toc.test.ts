import { describe, expect, it } from 'vitest';
import { currentLegalSection } from './legal-toc';

describe('legal table-of-contents marker', () => {
  const tops = [80, 420, 900];

  it('marks the section whose heading is at the line under the header', () => {
    expect(currentLegalSection(tops, 112)).toBe(0);
    expect(currentLegalSection([80, 100, 900], 112)).toBe(1);
  });

  it('does not stay on the previous section once the next heading reaches that line', () => {
    expect(currentLegalSection([ -240, 108, 640 ], 112)).toBe(1);
    expect(currentLegalSection([ -800, -40, 96 ], 112)).toBe(2);
  });

  it('keeps the first section while every heading is still below the line', () => {
    expect(currentLegalSection([400, 900, 1400], 112)).toBe(0);
  });
});
