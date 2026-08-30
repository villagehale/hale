import type { ReactNode } from 'react';

/**
 * The uniform card anatomy every panel shares: eyebrow → content → footer
 * links. The footer renders in EVERY state — a dead provider loses its data,
 * never its console link.
 */
export interface PanelLink {
  label: string;
  href: string;
}

export function Panel({
  eyebrow,
  links,
  children,
}: {
  eyebrow: string;
  links?: PanelLink[];
  children: ReactNode;
}) {
  return (
    <section className="adm-panel">
      <h2 className="adm-eyebrow">{eyebrow}</h2>
      <div className="adm-panel-body">{children}</div>
      {links && links.length > 0 ? (
        <footer className="adm-panel-foot">
          {links.map((link) => (
            <a key={link.href} href={link.href} target="_blank" rel="noreferrer">
              {link.label} ↗
            </a>
          ))}
        </footer>
      ) : null}
    </section>
  );
}

export function PanelSkeleton() {
  return <div className="adm-skeleton animate-pulse" aria-hidden="true" />;
}
