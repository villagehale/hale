import { describe, expect, it } from 'vitest';
import { isPublicAddress, registrationPageUrl } from './page';

describe('registration page network boundary', () => {
  it.each([
    'https://localhost/a',
    'https://127.0.0.1/a',
    'https://[::1]/a',
    'https://10.0.0.1/a',
    'https://169.254.169.254/a',
    'http://example.com/a',
    'https://u:p@example.com/a',
    'https://example.com:8443/a',
    'https://example.com/a?token=private',
    'https://example.com/a?api_key=private',
    'https://example.com/a#access_token=private',
  ])('refuses %s', (url) => {
    expect(() => registrationPageUrl(url)).toThrow();
  });
  it('preserves query and hash course identity', () => {
    expect(registrationPageUrl('https://EXAMPLE.com/course?id=4#swim')).toBe(
      'https://example.com/course?id=4#swim',
    );
  });
  it.each([
    '0.0.0.0',
    '10.1.2.3',
    '100.64.0.1',
    '127.3.2.1',
    '172.31.0.1',
    '192.168.1.2',
    '192.0.2.1',
    '198.18.0.1',
    '224.0.0.1',
    '::ffff:127.0.0.1',
    'fc00::1',
    'fe80::1',
    '2001:db8::1',
  ])('rejects non-public DNS answer %s', (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });
  it.each(['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111'])(
    'accepts public DNS answer %s',
    (address) => {
      expect(isPublicAddress(address)).toBe(true);
    },
  );
});
