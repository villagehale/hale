import type { DeleteAccountRole } from '~/components/hale/delete-account-button';

/** The erasure the viewer's seats allow them to ask for (see DeleteAccountRole). */
export function deleteAccountRole(
  seats: readonly { familyId: string; role: string }[],
  familyId: string | null,
): DeleteAccountRole {
  const viewerRole = seats.find((seat) => seat.familyId === familyId)?.role ?? null;
  return seats.length > 1
    ? 'ambiguous'
    : seats.length === 1 && viewerRole === 'co_parent'
      ? 'co_parent'
      : viewerRole === null || viewerRole === 'primary_parent'
        ? 'primary_parent'
        : 'scoped';
}
