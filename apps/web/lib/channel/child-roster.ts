/**
 * The full-age child roster: every child on the family, 13+ included.
 *
 * A weekend suggestion drops teenagers (rule #1). Weekday-care classification still
 * needs the whole household, with ids, so this shape is separate from `RadarChild`.
 * `name` is null for every teen at the call site, so a teen's name cannot reach a
 * prompt even if a later change forgot to check `isTeen`.
 *
 * Named `HealthChild` only because that is the type weekday-care already takes; it is
 * not a health-checkpoint type. Hale sends no vaccine or checkup reminders.
 */
export interface HealthChild {
  id: string;
  name: string | null;
  ageMonths: number;
  dobPrecision: 'exact' | 'derived';
  isTeen: boolean;
}
