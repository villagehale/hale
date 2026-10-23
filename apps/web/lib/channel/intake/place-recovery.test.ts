import { afterEach, expect, it, vi } from 'vitest';
import { encryptString } from '~/lib/crypto/string-cipher';
import { placeFromGivenFields } from './first-touch-place';
import { decodeIntakeForRecovery } from './session';

afterEach(() => vi.unstubAllEnvs());

it('keeps a US ZIP and country through encrypted session persistence and recovery', () => {
  vi.stubEnv('APP_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'));
  const place = placeFromGivenFields({ postalCode: '05401', city: null });
  const data = encryptString(
    JSON.stringify({
      firstTouch: { language: 'en', place, locationRequest: null },
    }),
  );
  expect(decodeIntakeForRecovery(data).firstTouch?.place).toEqual(place);
  expect(decodeIntakeForRecovery(data).firstTouch?.place?.country).toBe('United States');
});
