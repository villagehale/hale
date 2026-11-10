import { describe, expect, it } from 'vitest';
import { BROWSER_USE_RESIDENTIAL_PROXY_HOSTS, browserUseProxyFor } from './proxy';

describe('browserUseProxyFor', () => {
  it('is off for every provider by default', () => {
    expect(BROWSER_USE_RESIDENTIAL_PROXY_HOSTS).toEqual({});
    expect(browserUseProxyFor('anc.ca.apm.activecommunities.com')).toBeNull();
  });

  it('turns on per provider host with its country', () => {
    const hosts = { 'provider.test': 'ca' };
    expect(browserUseProxyFor('www.provider.test', hosts)).toBe('ca');
    expect(browserUseProxyFor('other.test', hosts)).toBeNull();
    expect(browserUseProxyFor('provider.test', { 'provider.test': 'CAN' })).toBeNull();
  });
});
