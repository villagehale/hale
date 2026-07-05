import { LogoMark } from '~/components/logo-mark';
import { APP_URL } from '~/lib/app-url';

const PRODUCT = [
  { label: 'How it works', href: '/#how' },
  { label: 'Pricing', href: '/#pricing' },
] as const;

const COMPANY = [
  { label: 'About', href: '/about' },
  { label: 'Contact', href: '/contact' },
] as const;

const LEGAL = [
  { label: 'Privacy', href: `${APP_URL}/privacy` },
  { label: 'Terms', href: `${APP_URL}/terms` },
] as const;

const RESOURCES = [
  { label: 'Activities by city', href: '/activities' },
  { label: 'Milestones', href: '/milestones' },
  { label: 'Answers', href: '/answers' },
  { label: 'FAQ', href: '/faq' },
] as const;

const COLUMNS = [
  { heading: 'Product', links: PRODUCT },
  { heading: 'Resources', links: RESOURCES },
  { heading: 'Company', links: COMPANY },
  { heading: 'Legal', links: LEGAL },
] as const;

/**
 * The marketing footer: the village in miniature. The brand block carries the
 * thesis; three columns (Product / Company / Legal) are the site map — real
 * navigation, not decoration. Quiet by design — the hero scene is the page's
 * one signature; here a single hairline separates it from the page and the
 * existing tone-set type roles (eyebrow, link, meta) carry it.
 */
export function SiteFooter() {
  return (
    <footer
      className="shell pt-16 pb-12"
      style={{ borderTop: '1px solid var(--color-rule)' }}
    >
      <div className="grid grid-cols-1 gap-y-12 lg:grid-cols-12 lg:gap-x-16">
        <div className="lg:col-span-5">
          <a href="/#top" className="flex items-center gap-3" aria-label="Hale, home">
            <LogoMark size={32} />
            <span className="font-display text-xl leading-none font-semibold">Hale</span>
          </a>
          <p className="meta mt-4 max-w-xs" style={{ lineHeight: 1.55 }}>
            The trusted parent network for every stage of childhood — the village,
            online, growing with every family that joins.
          </p>
        </div>

        <nav
          aria-label="Footer"
          className="grid grid-cols-2 gap-x-8 gap-y-10 sm:grid-cols-3 lg:col-span-7"
        >
          {COLUMNS.map((column) => (
            <div key={column.heading} className="flex flex-col gap-4">
              <span className="eyebrow">{column.heading}</span>
              <ul className="flex flex-col gap-3">
                {column.links.map((item) => (
                  <li key={item.label}>
                    <a href={item.href} className="link">
                      {item.label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
      </div>

      <div
        className="mt-16 flex flex-wrap items-center justify-between gap-4 pt-8"
        style={{ borderTop: '1px solid var(--color-rule)' }}
      >
        <p className="meta">Hale · Toronto · Canada</p>
        <p className="meta">© {new Date().getFullYear()} Village Hale Technologies Inc.</p>
      </div>
    </footer>
  );
}
