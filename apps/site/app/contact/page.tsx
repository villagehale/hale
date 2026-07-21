import type { Metadata } from 'next';
import { SeaTurtle } from '~/components/illos';
import { SiteFooter } from '~/components/site-footer';
import { SiteHeader } from '~/components/site-header';

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

      <section className="shell pt-10 sm:pt-16 pb-16 lg:pb-24">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-12 lg:gap-x-16 items-center">
          <div className="lg:col-span-7 rise rise-1">
            <span className="eyebrow">Contact</span>
            <h1 className="mt-3">
              Say <span className="accent">hello</span>.
            </h1>
            <p
              className="mt-6 text-lg"
              style={{ color: 'var(--color-slate-green)', lineHeight: 1.6 }}
            >
              We’re small, parent-built, and early — so a real person reads what you send. The
              fastest way to reach us is email.
            </p>
            <div className="mt-8">
              <a href="mailto:aloha@villagehale.com" className="btn-primary">
                Email aloha@villagehale.com
              </a>
            </div>
          </div>

          <div className="lg:col-span-5 flex justify-center rise rise-2">
            <SeaTurtle age="adult" style={{ width: 'clamp(140px, 28vw, 220px)', height: 'auto' }} />
          </div>
        </div>
      </section>

      <div className="band-cream">
        <section className="shell py-16 lg:py-24">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 lg:gap-8">
            {CHANNELS.map((channel, i) => (
              <div key={channel.email} className={`card flex flex-col gap-4 rise rise-${i + 1}`}>
                <span className="eyebrow">{channel.eyebrow}</span>
                <p style={{ color: 'var(--color-slate-green)', lineHeight: 1.55 }}>{channel.line}</p>
                <a href={`mailto:${channel.email}`} className="link mt-auto self-start">
                  {channel.email}
                </a>
              </div>
            ))}
          </div>
          <p className="meta mt-6">
            Hale is built by Village Hale Technologies Inc., Georgetown, Ontario, Canada.
          </p>
        </section>
      </div>

      <SiteFooter />
    </main>
  );
}
