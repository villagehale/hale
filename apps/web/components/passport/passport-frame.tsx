import Link from 'next/link';
import { signOutAction } from '~/lib/auth-actions';
import './passport.css';

const LINKS = [
  { href: '/home', label: 'Home' },
  { href: '/messages', label: 'Messages' },
  { href: '/family', label: 'Family' },
  { href: '/settings', label: 'Settings' },
];

export function PassportFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="pp-portal" data-testid="interest-passport">
      <aside className="pp-side">
        <div className="pp-brand">
          <img src="/passport/hale-logo.jpeg" alt="" />
          Hale
        </div>
        <nav className="pp-nav" aria-label="Primary">
          {LINKS.map((link) => (
            <Link key={link.href} href={link.href} className={link.href === '/family' ? 'on' : ''}>
              {link.label}
            </Link>
          ))}
        </nav>
        <form action={signOutAction}>
          <button className="pp-sign" type="submit">
            Sign out
          </button>
        </form>
      </aside>
      <div className="pp-stage">
        <div className="pp-main">{children}</div>
      </div>
      <nav className="pp-tab" aria-label="Primary">
        {LINKS.map((link) => (
          <Link key={link.href} href={link.href} className={link.href === '/family' ? 'on' : ''}>
            {link.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}
