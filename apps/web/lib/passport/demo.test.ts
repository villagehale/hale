import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  INTEREST_PASSPORT_DEMO_ENV,
  interestPassportDemo,
  isPassportDemoPath,
  passportDemoBypassesAuth,
} from './demo';

vi.mock('~/auth', () => ({ auth: async () => null }));
vi.mock('~/lib/auth-config', () => ({ authConfigured: () => true }));
vi.mock('~/lib/db', () => ({
  db: () => {
    throw new Error('database opened');
  },
}));

const ON = {
  VERCEL_ENV: 'preview',
  INTEREST_PASSPORT_ENABLED: 'true',
  [INTEREST_PASSPORT_DEMO_ENV]: 'true',
} as const;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('interest passport demo', () => {
  it('is impossible in production, even with both flags set', () => {
    expect(
      interestPassportDemo({
        ...ON,
        VERCEL_ENV: 'production',
        NODE_ENV: 'production',
      }),
    ).toBe(false);
    expect(passportDemoBypassesAuth('/family', { ...ON, VERCEL_ENV: 'production' })).toBe(false);
  });

  it('is on only for a Vercel preview with both flags exactly true', () => {
    expect(interestPassportDemo({ ...ON, NODE_ENV: 'production' })).toBe(true);
  });

  it.each([
    { VERCEL_ENV: 'preview', INTEREST_PASSPORT_ENABLED: 'true' },
    { VERCEL_ENV: 'preview', [INTEREST_PASSPORT_DEMO_ENV]: 'true' },
    { ...ON, VERCEL_ENV: 'development' },
    { ...ON, VERCEL_ENV: 'production' },
    { ...ON, INTEREST_PASSPORT_ENABLED: 'TRUE' },
    { ...ON, [INTEREST_PASSPORT_DEMO_ENV]: 'true\n' },
    { ...ON, [INTEREST_PASSPORT_DEMO_ENV]: '1' },
    {},
  ])('stays off for %j', (env) => {
    expect(interestPassportDemo(env)).toBe(false);
  });

  it('opens only Family and the Mia and Leo fixture', () => {
    expect(isPassportDemoPath('/family')).toBe(true);
    expect(isPassportDemoPath('/family/')).toBe(true);
    expect(isPassportDemoPath('/family/preview-mia')).toBe(true);
    expect(isPassportDemoPath('/family/preview-leo')).toBe(true);
    expect(isPassportDemoPath('/family/members')).toBe(false);
    expect(isPassportDemoPath('/family/preview-mia/extra')).toBe(false);
    expect(isPassportDemoPath('/settings')).toBe(false);
    expect(isPassportDemoPath('/demo/passport')).toBe(false);
  });

  it('does not let a preview demo skip auth for any other page', () => {
    expect(passportDemoBypassesAuth('/family', ON)).toBe(true);
    expect(passportDemoBypassesAuth('/family/preview-mia', ON)).toBe(true);
    expect(passportDemoBypassesAuth('/settings', ON)).toBe(false);
    expect(passportDemoBypassesAuth('/home', ON)).toBe(false);
    expect(passportDemoBypassesAuth('/family/members', ON)).toBe(false);
  });

  it('renders the fixture and does not open the database', async () => {
    vi.stubEnv('VERCEL_ENV', 'preview');
    vi.stubEnv('INTEREST_PASSPORT_ENABLED', 'true');
    vi.stubEnv(INTEREST_PASSPORT_DEMO_ENV, 'true');
    vi.stubEnv('DATABASE_URL', 'postgres://should-not-be-used');
    const { readPassportModel } = await import('./read');
    const model = await readPassportModel();
    expect(model.preview).toBe(true);
    expect(model.children.map((child) => child.name)).toEqual(['Mia', 'Leo']);
  });

  it('still opens the database in production when a database is configured', async () => {
    vi.stubEnv('VERCEL_ENV', 'production');
    vi.stubEnv('INTEREST_PASSPORT_ENABLED', 'true');
    vi.stubEnv(INTEREST_PASSPORT_DEMO_ENV, 'true');
    vi.stubEnv('DATABASE_URL', 'postgres://should-be-refused');
    const { readPassportModel } = await import('./read');
    await expect(readPassportModel()).rejects.toThrow('database opened');
  });
});
