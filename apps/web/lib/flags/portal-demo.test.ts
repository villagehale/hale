import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEMO_PHONE_E164, demoMaskedPhone } from '~/lib/portal/demo-fixture';
import { portalDemoEnabled } from './portal-demo';

describe('portalDemoEnabled', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('is off only on a Vercel production deployment', () => {
    vi.stubEnv('VERCEL_ENV', 'production');
    expect(portalDemoEnabled()).toBe(false);
  });

  it('is on for Preview, where the long alias is the design-QA host', () => {
    vi.stubEnv('VERCEL_ENV', 'preview');
    expect(portalDemoEnabled()).toBe(true);
  });

  it('is on when Vercel env is unset, so local next start can capture the demo', () => {
    vi.stubEnv('VERCEL_ENV', '');
    expect(portalDemoEnabled()).toBe(true);
  });
});

describe('the demo tree', () => {
  const layout = readFileSync(
    fileURLToPath(new URL('../../app/demo/layout.tsx', import.meta.url)),
    'utf8',
  );

  it('404s from the layout when the gate is off', () => {
    expect(layout).toContain('portalDemoEnabled()');
    expect(layout).toContain('notFound()');
    expect(layout).toContain("dynamic = 'force-dynamic'");
  });

  it('seeds a masked phone a parent can recognise', () => {
    expect(DEMO_PHONE_E164.endsWith('4821')).toBe(true);
    expect(demoMaskedPhone).toBe('••• ••• 4821');
    expect(demoMaskedPhone).not.toContain('416555');
  });

  it('seeds no city and no postal code', () => {
    const fixture = readFileSync(
      fileURLToPath(new URL('../portal/demo-fixture.ts', import.meta.url)),
      'utf8',
    );
    expect(fixture).not.toMatch(/Toronto|M5V/);
    expect(fixture).toContain('city: null');
    expect(fixture).toContain('postalCode: null');
    expect(fixture).toContain('province: null');
  });
});
