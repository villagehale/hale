import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const page = readFileSync(fileURLToPath(new URL('./page.tsx', import.meta.url)), 'utf8');
const form = readFileSync(
  fileURLToPath(new URL('../../components/billing/founding-join-form.tsx', import.meta.url)),
  'utf8',
);

describe('/founding', () => {
  it('stays dark unless both payment flags are on, and never enrols a channel from the form', () => {
    expect(page).toContain('promoNewVisitorCheckoutEnabled');
    expect(page).toContain('foundingPromoOpen');
    expect(page).toContain('notFound');
    expect(form).toContain('/api/promo/join/request');
    expect(form).toContain('/api/promo/join/verify');
    expect(form).toContain('/api/promo/join/checkout');
    expect(form).toContain('Text Hale');
    expect(form).not.toContain('parentChannels');
  });
});
