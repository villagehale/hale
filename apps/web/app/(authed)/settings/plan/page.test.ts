import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));

describe('Plan page', () => {
  it('keeps Free next to the founding offer during the window', () => {
    const source = readFileSync(join(here, 'page.tsx'), 'utf8');
    expect(source).toContain('FoundingPlan badge="Free"');
    expect(source).toContain('PromoOfferPlan');
    expect(source).toMatch(/windowOpen \? \([\s\S]*FoundingPlan[\s\S]*PromoOfferPlan/);
  });
});
