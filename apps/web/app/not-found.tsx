import type { Metadata } from 'next';

/**
 * One title, from metadata. The default Next 404 also printed an inline
 * `<title>`, so the document had that tag plus the layout title.
 */
export const metadata: Metadata = { title: 'Page not found' };

export default function NotFound() {
  return (
    <main id="main" className="min-h-screen flex items-center justify-center px-6 py-24">
      <h1 className="font-display text-[2rem]">Page not found</h1>
    </main>
  );
}
