import { randomUUID } from 'node:crypto';
import type { RegistrationSourceState } from '@hale/db';

/** Synthetic, watch-owned observation. Not a production schedule or seed. */
export function registrationSourceFixture(
  overrides: Partial<RegistrationSourceState> = {},
): RegistrationSourceState {
  return {
    id: randomUUID(),
    municipality: 'markham',
    programDomain: 'rec_program',
    cycleLabel: 'Test cycle',
    district: null,
    previewAt: null,
    residentOpenAt: null,
    openAt: new Date('2026-10-20T13:00:00Z'),
    residentPriorityDays: null,
    waitlistResponseHours: null,
    ageMinMonths: null,
    ageMaxMonths: null,
    sourceUrl: 'https://example.org/registration',
    verifiedAt: new Date('2026-10-10T12:00:00Z'),
    notes: null,
    createdAt: new Date('2026-10-10T12:00:00Z'),
    updatedAt: new Date('2026-10-10T12:00:00Z'),
    ...overrides,
  };
}
