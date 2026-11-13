import { describe, expect, it } from 'vitest';
import { ownRegistrableDomain, verifyOfficialHost } from './official-host';

describe('ownRegistrableDomain', () => {
  it("names an institution's own domain, from any of its hosts", () => {
    expect(ownRegistrableDomain('toronto.ca')).toBe('toronto.ca');
    expect(ownRegistrableDomain('www.markham.ca')).toBe('markham.ca');
    expect(ownRegistrableDomain('ville.montreal.qc.ca')).toBe('montreal.qc.ca');
    expect(ownRegistrableDomain('nyc.gov')).toBe('nyc.gov');
  });

  it('refuses a public suffix itself', () => {
    for (const host of ['ca', 'on.ca', 'gc.ca', 'co.uk', 'gov']) {
      expect({ host, domain: ownRegistrableDomain(host) }).toEqual({ host, domain: null });
    }
  });

  it("refuses shared hosting: the list's private section, and builders it leaves out", () => {
    for (const host of [
      'mytown.github.io',
      'mytown.blogspot.com',
      'mytown.wixsite.com',
      'mytown.netlify.app',
      'mytown.squarespace.com',
      'mytown.wordpress.com',
      'mytown.weebly.com',
      'sites.google.com',
    ]) {
      expect({ host, domain: ownRegistrableDomain(host) }).toEqual({ host, domain: null });
    }
  });

  it('refuses social and user-content hosts the list does not mark as shared, under any country code', () => {
    for (const host of [
      'facebook.com',
      'www.facebook.com',
      'instagram.com',
      'x.com',
      'twitter.com',
      'linkedin.com',
      'youtube.com',
      'linktr.ee',
      'medium.com',
      'mytown.substack.com',
      'mytown.tumblr.com',
      'mytown.jimdosite.com',
      'mytown.mystrikingly.com',
      'wix.com',
      'mytown.business.site',
      'mytown.site123.me',
      'mytown.weebly.ca',
      'mytown.blogspot.ca',
      'mytown.blogspot.co.uk',
      'wordpress.org',
      'mytown.edublogs.org',
      'mytown.typepad.com',
      'mytown.ning.com',
    ]) {
      expect({ host, domain: ownRegistrableDomain(host) }).toEqual({ host, domain: null });
    }
    // Positive control: a town whose own domain merely contains such a word.
    expect(ownRegistrableDomain('www.mediumtown.ca')).toBe('mediumtown.ca');
  });

  it('refuses an IP address', () => {
    expect(ownRegistrableDomain('192.0.2.10')).toBeNull();
  });
});

describe('verifyOfficialHost', () => {
  it('trusts a referenced statement on its own domain', () => {
    expect(
      verifyOfficialHost({ host: 'markham.ca', referenced: true, topResultUrl: null }),
    ).toEqual({ trusted: true, domain: 'markham.ca', by: 'reference' });
  });

  it("trusts an unreferenced one when the live search's top result is on the same domain", () => {
    expect(
      verifyOfficialHost({
        host: 'toronto.ca',
        referenced: false,
        topResultUrl: 'https://secure.toronto.ca/registration/winter',
      }),
    ).toEqual({ trusted: true, domain: 'toronto.ca', by: 'search' });
  });

  it('does not trust an unreferenced one the search does not agree with', () => {
    for (const topResultUrl of [
      null,
      'https://www.nowtoronto.com/winter-registration',
      'https://toronto.ca.example.com/registration',
      'not a url',
    ]) {
      expect(verifyOfficialHost({ host: 'toronto.ca', referenced: false, topResultUrl })).toEqual({
        trusted: false,
        reason: 'uncorroborated',
      });
    }
  });

  it('never trusts shared hosting, whatever else agrees', () => {
    expect(
      verifyOfficialHost({
        host: 'mytown.github.io',
        referenced: true,
        topResultUrl: 'https://mytown.github.io/rec',
      }),
    ).toEqual({ trusted: false, reason: 'shared_host' });
  });
});
