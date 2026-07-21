import { describe, expect, it, vi } from 'vitest';

// app-shell statically imports usePathname; the hook is never called here (we test
// the pure drawerDialogProps contract), but the module-level import must resolve.
vi.mock('next/navigation', () => ({ usePathname: () => '/' }));

import { drawerDialogProps } from './app-shell';

/**
 * The off-canvas nav is the SAME `.sidebar-dock` element that is the desktop
 * persistent sidebar, so it must announce itself as a modal dialog ONLY while open.
 * Expected props are the WAI dialog contract (role + aria-modal + a name), derived
 * from that rule — not read back from the component.
 */
describe('drawerDialogProps', () => {
  it('exposes the labelled modal-dialog props while the drawer is open', () => {
    expect(drawerDialogProps(true)).toEqual({
      role: 'dialog',
      'aria-modal': true,
      'aria-label': 'Main menu',
    });
  });

  it('exposes no dialog role when closed (it is just the desktop sidebar then)', () => {
    expect(drawerDialogProps(false)).toEqual({});
  });
});
