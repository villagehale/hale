import Link from 'next/link';
import { Wordmark } from '~/components/hale/connect/wordmark';
import { signOutAction } from '~/lib/auth-actions';
import './passport.css';

const LINKS = [
  { href: '/home', label: 'Home', icon: 'home' },
  { href: '/messages', label: 'Messages', icon: 'messages' },
  { href: '/family', label: 'Family', icon: 'family' },
  { href: '/settings', label: 'Settings', icon: 'settings' },
] as const;

export function PassportFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="pp-portal" data-testid="interest-passport">
      <aside className="pp-side">
        <Link className="pp-brand" href="/home" aria-label="Hale, home">
          <img src="/passport/hale-logo.jpeg" alt="" />
          <Wordmark className="pp-word" />
        </Link>
        <nav className="pp-nav" aria-label="Primary">
          {LINKS.map((link) => (
            <Link key={link.href} href={link.href} className={link.href === '/family' ? 'on' : ''}>
              <NavIcon name={link.icon} />
              <span>{link.label}</span>
            </Link>
          ))}
        </nav>
        <form className="pp-signout" action={signOutAction}>
          <button className="pp-sign" type="submit">
            <NavIcon name="signout" />
            <span>Sign out</span>
          </button>
        </form>
      </aside>
      <div className="pp-stage">
        <div className="pp-main">{children}</div>
      </div>
      <nav className="pp-tab" aria-label="Primary">
        {LINKS.map((link) => (
          <Link key={link.href} href={link.href} className={link.href === '/family' ? 'on' : ''}>
            <NavIcon name={link.icon} />
            <span>{link.label}</span>
          </Link>
        ))}
      </nav>
    </div>
  );
}

function NavIcon({ name }: { name: 'home' | 'messages' | 'family' | 'settings' | 'signout' }) {
  const paths: Record<typeof name, string> = {
    home: 'M3.5 9 10 3.5 16.5 9v7a1 1 0 0 1-1 1h-3.5v-4.5h-4V17H4.5a1 1 0 0 1-1-1z',
    messages:
      'M10 3.5c3.9 0 7 2.6 7 5.8s-3.1 5.8-7 5.8c-.8 0-1.6-.1-2.3-.3L4 16.5l1-3C3.8 12.4 3 10.9 3 9.3 3 6.1 6.1 3.5 10 3.5z',
    family: '',
    settings: '',
    signout: 'M8 4H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3M12 6.5 15.5 10 12 13.5M15.5 10H8',
  };
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {name === 'family' ? (
        <>
          <circle cx="7.5" cy="7" r="2.8" />
          <path d="M2.5 16.2c.6-2.6 2.6-4.2 5-4.2s4.4 1.6 5 4.2" />
          <circle cx="14" cy="7.6" r="2.2" />
          <path d="M13.6 12.1c2 .1 3.4 1.5 3.9 3.6" />
        </>
      ) : name === 'settings' ? (
        <>
          <circle cx="10" cy="10" r="2.6" />
          <path d="M10 2.8v2M10 15.2v2M2.8 10h2M15.2 10h2M4.9 4.9l1.4 1.4M13.7 13.7l1.4 1.4M4.9 15.1l1.4-1.4M13.7 6.3l1.4-1.4" />
        </>
      ) : (
        <path d={paths[name]} />
      )}
    </svg>
  );
}
