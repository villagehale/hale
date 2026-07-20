import { LogoMark } from '~/components/logo-mark';
import { APP_URL } from '~/lib/app-url';

/**
 * The marketing footer: a raised white card on the warm page. Real navigation,
 * not decoration. Legal links point at the product app's live Privacy and
 * Terms pages. No social icon row — the site has no social accounts to link, so
 * none are invented. No third-party credit line.
 */

const PRODUCT = [
  { label: 'Features', href: '/#features' },
  { label: 'FAQ', href: '/#faq' },
  { label: 'Activities', href: '/activities' },
  { label: 'Milestones', href: '/milestones' },
] as const;

const RESOURCES = [
  { label: 'Answers', href: '/answers' },
  { label: 'About', href: '/about' },
  { label: 'Contact', href: '/contact' },
] as const;

const LEGAL = [
  { label: 'Privacy policy', href: `${APP_URL}/privacy` },
  { label: 'Terms of service', href: `${APP_URL}/terms` },
] as const;

const COLUMNS = [
  { heading: 'Product', links: PRODUCT },
  { heading: 'Resources', links: RESOURCES },
  { heading: 'Legal', links: LEGAL },
] as const;

export function SiteFooter() {
  return (
    <div className="p-4 md:p-8 lg:p-12">
      <footer className="mx-auto max-w-[1100px] rounded-[28px] border border-[#F0F2F6] bg-white px-6 py-10 shadow-[0_20px_40px_-15px_rgba(0,0,0,0.03)] md:px-12 md:py-12 lg:px-[72px] lg:py-[56px]">
        <div className="mb-12 flex flex-col justify-between gap-12 lg:flex-row lg:gap-8">
          <div className="lg:w-[40%]">
            <a href="/#about" className="flex items-center gap-2.5" aria-label="Hale, home">
              <LogoMark size={30} />
              <span className="font-serif text-[19px] font-semibold tracking-tight text-[#17294A]">
                Hale
              </span>
            </a>
            <p className="mb-4 mt-5 max-w-[340px] text-[13px] leading-[1.6] text-[#5C6B87]">
              Hale is the quiet helper for busy families — always prepared, never acting without you.
            </p>
            <p className="text-[12px] leading-[1.6] text-[#8B95A9]">
              Hale <span className="font-mono">/HAH-leh/</span> — Hawaiian for home.
            </p>
          </div>

          <nav
            aria-label="Footer"
            className="grid grid-cols-2 gap-8 md:grid-cols-3 md:gap-4 lg:w-[50%]"
          >
            {COLUMNS.map((column) => (
              <div key={column.heading}>
                <h2 className="mb-5 text-[14px] font-semibold text-[#17294A]">{column.heading}</h2>
                <ul className="flex flex-col gap-3.5">
                  {column.links.map((item) => (
                    <li key={item.label}>
                      <a
                        href={item.href}
                        className="text-[13px] text-[#5C6B87] transition-colors hover:text-[#17294A]"
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

        <hr className="mb-6 border-[#F0F2F6]" />

        <div className="flex flex-col-reverse items-start justify-between gap-4 md:flex-row md:items-center">
          <p className="text-[13px] text-[#8B95A9]">© 2026 Hale. All rights reserved.</p>
          <div className="flex flex-wrap gap-6">
            {LEGAL.map((item) => (
              <a
                key={item.label}
                href={item.href}
                className="text-[13px] text-[#5C6B87] underline decoration-[#E4E7EE] underline-offset-[4px] transition-colors hover:text-[#17294A] hover:decoration-[#17294A]"
              >
                {item.label}
              </a>
            ))}
          </div>
        </div>
      </footer>
    </div>
  );
}
