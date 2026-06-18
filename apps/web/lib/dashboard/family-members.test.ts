import { describe, expect, it } from 'vitest';
import { toFamilyMembersView } from './family-members.js';

describe('toFamilyMembersView', () => {
  it('places the primary parent and co-parent into their slots', () => {
    const view = toFamilyMembersView([
      { name: 'Alex Rivera', email: 'alex@example.com', role: 'primary_parent' },
      { name: 'Sam Rivera', email: 'sam@example.com', role: 'co_parent' },
    ]);
    expect(view.primary).toEqual({
      name: 'Alex Rivera',
      email: 'alex@example.com',
      role: 'primary_parent',
    });
    expect(view.coParent).toEqual({
      name: 'Sam Rivera',
      email: 'sam@example.com',
      role: 'co_parent',
    });
  });

  it('leaves the co-parent slot null for a single-parent household', () => {
    const view = toFamilyMembersView([
      { name: null, email: 'solo@example.com', role: 'primary_parent' },
    ]);
    expect(view.primary).toEqual({ name: null, email: 'solo@example.com', role: 'primary_parent' });
    expect(view.coParent).toBeNull();
  });

  it('excludes extended and service members from the parent slots', () => {
    const view = toFamilyMembersView([
      { name: 'Grandma', email: 'gran@example.com', role: 'extended' },
      { name: 'Sitter', email: 'sitter@example.com', role: 'service' },
    ]);
    expect(view.primary).toBeNull();
    expect(view.coParent).toBeNull();
  });

  it('returns both slots null for an empty family', () => {
    expect(toFamilyMembersView([])).toEqual({ primary: null, coParent: null });
  });
});
