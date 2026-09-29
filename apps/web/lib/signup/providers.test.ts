import { describe, expect, it } from 'vitest';
import { SIGNUP_PROVIDER_ALLOWLIST, signupProviderFor } from './providers';

describe('signup provider allowlist', () => {
  it('registers only the local mock', () => {
    expect(SIGNUP_PROVIDER_ALLOWLIST.map((adapter) => adapter.id)).toEqual(['local-mock']);
  });

  it('matches the loopback mock and nothing that merely looks local', () => {
    expect(signupProviderFor('http://127.0.0.1:4312/register')?.id).toBe('local-mock');
    expect(signupProviderFor('http://localhost/register')?.id).toBe('local-mock');
    expect(signupProviderFor('http://[::1]/register')?.id).toBe('local-mock');
    expect(signupProviderFor('https://127.0.0.1/register')).toBeNull();
    expect(signupProviderFor('http://127.0.0.1.evil.test/register')).toBeNull();
  });

  it('does not adapt municipal, ActiveNet, Xplor, or PerfectMind hosts', () => {
    const refused = [
      'https://anc.ca.apm.activecommunities.com/toronto/activity/search',
      'https://ca.apm.activecommunities.com/markham/activity/search',
      'https://register.xplorrecreation.com/brampton',
      'https://www.perfectmind.com/signup',
      'https://www.toronto.ca/explore-enjoy/recreation/registrations',
      'https://www.markham.ca/recreation',
      'https://www.brampton.ca/EN/residents/recreation',
      'https://register.example.test/register',
    ];
    for (const href of refused) {
      expect(signupProviderFor(href), href).toBeNull();
    }
  });
});
