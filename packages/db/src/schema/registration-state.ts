/** Imported, family-owned last-known source state. Never a parent-facing fact without a live read. */
export type Municipality =
  | 'toronto'
  | 'markham'
  | 'vaughan'
  | 'richmond_hill'
  | 'mississauga'
  | 'oakville'
  | 'burlington'
  | 'halton_hills'
  | 'brampton'
  | 'caledon'
  | 'ajax'
  | 'pickering'
  | 'whitby'
  | 'oshawa'
  | 'aurora'
  | 'whitchurch_stouffville'
  | 'newmarket'
  | 'king'
  | 'east_gwillimbury'
  | 'georgina'
  | 'uxbridge';
export type ProgramDomain = 'rec_program' | 'camp' | 'swim' | 'after_school_care';

export interface RegistrationSourceState {
  id: string;
  municipality: Municipality;
  programDomain: ProgramDomain;
  cycleLabel: string;
  district: string | null;
  previewAt: Date | null;
  residentOpenAt: Date | null;
  openAt: Date;
  residentPriorityDays: number | null;
  waitlistResponseHours: number | null;
  ageMinMonths: number | null;
  ageMaxMonths: number | null;
  sourceUrl: string;
  verifiedAt: Date;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** JSON serializes timestamps; normalize only when loading an owned watch. */
export function registrationSourceState(
  value: RegistrationSourceState | null,
): RegistrationSourceState | null {
  if (!value) return null;
  const date = (raw: Date): Date => {
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime()))
      throw new Error('Invalid registration watch source timestamp');
    return parsed;
  };
  return {
    ...value,
    previewAt: value.previewAt === null ? null : date(value.previewAt),
    residentOpenAt: value.residentOpenAt === null ? null : date(value.residentOpenAt),
    openAt: date(value.openAt),
    verifiedAt: date(value.verifiedAt),
    createdAt: date(value.createdAt),
    updatedAt: date(value.updatedAt),
  };
}
