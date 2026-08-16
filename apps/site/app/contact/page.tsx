import type { Metadata } from 'next';
import { SeaTurtle } from '~/components/illos';
import { SiteFooter } from '~/components/site-footer';
import { SiteHeader } from '~/components/site-header';
import { WordsPullUp } from '~/components/words-pull-up';

export const metadata: Metadata = {
  title: 'Contact · Hale',
  description:
    'Reach the team behind Hale. Email aloha@villagehale.com for anything; privacy@villagehale.com for privacy and data requests.',
};

const CHANNELS = [
  {
    eyebrow: 'Anything at all',
    line: 'Questions, feedback, a class your village should know about — we read every note.',
    email: 'aloha@villagehale.com',
  },
  {
    eyebrow: 'Privacy & your data',
    line: 'Access, correction, or deletion requests, and anything about how we handle your family’s data.',
    email: 'privacy@villagehale.com',
  },
] as const;

export default function ContactPage() {
  return (
    <main id="main" tabIndex={-1} className="relative">
      <SiteHeader />

      {/* One centred column, and nothing beside it. A contact page has exactly one
          job, and a two-column hero gives the eye somewhere else to go. */}
      <section className="shell pt-14 sm:pt-20 pb-16 lg:pb-24">
        <div className="mx-auto flex max-w-xl flex-col items-center text-center">
          <SeaTurtle age="adult" style={{ width: 'clamp(96px, 16vw, 132px)', height: 'auto' }} />
          <span className="eyebrow mt-8">Contact</span>
          <WordsPullUp
            className="mt-3"
            segments={[{ text: 'Say' }, { text: 'hello.', accent: true }]}
          />
          <p
            className="mt-6 text-lg"
            style={{ color: 'var(--color-slate-green)', lineHeight: 1.6 }}
          >
            We’re small, parent-built, and early — so a real person reads what you send. The fastest
            way to reach us is email.
          </p>
          <a href="mailto:aloha@villagehale.com" className="btn-primary mt-8">
            Email aloha@villagehale.com
          </a>
        </div>
      </section>

      <div className="band-cream grain">
        <section className="shell py-16 lg:py-24">
          <div className="mx-auto grid max-w-3xl grid-cols-1 gap-6 md:grid-cols-2 lg:gap-8">
            {CHANNELS.map((channel) => (
              <div key={channel.email} className="glass-panel flex flex-col gap-4 p-6 sm:p-7">
                <span className="eyebrow">{channel.eyebrow}</span>
                <p style={{ color: 'var(--color-slate-green)', lineHeight: 1.55 }}>
                  {channel.line}
                </p>
                <a href={`mailto:${channel.email}`} className="link mt-auto self-start">
                  {channel.email}
                </a>
              </div>
            ))}
          </div>
          <p className="meta mx-auto mt-8 max-w-3xl text-slate-green">
            Hale is built by Village Hale Technologies Inc., Georgetown, Ontario, Canada.
          </p>
        </section>
      </div>

      <SiteFooter />
    </main>
  );
}
