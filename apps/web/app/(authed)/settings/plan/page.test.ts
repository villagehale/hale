import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

const familyIdMock = vi.fn(async () => 'fam-1');
const basicsMock = vi.fn(async () => ({ planTier: 'free' as const }));

vi.mock('next/headers', () => ({
  headers: async () => ({ get: () => 'CA' }),
}));
vi.mock('~/lib/family', () => ({
  currentFamilyId: () => familyIdMock(),
}));
vi.mock('~/lib/dashboard/queries', () => ({
  loadFamilyBasics: () => basicsMock(),
}));

async function renderPlan(): Promise<string> {
  const { default: SettingsPlanPage } = await import('./page');
  return renderToStaticMarkup(await SettingsPlanPage());
}

describe('Plan page offer surface', () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    familyIdMock.mockReset();
    familyIdMock.mockResolvedValue('fam-1');
    basicsMock.mockReset();
    basicsMock.mockResolvedValue({ planTier: 'free' });
  });

  it('during the window shows Free and founding annual, not monthly or list annual', async () => {
    vi.stubEnv('HOLIDAY_PROMO_ENABLED', 'true');
    const html = await renderPlan();
    expect(html).toContain('Free');
    expect(html).toContain('Founding offer');
    expect(html).toContain('$79/yr');
    expect(html).not.toContain('/mo');
    expect(html).not.toContain('Continue ·');
    expect(html).not.toContain('$159/yr');
    expect(html).not.toContain('disabled');
  });

  it('shows the same two options for a listed preview family while the live flag is off', async () => {
    familyIdMock.mockResolvedValue('fam-preview');
    vi.stubEnv('PROMO_PREVIEW_FAMILY_IDS', 'fam-preview');
    const html = await renderPlan();
    expect(html).toContain('Free');
    expect(html).toContain('Founding offer');
    expect(html).toContain('$79/yr');
    expect(html).not.toContain('/mo');
    expect(html).not.toContain('Continue ·');
  });

  it('after the cutoff shows monthly and regular annual', async () => {
    vi.stubEnv('HOLIDAY_PROMO_ENABLED', 'true');
    vi.stubEnv('PROMO_FOUNDING_ENDS_AT', '2020-01-01T00:00:00Z');
    const html = await renderPlan();
    expect(html).toContain('Continue · $19/mo');
    expect(html).toContain('Continue · $159/yr');
    expect(html).not.toContain('$79/yr');
    expect(html).not.toContain('Founding offer');
  });
});
