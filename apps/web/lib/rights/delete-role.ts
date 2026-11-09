import type { DeleteAccountRole } from '~/components/hale/delete-account-button';

/**
 * The erasure the viewer's seats allow them to ask for (see DeleteAccountRole). A viewer
 * with no seat in this family has none: the route answers them 403.
 */
export function deleteAccountRole(
  seats: readonly { familyId: string; role: string }[],
  familyId: string | null,
): DeleteAccountRole {
  const viewerRole = seats.find((seat) => seat.familyId === familyId)?.role ?? null;
  return seats.length > 1
    ? 'ambiguous'
    : viewerRole === 'co_parent'
      ? 'co_parent'
      : viewerRole === 'primary_parent'
        ? 'primary_parent'
        : 'scoped';
}
