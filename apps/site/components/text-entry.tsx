import { QrCode } from '~/components/qr-code';
import { TextEntryAnalytics } from '~/components/text-entry-analytics';
import { EmailCta } from '~/components/email-cta';
import { CopyNumberButton } from '~/components/copy-number';
import { CONTACT_EMAIL, buildSmsBody, buildSmsHref } from '~/lib/text-entry';

/**
 * The /text entry surface (VIL-240 · M5) — what a QR card at an EarlyON drop-in,
 * a swim lobby, or a daycare foyer opens. Persona-led and deliberately thin: one
 * thing to do, no account, no form, no way back into the funnel.
 *
 * Two honest states, driven by whether the SMS number is provisioned:
 *   live  → "Text me" opens the composer pre-filled; the number and a QR of the
 *           same sms: URI cover desktop, where sms: links do nothing.
 *   unset → email is the only path, and the page says the number is coming.
 *           Never a dead sms: link. (Today's state.)
 */
export function TextEntry({ source, smsNumber }: { source: string | null; smsNumber: string }) {
  const smsHref = smsNumber ? buildSmsHref(smsNumber, source) : null;

  return (
    <main
      id="main"
      tabIndex={-1}
      className="shell flex min-h-dvh max-w-[44rem] flex-col justify-center py-16 sm:py-20"
    >
      <TextEntryAnalytics source={source} />

      <div className="rise rise-1">
        <span className="font-serif text-[1.35rem] font-semibold leading-none text-spruce">
          Hale
        </span>
        <h1 className="mt-6 text-[clamp(2rem,6.5vw,3.25rem)]">
          Hi, I’m Hale — your family’s quiet chief of staff.
        </h1>
        <p className="mt-6 text-lg text-slate-green" style={{ lineHeight: 1.6 }}>
          I keep watch over your week — registrations, programs, checkups, weather — and text you
          before things matter.
        </p>
      </div>

      {smsHref ? (
        <div className="mt-10 rise rise-2">
          <a href={smsHref} className="btn-primary">
            Text me
          </a>
          <p className="meta mt-4">
            {source
              ? `Your message is already written — “${buildSmsBody(source)}”. The tag just tells me which spot sent you.`
              : 'Your message is already written. You send it; I never text first.'}
          </p>

          <div className="card mt-8 flex flex-col gap-6 sm:flex-row sm:items-center">
            <QrCode value={smsHref} />
            <div>
              <span className="eyebrow">On a laptop?</span>
              <p className="mt-2">
                <CopyNumberButton
                  number={smsNumber}
                  className="link font-medium"
                  label="Copy my number"
                />
              </p>
              <p className="meta mt-2">
                Scan the code with your phone’s camera, or copy the number and text it from your
                phone. Standard message rates apply; reply STOP any time.
              </p>
            </div>
          </div>
        </div>
      ) : (
        <div className="mt-10 rise rise-2">
          <EmailCta email={CONTACT_EMAIL} buttonClassName="btn-primary" />
          <p className="meta mt-4">The number’s coming — this page isn’t announced yet.</p>
        </div>
      )}

      <p className="meta mt-14 rise rise-3">
        Village Hale Technologies Inc., Georgetown, Ontario. Your data stays in Canada —{' '}
        <a href="/privacy" className="link">
          privacy policy
        </a>
        .
      </p>
    </main>
  );
}
