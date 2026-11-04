import { describe, expect, it } from 'vitest';
import { deleteAccountRole } from './delete-role';

/**
 * Which erasure the Delete button may offer, from the viewer's seats. The cases are
 * the DeleteAccountRole contract (delete-account-button.tsx): more than one seat is
 * ambiguous (the route 409s), a lone co-parent seat is a departure, a named caregiver
 * has no erasure of its own, and a primary parent (or a viewer with no seat yet)
 * erases the family.
 */

const FAMILY = 'family-a';

describe('deleteAccountRole', () => {
  it('reads two seats as ambiguous, whichever roles they are', () => {
    expect(
      deleteAccountRole(
        [
          { familyId: FAMILY, role: 'primary_parent' },
          { familyId: 'family-b', role: 'co_parent' },
        ],
        FAMILY,
      ),
    ).toBe('ambiguous');
  });

  it('reads one co-parent seat in this family as a departure', () => {
    expect(deleteAccountRole([{ familyId: FAMILY, role: 'co_parent' }], FAMILY)).toBe('co_parent');
  });

  it('reads one primary-parent seat as the family erasure', () => {
    expect(deleteAccountRole([{ familyId: FAMILY, role: 'primary_parent' }], FAMILY)).toBe(
      'primary_parent',
    );
  });

  it('keeps a viewer with no seat on the family erasure, as the settings page always has', () => {
    expect(deleteAccountRole([], FAMILY)).toBe('primary_parent');
  });

  it('reads a named caregiver seat as scoped', () => {
    expect(deleteAccountRole([{ familyId: FAMILY, role: 'nanny' }], FAMILY)).toBe('scoped');
  });
});
