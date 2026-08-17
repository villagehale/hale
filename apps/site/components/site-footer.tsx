import { FooterThemeSwitch } from '~/components/landing/v4/theme-switch';
import { LogoMark } from '~/components/logo-mark';
import { APP_URL } from '~/lib/app-url';

/**
 * The marketing footer — ONE foot, on the homepage and on every subpage.
 *
 * The landing's foot said the name out loud and named the company; the subpages'
 * carried the real navigation. This is both: the brand block on the left with
 * the pronunciation and the Canadian company line, the two link columns beside
 * it, and the legal pair in the bottom bar. Legal lives ONLY in that bar — a
 * Legal column would duplicate it — and points at this site's own policy pages,
 * since D20 moved them here and the app's old routes permanently redirect back.
 *
 * No "Features" column: the link pointed at the homepage. No social row: the
 * site has no accounts to link, so none are invented.
 *
 * Flat on the page rather than a raised white card. The card was a light-only
 * device — `bg-white` is not a theme — and a footer that has to work on the
 * navy ground earns its separation from a hairline instead.
 */

const PRODUCT = [
  { label: 'Pricing', href: '/pricing' },
  { label: 'FAQ', href: '/faq' },
  { label: 'Activities', href: '/activities' },
] as const;

const RESOURCES = [
  { label: 'Parenting guides', href: '/answers' },
  { label: 'About', href: '/about' },
  { label: 'Contact', href: '/contact' },
  { label: 'Sign in', href: `${APP_URL}/sign-in` },
] as const;

const LEGAL = [
  { label: 'Privacy policy', href: '/privacy' },
  { label: 'Terms of service', href: '/terms' },
] as const;

const COLUMNS = [
  { heading: 'Product', links: PRODUCT },
  { heading: 'Resources', links: RESOURCES },
] as const;

export function SiteFooter() {
  return (
    <footer className="border-t border-rule">
      <div className="shell py-12 lg:py-16">
        <div className="flex flex-col justify-between gap-12 lg:flex-row lg:gap-16">
          <div className="lg:max-w-[22rem]">
            <a href="/" className="flex items-center gap-2.5" aria-label="Hale, home">
              <LogoMark size={28} />
              <span className="font-serif text-[1.2rem] font-semibold leading-none text-spruce">
                Hale
              </span>
            </a>
            <p className="mt-5 text-[13px] leading-[1.6] text-slate-green">
              Hale is the quiet helper for busy families — always prepared, never acting without
              you.
            </p>
            {/* The name, said out loud. It carries the whole brand — Hawaiian for
                home, a honu for a mark, aloha@ for an address. */}
            <p className="mt-4 text-[12px] leading-[1.6] text-slate-green">
              Hale <span className="font-mono">/HAH-leh/</span> — Hawaiian for home.
            </p>
            <div className="mt-6">
              <FooterThemeSwitch />
            </div>
          </div>

          <nav aria-label="Footer" className="grid grid-cols-2 gap-8 md:gap-12 lg:w-[38%]">
            {COLUMNS.map((column) => (
              <div key={column.heading}>
                <h2 className="mb-5 text-[14px] font-semibold text-spruce">{column.heading}</h2>
                <ul className="flex flex-col gap-3.5">
                  {column.links.map((item) => (
                    <li key={item.label}>
                      <a
                        href={item.href}
                        className="text-[13px] text-slate-green transition-colors hover:text-spruce"
                      >
                        {item.label}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </nav>
        </div>

        <hr className="mb-6 mt-12 border-hair" />

        <div className="flex flex-col-reverse items-start justify-between gap-4 md:flex-row md:items-center">
          <div className="text-[13px] leading-[1.6] text-slate-green">
            <p>© {new Date().getFullYear()} Hale. All rights reserved.</p>
            <p className="mt-1">
              Village Hale Technologies Inc., Georgetown, Ontario. Your data stays in Canada.
            </p>
          </div>
          <div className="flex flex-wrap gap-6">
            {LEGAL.map((item) => (
              <a
                key={item.label}
                href={item.href}
                className="text-[13px] text-slate-green underline decoration-rule underline-offset-[4px] transition-colors hover:text-spruce hover:decoration-current"
              >
                {item.label}
              </a>
            ))}
          </div>
        </div>
      </div>
    </footer>
  );
}
