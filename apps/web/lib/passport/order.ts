const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/** Higher means a later season on the stamp face (`OCT 26` beats `DEC 25`). */
export function stampRecency(face: string): number {
  const match = /^([A-Z]{3})\s+(\d{2})$/.exec(face.trim().toUpperCase());
  if (!match?.[1] || !match[2]) return 0;
  const month = MONTHS.indexOf(match[1]);
  if (month < 0) return 0;
  return Number(match[2]) * 12 + month;
}

/** Newest season first. Equal faces keep the incoming order. */
export function sortStampsNewestFirst<T extends { face: string }>(stamps: readonly T[]): T[] {
  return stamps
    .map((stamp, index) => ({ stamp, index }))
    .sort((a, b) => stampRecency(b.stamp.face) - stampRecency(a.stamp.face) || a.index - b.index)
    .map((item) => item.stamp);
}
