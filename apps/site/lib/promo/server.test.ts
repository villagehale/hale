import { describe, expect, it } from 'vitest';
import { requestHolidayPromo } from './server';

describe('requestHolidayPromo', () => {
  it('keeps French and Chinese on the list surface', async () => {
    await expect(requestHolidayPromo('fr')).resolves.toBeNull();
    await expect(requestHolidayPromo('zh')).resolves.toBeNull();
  });
});
