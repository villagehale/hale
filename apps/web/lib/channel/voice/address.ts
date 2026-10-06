/**
 * French register for a parent line.
 * A stored tu or vous wins. When the family has none, tu, the same register as the weekend line.
 */
export function frenchAddress(stored?: 'tu' | 'vous' | null): 'tu' | 'vous' {
  return stored === 'tu' || stored === 'vous' ? stored : 'tu';
}
