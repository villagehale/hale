import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { resolveAdminGate } from '~/lib/admin/gate';
import './admin.css';

// The gate reads the live session + env allowlist on every request — never
// bake an admin decision at build time.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Hale / admin',
  robots: { index: false, follow: false },
};

/**
 * The founder-only door. Every non-admin arm of the gate — no session, no
 * allowlisted verified channel, ADMIN_PHONES unset — answers 404, never a
 * redirect that advertises the route (the middleware 404s the session-less
 * case at the Edge the same way).
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const gate = await resolveAdminGate();
  if (gate.status !== 'admin') {
    notFound();
  }
  return <div data-surface="admin">{children}</div>;
}
