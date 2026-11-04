import { isParentRole } from '~/lib/channel/role-scope';
import type { FamilySeat } from '~/lib/family';

export type ExportSeat =
  | { outcome: 'export'; familyId: string }
  | { outcome: 'export_parent_only' }
  | { outcome: 'export_family_ambiguous' };

/**
 * Which household's record, if any, these seats may download.
 *
 * The export is the whole family's record — its audit trail, members, children and place
 * — so only a parent of that family takes it; a caregiver seat (and the legacy
 * `extended` / `service` buckets) takes nothing. A parent of two households is refused
 * rather than handed one: nothing yet lets them say which they meant.
 */
export function exportSeat(seats: readonly FamilySeat[]): ExportSeat {
  const parentSeats = seats.filter((seat) => isParentRole(seat.role));
  const [only, ...rest] = parentSeats;
  if (!only) return { outcome: 'export_parent_only' };
  if (rest.length > 0) return { outcome: 'export_family_ambiguous' };
  return { outcome: 'export', familyId: only.familyId };
}
