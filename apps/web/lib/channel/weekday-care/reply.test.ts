import { describe, expect, it, vi } from 'vitest';
import { createWeekdayCareReader, toWeekdayCareReading } from './reply';

describe('toWeekdayCareReading', () => {
  it('files a high-confidence home reading and drops a provider', () => {
    expect(
      toWeekdayCareReading({ care: 'home', confidence: 'high', provider: 'Little Sprouts' }),
    ).toEqual({ status: 'read', care: 'home', provider: null });
  });

  it('keeps a daycare pin that can ride an SMS, and straightens apostrophes', () => {
    expect(
      toWeekdayCareReading({ care: 'daycare', confidence: 'high', provider: 'Little Sprouts' }),
    ).toEqual({ status: 'read', care: 'daycare', provider: 'Little Sprouts' });
    expect(
      toWeekdayCareReading({
        care: 'daycare',
        confidence: 'high',
        provider: 'Nana\u2019s',
      }),
    ).toEqual({ status: 'read', care: 'daycare', provider: "Nana's" });
    expect(
      toWeekdayCareReading({ care: 'daycare', confidence: 'high', provider: 'Café Enfants' }),
    ).toEqual({ status: 'read', care: 'daycare', provider: 'Café Enfants' });
  });

  it('keeps the daycare reading when the pin cannot ride an SMS', () => {
    expect(
      toWeekdayCareReading({ care: 'daycare', confidence: 'high', provider: 'Château Enfants' }),
    ).toEqual({ status: 'read', care: 'daycare', provider: null });
    expect(toWeekdayCareReading({ care: 'daycare', confidence: 'high', provider: '   ' })).toEqual({
      status: 'read',
      care: 'daycare',
      provider: null,
    });
    expect(
      toWeekdayCareReading({
        care: 'daycare',
        confidence: 'high',
        provider: 'A'.repeat(81),
      }),
    ).toEqual({ status: 'read', care: 'daycare', provider: null });
  });

  it('files starting soon with no pin', () => {
    expect(
      toWeekdayCareReading({ care: 'starting_soon', confidence: 'high', provider: 'Somewhere' }),
    ).toEqual({ status: 'read', care: 'starting_soon', provider: null });
  });

  it('files nothing unless the care is one of the three and the confidence is high', () => {
    expect(toWeekdayCareReading({ care: 'nothing', confidence: 'high' })).toEqual({
      status: 'nothing_stated',
    });
    expect(toWeekdayCareReading({ care: 'home', confidence: 'medium' })).toEqual({
      status: 'nothing_stated',
    });
    expect(toWeekdayCareReading({ care: 'daycare', confidence: 'low' })).toEqual({
      status: 'nothing_stated',
    });
    expect(toWeekdayCareReading({ care: 'school', confidence: 'high' })).toEqual({
      status: 'nothing_stated',
    });
  });
});

describe('createWeekdayCareReader', () => {
  it('names a missing client and files nothing', async () => {
    const logged = vi.spyOn(console, 'info').mockImplementation(() => {});
    const reader = createWeekdayCareReader(() => {
      throw new Error('no key');
    });
    await expect(reader.read('she is home with me')).resolves.toEqual({
      status: 'nothing_stated',
    });
    expect(JSON.stringify(logged.mock.calls)).toContain('client_unavailable');
    expect(JSON.stringify(logged.mock.calls)).not.toContain('she is home with me');
    logged.mockRestore();
  });
});
