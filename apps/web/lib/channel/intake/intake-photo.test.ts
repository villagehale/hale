import { afterEach, describe, expect, it, vi } from 'vitest';
import { intakePhotoReadEnabled } from './intake-photo';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('intakePhotoReadEnabled', () => {
  it('is on only for exact true', () => {
    expect(intakePhotoReadEnabled()).toBe(false);
    vi.stubEnv('INTAKE_PHOTO_READ_ENABLED', 'true\n');
    expect(intakePhotoReadEnabled()).toBe(false);
    vi.stubEnv('INTAKE_PHOTO_READ_ENABLED', 'true');
    expect(intakePhotoReadEnabled()).toBe(true);
  });
});
