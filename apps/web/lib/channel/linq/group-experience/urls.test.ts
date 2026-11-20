import { describe, expect, it } from 'vitest';
import { httpsUrlsIn } from './urls';

describe('httpsUrlsIn', () => {
  it('keeps https URLs and drops everything else', () => {
    expect(
      httpsUrlsIn('try https://park.example/camp (also http://insecure.example and not-a-url)'),
    ).toEqual(['https://park.example/camp']);
  });

  it('dedupes the same href', () => {
    expect(httpsUrlsIn('https://a.example/x https://a.example/x')).toEqual(['https://a.example/x']);
  });
});
