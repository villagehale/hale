import { PLAN_DISPLAY, PLAN_TIERS_ORDERED, formatPlanPrice } from '@hale/types';
import { Check } from 'lucide-react';
import type { Locale } from '~/i18n/routing';
import { DesignCta } from './shared';

export function DesignPricing({
  locale = 'en',
  showHeading = true,
}: { locale?: Locale; showHeading?: boolean }) {
  return (
    <section className="hs hs-wash-c" id="pricing">
      <div className="hs-wrap">
        {showHeading && (
          <div className="hs-head">
            <p className="hs-eyebrow">Pricing</p>
            <h2 className="hs-h2">Free, with unlimited chat.</h2>
            <p className="hs-lede">
              Everything Hale does today is free: the finding, the watching, the reminders and the
              group chats. Plus and Max are on the way.
            </p>
          </div>
        )}
        <div className="hs-tiers">
          {PLAN_TIERS_ORDERED.map((tier, i) => {
            const plan = PLAN_DISPLAY[tier];
            const isFree = tier === 'free';
            return (
              <article key={tier} className={`hs-tier t-${tier === 'family' ? 'max' : tier}`}>
                <div className="hs-tier-head">
                  <span className="hs-tier-name">{plan.name}</span>
                  <span className="hs-tier-num">0{i + 1}</span>
                </div>
                <h3>{isFree ? '$0 CAD/mo' : formatPlanPrice(tier, 'monthly')}</h3>
                <p className="hs-tier-meta">
                  {isFree
                    ? 'Free for every family'
                    : `or ${formatPlanPrice(tier, 'annual')}, about three months free`}
                </p>
                <p className="hs-tier-body">{plan.tagline}</p>
                <ul className="hs-checks">
                  {plan.features.map((feature) => (
                    <li key={feature}>
                      <Check size={16} aria-hidden="true" />
                      <span>{feature}</span>
                    </li>
                  ))}
                </ul>
                <div className="hs-tier-cta">
                  {isFree ? (
                    <DesignCta locale={locale} className="hs-btn-primary">
                      Text Hale
                    </DesignCta>
                  ) : (
                    <button type="button" disabled className="hs-btn-soon">
                      Coming soon
                    </button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
        <p className="hs-meta hs-foot-note">Only Free is available today.</p>
        {!showHeading && (
          <div className="hs-glass sp-card sp-founding" style={{ marginTop: 'var(--s7)' }}>
            <div className="sp-person">
              <span className="hs-ic">
                <svg
                  viewBox="0 0 20 20"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M10 16.5s-6-3.6-6-8.1A3.4 3.4 0 0 1 10 6.3a3.4 3.4 0 0 1 6 2.1c0 4.5-6 8.1-6 8.1z" />
                </svg>
              </span>
              <div>
                <h3 className="hs-h3">Founding families keep their rate.</h3>
                <p className="hs-p">
                  The first 100 families get a permanent founding badge, and first access when Plus
                  and Max open.
                </p>
              </div>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
