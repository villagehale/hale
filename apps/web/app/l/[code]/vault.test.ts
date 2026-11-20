import { describe, expect, it } from 'vitest';
import { saveOutcome } from './vault';

describe('the vault save response', () => {
  it('reads only a spent link as gone; a fixable or failed save keeps the form', () => {
    expect(saveOutcome(200, undefined)).toBe('saved');
    expect(saveOutcome(404, 'gone')).toBe('gone');
    expect(saveOutcome(400, 'totp')).toBe('fix_totp');
    expect(saveOutcome(400, 'invalid_body')).toBe('fix_form');
    expect(saveOutcome(500, undefined)).toBe('retry');
    expect(saveOutcome(null, undefined)).toBe('retry');
  });
});
