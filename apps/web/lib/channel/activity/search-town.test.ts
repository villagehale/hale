import { describe, expect, it } from 'vitest';
import { activitySearchTown } from './search-town';

describe('activitySearchTown', () => {
  it('keeps a Danforth family in Toronto and East York, not the whole city', () => {
    expect(activitySearchTown('M4K 1N1')).toBe('Toronto and East York');
    expect(activitySearchTown('M4K')).toBe('Toronto and East York');
    expect(activitySearchTown('M5V')).toBe('Toronto and East York');
  });

  it('names the other Toronto districts on their own', () => {
    expect(activitySearchTown('M1W')).toBe('Scarborough');
    expect(activitySearchTown('M2N')).toBe('North York');
    expect(activitySearchTown('M8V')).toBe('Etobicoke and York');
  });

  it('keeps a town outside Toronto as that town', () => {
    expect(activitySearchTown('L7G')).toBe('Halton Hills');
  });

  it('names nothing when the area is missing or straddles two towns', () => {
    expect(activitySearchTown(null)).toBeNull();
    expect(activitySearchTown('')).toBeNull();
    expect(activitySearchTown('L4J')).toBeNull();
  });
});
