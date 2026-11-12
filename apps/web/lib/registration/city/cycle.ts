/**
 * VIL-684 · the season the own-city lookup asks about: the coming winter. Winter
 * programs start in January and register in the weeks before, so from February on the
 * winter worth knowing about is next year's.
 */
export function winterCycleLabel(now: Date): string {
  const year = now.getUTCFullYear();
  return now.getUTCMonth() >= 1 ? `Winter ${year + 1}` : `Winter ${year}`;
}
