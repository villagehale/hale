import Image from 'next/image';
import shoreNight from '~/assets/hale-shore-night.webp';
import quietCalendarPlate from '~/assets/quiet-calendar-plate.webp';
import { ChooserLink } from '~/components/chooser-link';
import { LandingScrollAnalytics } from '~/components/landing-scroll-analytics';
import { PricingSection } from '~/components/pricing-section';
import { SiteFooter } from '~/components/site-footer';
import { SiteHeader } from '~/components/site-header';
import { localeHref } from '~/i18n/navigation';
import type { Locale } from '~/i18n/routing';
import { SITE_TIMEZONE, getTranslator } from '~/i18n/server';
import { intakePrefill } from '~/lib/intake-prefill';
import { MUNICIPALITY_COUNT } from '~/lib/site/municipalities';
import { siteJsonLd } from '~/lib/site/structured-data';
import { CONTACT_EMAIL } from '~/lib/text-entry';
import { LandingMotion } from './landing-motion';

/** Derive the month in Toronto, then use UTC for date-only calendar arithmetic. */
function fridgeMonth(locale: Locale) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: SITE_TIMEZONE,
    year: 'numeric',
    month: 'numeric',
  }).formatToParts(new Date());
  const year = Number(parts.find((part) => part.type === 'year')?.value);
  const month = Number(parts.find((part) => part.type === 'month')?.value);
  const anchor = new Date(Date.UTC(year, month - 1, 1));
  return {
    name: new Intl.DateTimeFormat(locale, { month: 'long', timeZone: 'UTC' }).format(anchor),
    firstWeekday: anchor.getUTCDay(),
    days: new Date(Date.UTC(year, month, 0)).getUTCDate(),
    year,
  };
}

/** Main-based design draft. Server-rendered content; only the quiet follow-up cue needs JS. */
export function LandingV4({ locale, smsNumber }: { locale: Locale; smsNumber: string }) {
  const t = getTranslator(locale, 'LandingRedo');
  const original = getTranslator(locale, 'Landing');
  const common = getTranslator(locale, 'Common');
  const month = fridgeMonth(locale);
  const days = t.raw('weekdays') as string[];
  const activities = t.raw('activities') as string[];
  const secondSaturday = 8 + ((6 - month.firstWeekday + 7) % 7);
  const watchSteps = t.raw('watchSteps') as string[];
  const finds = original.raw('finds') as [
    {
      name: string;
      ageFit: string;
      when: string | null;
      sourceName: string;
    },
    ...{ name: string; ageFit: string; when: string | null; source: string }[],
  ];
  const find = finds[0];
  const beats = t.raw('beats') as { title: string; body: string }[];
  const steps = t.raw('steps') as { title: string; body: string }[];
  const threads = t.raw('threads') as {
    title: string;
    messages: { speaker: string; text: string; hale?: boolean }[];
  }[];
  const door = (placement: string, className: string) =>
    smsNumber ? (
      <ChooserLink
        locale={locale}
        placement={placement}
        className={className}
        smsNumber={smsNumber}
        prefill={intakePrefill(locale)}
      >
        {common('textHale')}
      </ChooserLink>
    ) : (
      <a href={`mailto:${CONTACT_EMAIL}`} className={className}>
        {common('emailHale')}
      </a>
    );

  return (
    <main id="main" tabIndex={-1} className="redo-landing">
      <LandingScrollAnalytics />
      <LandingMotion />
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: serialized in-repo structured data.
        dangerouslySetInnerHTML={{ __html: JSON.stringify(siteJsonLd(locale)) }}
      />
      <SiteHeader locale={locale} />

      <section className="shell redo-hero">
        <div className="redo-promise">
          <p className="redo-caption">{t('eyebrow')}</p>
          <h1>{t('headline')}</h1>
          <p className="redo-lede">{t('lede')}</p>
          {door('hero', 'btn-primary')}
          <p className="redo-caption redo-entry">{smsNumber ? t('entry') : t('emailEntry')}</p>
          <p className="redo-coverage">{original('coverageLine', { count: MUNICIPALITY_COUNT })}</p>
        </div>
        <div className="redo-calendar-story">
          <div className="redo-proof">
            <div className="redo-calendar-scene">
              <Image
                src={quietCalendarPlate}
                alt=""
                fill
                priority
                sizes="(max-width: 959px) 1px, (max-width: 1279px) 55vw, 680px"
                className="redo-scene-photo"
                aria-hidden="true"
              />
              <div
                className="redo-paper"
                role="img"
                aria-label={t('calendarLabel', { month: month.name })}
              >
                <div className="redo-calendar-heading">
                  <span>{month.name}</span>
                  <span>{month.year}</span>
                </div>
                <div className="redo-weekdays" aria-hidden="true">
                  {days.map((day) => (
                    <span key={day}>{day}</span>
                  ))}
                </div>
                <div className="redo-dates" aria-hidden="true">
                  {days.slice(0, month.firstWeekday).map((day) => (
                    <div key={day} className="redo-date redo-date-empty" />
                  ))}
                  {Array.from({ length: month.days }, (_, i) => {
                    const day = i + 1;
                    const index = (day - secondSaturday) / 7;
                    const activity = Number.isInteger(index) ? activities[index] : undefined;
                    return (
                      <div key={day} className="redo-date">
                        <span>{day}</span>
                        {activity && (
                          <span className="redo-event">
                            <span aria-hidden="true" />
                            {activity}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
              <div className="redo-watch-note">
                <p>{t('watchHeading')}</p>
                <ol className="redo-watch-steps">
                  {watchSteps.map((step) => (
                    <li className="redo-watch-step" key={step}>
                      {step}
                    </li>
                  ))}
                </ol>
              </div>
            </div>
          </div>
          <div className="redo-watch-marker" aria-hidden="true" />
          <div className="redo-watch-marker" aria-hidden="true" />
        </div>
      </section>

      <div className="shell redo-story">
        {beats.map((beat, index) => (
          <section className="redo-beat" key={beat.title}>
            <div className="redo-beat-copy">
              <span className="redo-number">0{index + 1}</span>
              <h2>{beat.title}</h2>
              <p>{beat.body}</p>
            </div>
            {index === 0 ? (
              <div className="redo-logistics">
                <div className="redo-find">
                  <span className="redo-caption">{t('findLabel')}</span>
                  <h3>{find.name}</h3>
                  <p>
                    {find.ageFit} · {find.when}
                  </p>
                  <span className="redo-caption">{find.sourceName}</span>
                </div>
                <ol className="redo-steps">
                  {steps.map((step) => (
                    <li key={step.title}>
                      <span>{step.title}</span>
                      <p>{step.body}</p>
                    </li>
                  ))}
                </ol>
              </div>
            ) : (
              <div className="redo-thread">
                <div className="redo-thread-heading">
                  <span>{t(`threads.${index - 1}.title`)}</span>
                  <span className="redo-caption">iMessage</span>
                </div>
                <p className="redo-caption">{t('example')}</p>
                {(threads[index - 1]?.messages ?? []).map((message) => (
                  <div
                    className={`redo-thread-message${message.hale ? ' redo-thread-hale' : ''}`}
                    key={message.text}
                  >
                    <span>{message.speaker}</span>
                    <p>{message.text}</p>
                  </div>
                ))}
              </div>
            )}
          </section>
        ))}
      </div>

      <section className="shell redo-trust">
        <h2>{`${original('privacyH2a')} ${original('privacyH2Accent')}`}</h2>
        <p>{original('privacyBody1')}</p>
        <a href={localeHref(locale, '/privacy')}>{original('privacyLink')}</a>
      </section>
      <PricingSection locale={locale} />
      <section className="shell redo-close">
        <div className="redo-shore-band">
          <Image
            src={shoreNight}
            alt=""
            fill
            sizes="100vw"
            className="redo-shore-art"
            aria-hidden="true"
          />
          <div className="redo-close-copy">
            <h2>{t('closing')}</h2>
            <p>{t('closingBody')}</p>
            {door('closing', 'btn-on-navy')}
          </div>
        </div>
      </section>
      <SiteFooter locale={locale} />
    </main>
  );
}
