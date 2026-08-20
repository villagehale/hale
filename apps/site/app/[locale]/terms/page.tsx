import type { Metadata } from 'next';
import { LegalLayout, type LegalSection, LegalSectionBlock } from '~/components/legal-layout';
import { buildAlternates } from '~/i18n/metadata';
import { localeHref } from '~/i18n/navigation';
import type { Locale } from '~/i18n/routing';

/**
 * villagehale.com/terms — the canonical home for the Terms of Service
 * (VIL-250 · M14 · B-legal). A legal-copy change is its own change, never bundled
 * with a design move.
 *
 * 2026-08-19: the terms were written before the messaging-first pivot and before
 * dual auth, and had drifted from the product — they said sign-in was Google-only,
 * described a "passive, event-driven assistant", and never mentioned the text
 * channel that is now the whole product. That revision was FACTUAL ONLY.
 *
 * 2026-08-20: STRUCTURAL. The document had honest facts and no architecture — no
 * licence grant, no ownership clause, the Privacy Policy linked but never
 * incorporated, no third-party disclaimer for the municipal programs Hale points
 * families at, no survival list, and Ontario law named with no Ontario forum to
 * hear a dispute. The section architecture here is adapted from the CC0
 * General-Legal "Terms of Use" template (github.com/General-Legal/legal-templates,
 * CC0 1.0 — no attribution owed, recorded because provenance matters on a legal
 * surface). Only the scaffold was taken. Every US artifact the template ships was
 * dropped rather than translated: the JAMS and DecisionLayer arbitration clauses,
 * the jury and class-action waivers, the California Civil Code §1542 release, the
 * five state-specific notices and the US export-control clause. Ontario law, an
 * Ontario forum, and the consumer-protection carve-out replace them.
 *
 * What is NOT here, deliberately, and belongs to counsel rather than to a
 * revision: the template's indemnity from the user, its monetary liability cap
 * (its $50 USD floor is an invented number, and inventing one here would be
 * worse than omitting the cap), and its WCAG accessibility commitment, which we
 * have not measured and will not claim. Counsel should read the diff.
 *
 * app.villagehale.com/terms is now a permanent 308 here (VIL-256) — kept forever,
 * because the mobile app, sent emails and stored consent records all name the old
 * URL and none of those can be rewritten. This is the only copy now; it stays
 * noindexed while the marketing pivot is dark, and is reachable by direct link.
 */

const TITLE = 'Terms of Service · Hale';
const DESCRIPTION =
  'The terms that govern your use of Hale — what Hale is, who can use it, the approval model, and the limits of an AI assistant.';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: Locale }>;
}): Promise<Metadata> {
  const { locale } = await params;
  return {
    title: TITLE,
    description: DESCRIPTION,
    alternates: buildAlternates(locale, '/terms'),
    robots: { index: false, follow: false },
  };
}

const SECTIONS: LegalSection[] = [
  { id: 'what-hale-is', title: 'What Hale is' },
  { id: 'eligibility', title: 'Who can use Hale' },
  { id: 'privacy', title: 'Privacy' },
  { id: 'text-messages', title: 'Text messages, STOP, and carrier rates' },
  { id: 'accounts', title: 'Your account and security' },
  { id: 'licence', title: 'Your licence to use Hale' },
  { id: 'acceptable-use', title: 'Acceptable use' },
  { id: 'approval-model', title: 'How Hale works: you decide' },
  { id: 'ownership', title: 'Ownership, your content, and feedback' },
  { id: 'third-party', title: 'Programs, venues, and tools run by others' },
  { id: 'ai-disclaimer', title: 'AI disclaimer — not professional advice' },
  { id: 'no-warranty', title: 'Accuracy and no warranty' },
  { id: 'liability', title: 'Limitation of liability' },
  { id: 'changes-to-hale', title: 'Changes to Hale' },
  { id: 'termination', title: 'Suspension and termination' },
  { id: 'changes', title: 'Changes to these terms' },
  { id: 'general', title: 'General' },
  { id: 'governing-law', title: 'Governing law and where disputes are heard' },
  { id: 'contact', title: 'How to reach us' },
];

export default async function TermsPage({ params }: { params: Promise<{ locale: Locale }> }) {
  const { locale } = await params;
  return (
    <LegalLayout
      locale={locale}
      title="Terms of Service"
      lastUpdatedIso="2026-08-20"
      intro={
        <p>
          These terms are an agreement between you and Village Hale Technologies Inc.
          (&ldquo;Hale,&rdquo; &ldquo;we,&rdquo; or &ldquo;us&rdquo;), a company incorporated in
          Ontario, Canada. By texting Hale, creating an account, or otherwise using Hale, you agree
          to them; if you do not agree to them, please do not use Hale. Please read them alongside
          our{' '}
          <a href={localeHref(locale, '/privacy')} className="link">
            Privacy Policy
          </a>
          , which explains how we handle your family&rsquo;s data.
        </p>
      }
      sections={SECTIONS}
      crossLinkHref="/privacy"
      crossLinkLabel="Privacy Policy"
    >
      <LegalSectionBlock id="what-hale-is" title="What Hale is">
        <p>
          Hale is an AI assistant for families across every stage of childhood, and you reach it by
          text message: it is a phone number your family texts, not an app you install. Email and
          the web app are available too, and carry the same record.
        </p>
        <p>
          Hale watches for things that matter in your family&rsquo;s day — including municipal
          registration dates and programs where you live — answers parenting questions, drafts
          helpful suggestions, and, with your approval, helps carry them out. Hale is a tool to
          support you as a parent; it does not replace your judgment.
        </p>
      </LegalSectionBlock>

      <LegalSectionBlock id="eligibility" title="Who can use Hale">
        <p>
          You must be at least 18 years old and the parent or legal guardian of the children you add.
          You use Hale on your own behalf and on behalf of your children, and you confirm you have the
          authority to provide their information and to make decisions for them within Hale. Some
          actions that affect both parents&rsquo; data require both parents to have agreed.
        </p>
      </LegalSectionBlock>

      <LegalSectionBlock id="privacy" title="Privacy">
        <p>
          Your use of Hale is also governed by our{' '}
          <a href={localeHref(locale, '/privacy')} className="link">
            Privacy Policy
          </a>
          , which forms part of these terms. It sets out what we collect, why, where it is stored,
          who it is ever shared with, and the control you keep over it. If anything in these terms
          conflicts with the Privacy Policy on how we handle your family&rsquo;s personal
          information, the Privacy Policy governs.
        </p>
      </LegalSectionBlock>

      <LegalSectionBlock id="text-messages" title="Text messages, STOP, and carrier rates">
        <p>
          Hale texts the number the conversation started from. We never text a number that has not
          texted us first, and your consent is recorded in the words you used to give it. How often
          Hale texts depends on what your family has asked it to watch — typically a brief at the
          start of the week and a message when something needs you.
        </p>
        <p>
          <strong>Reply STOP to any message and the messages stop</strong>, immediately, until you
          ask us to start again; reply HELP for help. Standard message and data rates from your
          mobile carrier apply, and message delivery depends on your carrier, which we do not
          control. Text messages are not end-to-end encrypted — see{' '}
          <a href={localeHref(locale, '/privacy')} className="link">
            our Privacy Policy
          </a>{' '}
          for what that means and for the limits we apply to what we put in a text.
        </p>
      </LegalSectionBlock>

      <LegalSectionBlock id="accounts" title="Your account and security">
        <p>
          Most families use Hale entirely by text and never create an account. If you do sign in to
          the web app, you can use a Google account or an email address and password. You are
          responsible for keeping access to your account and to the phone number you text from
          secure, and for the activity that happens under them. Tell us promptly if you believe
          either has been used without your permission. Keep your information accurate so Hale can
          serve your family well.
        </p>
        <p>
          You can delete your account at any time from the web app, and you can end the text
          conversation at any time by replying STOP.
        </p>
      </LegalSectionBlock>

      <LegalSectionBlock id="licence" title="Your licence to use Hale">
        <p>
          Subject to these terms, we grant you a limited, non-exclusive, non-transferable,
          revocable licence to use Hale for your own family&rsquo;s personal, non-commercial
          purposes. It lasts as long as these terms do, and it is the only right in Hale that these
          terms give you.
        </p>
      </LegalSectionBlock>

      <LegalSectionBlock id="acceptable-use" title="Acceptable use">
        <p>You agree not to:</p>
        <ul>
          <li>use Hale for anything unlawful, harmful, or that endangers a child;</li>
          <li>upload information about a child you are not the parent or guardian of;</li>
          <li>
            attempt to break, overload, reverse-engineer, or gain unauthorized access to Hale or
            another family&rsquo;s data;
          </li>
          <li>
            scrape or automate access to Hale outside the connections we offer, or resell, rent, or
            otherwise commercially exploit it;
          </li>
          <li>misuse the AI assistant to generate harmful, deceptive, or abusive content.</li>
        </ul>
      </LegalSectionBlock>

      <LegalSectionBlock id="approval-model" title="How Hale works: you decide">
        <p>
          Hale drafts; you decide. The assistant prepares suggestions, but it does not act on its own
          — a parent approves every action before anything happens in the outside world. New accounts
          begin in an observe-only mode, and any move toward more automation requires your explicit,
          per-action-type approval. Where an action would cost money, hard spending caps apply, and
          an action that would exceed a cap is refused.
        </p>
      </LegalSectionBlock>

      <LegalSectionBlock id="ownership" title="Ownership, your content, and feedback">
        <p>
          Hale itself — the software, the site, the name and the marks — belongs to Village Hale
          Technologies Inc. or its licensors. Nothing in these terms transfers any of it to you, and
          all rights we do not expressly grant are reserved. Copyright &copy; 2026 Village Hale
          Technologies Inc.
        </p>
        <p>
          What you tell Hale is the other way round.{' '}
          <strong>
            Your family&rsquo;s information — your messages, your children&rsquo;s profiles, your
            logs — belongs to your family
          </strong>
          , not to us. You give us only the permission we need to run Hale for you: to store that
          information, process it, and use it to do the things you ask, as described in the Privacy
          Policy. We do not sell it, and we do not use your children&rsquo;s data for advertising.
        </p>
        <p>
          If you send us an idea or a suggestion for Hale, we may use it to improve the product
          without owing you anything for it. Please do not send us anything you consider
          confidential.
        </p>
      </LegalSectionBlock>

      <LegalSectionBlock id="third-party" title="Programs, venues, and tools run by others">
        <p>
          Much of what Hale is useful for belongs to somebody else: a city&rsquo;s registration
          page, a camp, a library program, a swim school. We do not run any of them. Their prices,
          their deadlines, their availability and their own terms and privacy practices are theirs,
          and anything you register for or buy is between you and them. Hale tells you what it
          found and when it found it — check the source before you rely on it.
        </p>
        <p>
          The same goes for tools you connect, such as an email account or a calendar. By
          connecting one you confirm you are allowed to, and that tool&rsquo;s own terms keep
          applying. You can disconnect it at any time.
        </p>
      </LegalSectionBlock>

      <LegalSectionBlock id="ai-disclaimer" title="AI disclaimer — not professional advice">
        <p>
          Hale uses artificial intelligence to generate suggestions and answers.{' '}
          <strong>
            Hale is not a substitute for professional advice. It does not provide medical, legal,
            financial, or other professional advice.
          </strong>{' '}
          Information from Hale is for general support only.
        </p>
        <p>
          For any concern about your child&rsquo;s health, development, or safety, consult a qualified
          professional — such as your doctor or pediatrician. <strong>In an emergency, or if you
          believe a child is in danger, contact your local emergency services immediately.</strong>{' '}
          Do not rely on Hale in an emergency.
        </p>
      </LegalSectionBlock>

      <LegalSectionBlock id="no-warranty" title="Accuracy and no warranty">
        <p>
          AI can be wrong. We do not guarantee that Hale&rsquo;s suggestions, answers, or discovered
          activities are accurate, complete, current, or suitable for your situation, and you are
          responsible for reviewing them before you act. Hale is provided{' '}
          <strong>&ldquo;as is&rdquo; and &ldquo;as available,&rdquo;</strong> without warranties of
          any kind, whether express or implied, to the fullest extent permitted by law. We do not
          warrant that Hale will be uninterrupted or error-free.
        </p>
        <p>
          To that same extent, we disclaim the implied warranties and conditions of
          merchantability, fitness for a particular purpose, title, and non-infringement. Consumer
          protection law in your province may give you warranties that cannot be excluded; where it
          does, this section does not apply to them.
        </p>
      </LegalSectionBlock>

      <LegalSectionBlock id="liability" title="Limitation of liability">
        <p>
          To the fullest extent permitted by law, Hale and its team will not be liable for any
          indirect, incidental, special, consequential, or punitive damages, or for any loss arising
          from your reliance on Hale&rsquo;s output or your use of (or inability to use) the service.
          Nothing in these terms limits any liability that cannot be limited under applicable law.
        </p>
      </LegalSectionBlock>

      <LegalSectionBlock id="changes-to-hale" title="Changes to Hale">
        <p>
          Hale is early, and it changes. We may add, change, or withdraw features, and we may set
          reasonable limits on use to keep the service running for everyone. We do not promise any
          particular level of availability or support, and we are not liable for a change to Hale
          itself — but we will not knowingly take away something your family relies on without
          telling you first.
        </p>
      </LegalSectionBlock>

      <LegalSectionBlock id="termination" title="Suspension and termination">
        <p>
          You may stop using Hale at any time — reply STOP to end the text conversation, and delete
          your account if you have one. We may suspend or terminate access if you breach these
          terms, to protect the safety of a child or another user, or as required by law. When your
          use of Hale ends, we handle your data as described in our{' '}
          <a href={localeHref(locale, '/privacy')} className="link">
            Privacy Policy
          </a>
          .
        </p>
        <p>
          Some parts of these terms are written to outlast your use of Hale, and they survive it:
          acceptable use, ownership, the AI disclaimer, accuracy and no warranty, limitation of
          liability, general, and governing law.
        </p>
      </LegalSectionBlock>

      <LegalSectionBlock id="changes" title="Changes to these terms">
        <p>
          We may update these terms as Hale evolves. When we make a material change, we will update
          the date at the top and, where appropriate, ask you to agree again. Continuing to use Hale
          after a change means you accept the updated terms.
        </p>
      </LegalSectionBlock>

      <LegalSectionBlock id="general" title="General">
        <p>
          These terms and the Privacy Policy are the whole agreement between you and us about Hale,
          and they replace anything said before. If part of them turns out to be unenforceable, that
          part is narrowed to what the law allows and the rest stays in force. If we do not enforce
          something straight away, we have not given it up. You may not transfer your rights under
          these terms to someone else; we may transfer ours to a successor if Hale is acquired or
          reorganized, and your rights travel with you. Throughout, &ldquo;including&rdquo; means
          &ldquo;including without limitation.&rdquo;
        </p>
        <p>
          You agree that we may communicate with you electronically — by text, by email, or by a
          notice in the web app — and that those communications meet any requirement that a notice
          be in writing. Messages you have told us to stop sending are the exception: STOP means
          stop.
        </p>
      </LegalSectionBlock>

      <LegalSectionBlock id="governing-law" title="Governing law and where disputes are heard">
        <p>
          These terms are governed by the laws of the Province of Ontario and the federal laws of
          Canada that apply there, without regard to conflict-of-laws rules. Any dispute arising out
          of these terms or your use of Hale will be heard by the courts of the Province of Ontario,
          and you and we each submit to their jurisdiction.
        </p>
        <p>
          Nothing in this section takes away a right you have under the consumer protection law of
          your own province that cannot be given up by agreement.
        </p>
      </LegalSectionBlock>

      <LegalSectionBlock id="contact" title="How to reach us">
        <p>
          Questions about these terms? Contact us at{' '}
          <a href="mailto:privacy@villagehale.com" className="link">
            privacy@villagehale.com
          </a>
          .
        </p>
      </LegalSectionBlock>
    </LegalLayout>
  );
}
