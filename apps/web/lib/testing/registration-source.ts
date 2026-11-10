import { randomUUID } from 'node:crypto';
import type { RegistrationWindow } from '@hale/db';

/** A synthetic catalog row for reader tests: invented cycle, example.org source, and
 * stored dates no live reading should ever echo back. */
export function registrationWindowFixture(
  overrides: Partial<RegistrationWindow> = {},
): RegistrationWindow {
  return {
    id: randomUUID(),
    municipality: 'markham',
    programDomain: 'swim',
    cycleLabel: 'Test cycle',
    district: null,
    previewAt: null,
    residentOpenAt: null,
    openAt: new Date('2026-01-01T00:00:00Z'),
    residentPriorityDays: null,
    waitlistResponseHours: null,
    ageMinMonths: null,
    ageMaxMonths: null,
    sourceUrl: 'https://example.org/registration',
    verifiedAt: new Date('2025-12-01T00:00:00Z'),
    notes: null,
    createdAt: new Date('2025-12-01T00:00:00Z'),
    updatedAt: new Date('2025-12-01T00:00:00Z'),
    ...overrides,
  };
}
