import Link from 'next/link';
import type { Route } from 'next';
import type { ReactNode } from 'react';

type CardProps = {
  children: ReactNode;
  className?: string;
};

/**
 * Surface card. Static by default; pass `href` to make the whole card a link.
 * The interactive variant gets cursor-pointer, a hover lift, and a visible
 * focus ring (all token-driven in globals.css). A static card has none of
 * those, so it never lies about being clickable.
 */
export function Card({
  children,
  className,
  href,
}: CardProps & { href?: Route }) {
  if (href) {
    return (
      <Link href={href} className={`card card-interactive${className ? ` ${className}` : ''}`}>
        {children}
      </Link>
    );
  }

  return <div className={`card${className ? ` ${className}` : ''}`}>{children}</div>;
}
