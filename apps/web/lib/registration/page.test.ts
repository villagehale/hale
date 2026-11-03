import { describe, expect, it } from 'vitest';
import { isPublicAddress, registrationPageUrl } from './page';

describe('registration page network boundary', () => {
  it.each([
    'https://example.com/a?token=x',
    'https://example.com/a?API-KEY=x',
    'https://example.com/a?api.key=x',
    'https://example.com/a?api_key=x',
    'https://example.com/a?X-Amz-Security-Token=x',
    'https://example.com/a?X-Goog-Signature=x',
    'https://example.com/a?otp=1',
    'https://example.com/a?magic=abc',
    'https://example.com/a?jsessionid=1',
    'https://example.com/a?refresh_token=1',
    'https://example.com/a?token[]=x',
    'https://example.com/a?sessionId=1',
    'https://example.com/a?accessToken=1',
    'https://example.com/a?authToken=1',
    'https://example.com/a?CFTOKEN=1',
    'https://example.com/a#access_token=x',
    'https://example.com/a#id_token=x',
    'https://example.com/a?client_secret=x',
    'https://example.com/a?passwd=x',
    'https://example.com/a?pwd=x',
    'https://example.com/a?accesskey=x',
    'https://example.com/a?AWSAccessKeyId=x',
    'https://example.com/a?token[0]=x',
    'https://example.com/a?token%5B0%5D=x',
    'https://example.com/a?newPassword=x',
    // SPA hash routes carry their own query after the first '?'.
    'https://example.com/a#/cb?password=x',
    'https://example.com/a#/cb?season=fall&access_token=x',
    // A credential key followed by '=' anywhere in the fragment, not only at a segment start.
    'https://example.com/a#state=1;access_token=x',
    'https://example.com/a#/cb/id_token=x',
    'https://example.com/a#newpassword=x',
    // One malformed escape must not leave the rest of the fragment encoded.
    'https://example.com/a#%zz&pass%77ord=x',
    'https://example.com/a#%zz&jsession%69d=x',
    'https://example.com/a#%zz&client%5Fsecret=x',
    'https://example.com/a#pass%77ord%3Dx',
    'https://example.com/a#a=%ff%26jsessionid=x',
    // A hash route's '?' delimits a key from the exact set, not only a suffix match.
    'https://example.com/a#/cb?jsessionid=x',
    'https://example.com/a#/cb?client_secret=x',
    'https://example.com/reg;jsessionid=1',
    'https://u:p@example.com/a',
    'http://u:p@example.com/?session=fall',
  ])('names %s a credential link', (url) => {
    expect(registrationPageUrl(url)).toEqual({ outcome: 'refused', reason: 'credential_link' });
  });

  it.each([
    'https://example.com/a?session=fall',
    'https://example.com/a?code=SWIM1',
    'https://example.com/a?key=4',
    'https://example.com/a?ticket=7',
    'https://example.com/a?sid=12',
  ])('names %s an ordinary link it still refuses, never a credential link', (url) => {
    expect(registrationPageUrl(url)).toEqual({ outcome: 'refused', reason: 'ambiguous_query_key' });
  });

  it.each([
    ['http://example.com/a', 'not_https'],
    ['https://example.com:8443/a', 'nonstandard_port'],
    ['https://localhost/a', 'non_public_host'],
    ['https://127.0.0.1/a', 'non_public_host'],
    ['https://[::1]/a', 'non_public_host'],
    ['https://10.0.0.1/a', 'non_public_host'],
    ['https://169.254.169.254/a', 'non_public_host'],
    ['https://intranet/a', 'non_public_host'],
    ['https://localhost./a', 'non_public_host'],
    ['https://intranet./a', 'non_public_host'],
    ['https://printer.local./a', 'non_public_host'],
    ['https://localhost../a', 'non_public_host'],
    ['https://intranet../a', 'non_public_host'],
    ['https://localhost/?session=1', 'non_public_host'],
    ['not a url', 'malformed_url'],
  ])('refuses %s as %s', (url, reason) => {
    expect(registrationPageUrl(url)).toEqual({ outcome: 'refused', reason });
  });

  it('preserves query and hash course identity', () => {
    expect(registrationPageUrl('https://EXAMPLE.com/course?id=4#swim')).toEqual({
      outcome: 'allowed',
      url: 'https://example.com/course?id=4#swim',
    });
  });

  it.each([
    'https://example.com/a?program=kids&season=fall',
    'https://example.com/a?tokens=2',
    'https://example.com/a?session_name=fall',
    'https://example.com/a#session',
    'https://example.com/a#auth',
    'https://example.com/a#/section',
    'https://example.com/a#/program?season=fall&id=4',
    'https://example.com/a;b/c',
    'https://example.com./a',
    'https://example.com/a#%zz&season=fall',
  ])('allows the ordinary link %s', (url) => {
    expect(registrationPageUrl(url)).toEqual({ outcome: 'allowed', url });
  });

  it('resolves a relative target against a base inside the same never-throwing check', () => {
    expect(registrationPageUrl('/x?program=kids', 'https://example.org/a')).toEqual({
      outcome: 'allowed',
      url: 'https://example.org/x?program=kids',
    });
    expect(registrationPageUrl('http://[', 'https://example.org/a')).toEqual({
      outcome: 'refused',
      reason: 'malformed_url',
    });
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
