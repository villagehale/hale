import type { ReactNode } from 'react';

interface ReadingColumnProps {
  children: ReactNode;
  /** Inset by extra vertical rhythm; default true. */
  inset?: boolean;
  className?: string;
}

export function ReadingColumn({ children, inset = true, className }: ReadingColumnProps) {
  return (
    <main
      className={`reading-column ${inset ? 'py-24 sm:py-32' : ''} ${className ?? ''}`.trim()}
    >
      {children}
    </main>
  );
}
