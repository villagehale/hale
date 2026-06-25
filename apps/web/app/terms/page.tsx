import type { Metadata } from 'next';
import { LegalLayout, LegalSectionBlock, type LegalSection } from '~/components/hale/legal-layout';

export const metadata: Metadata = {
  title: 'Terms of Service · Hale',
  description:
    'The terms that govern your use of Hale — what Hale is, who can use it, the approval model, and the limits of an AI assistant.',
};

const SECTIONS: LegalSection[] = [
  { id: 'what-hale-is', title: 'What Hale is' },
  { id: 'eligibility', title: 'Who can use Hale' },
  { id: 'accounts', title: 'Your account and security' },
  { id: 'acceptable-use', title: 'Acceptable use' },
  { id: 'approval-model', title: 'How Hale works: you decide' },
  { id: 'ai-disclaimer', title: 'AI disclaimer — not professional advice' },
  { id: 'no-warranty', title: 'Accuracy and no warranty' },
  { id: 'liability', title: 'Limitation of liability' },
  { id: 'termination', title: 'Suspension and termination' },
  { id: 'changes', title: 'Changes to these terms' },
  { id: 'governing-law', title: 'Governing law' },
  { id: 'contact', title: 'How to reach us' },
];

export default function TermsPage() {
  return (
    <LegalLayout
      eyebrow="legal"
      title="Terms of Service"
      intro={
        <p>
          These terms are an agreement between you and Village Hale Technologies Inc.
          (&ldquo;Hale,&rdquo; &ldquo;we,&rdquo; or &ldquo;us&rdquo;), a company incorporated in
          Ontario, Canada. By creating an account or using Hale, you agree to them. Please read them
          alongside our{' '}
          <a href="/privacy" className="link">
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
          Hale is a passive, event-driven assistant for families across every stage of childhood. It
          watches for things that matter in your family&rsquo;s day, drafts helpful suggestions,
          finds genuinely useful local things to do, and — with your approval — helps carry them out.
          Hale is a tool to support you as a parent; it does not replace your judgment.
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

      <LegalSectionBlock id="accounts" title="Your account and security">
        <p>
          You sign in through Google. You are responsible for keeping access to your account secure
          and for the activity that happens under it. Tell us promptly if you believe your account
          has been accessed without your permission. Keep your information accurate so Hale can serve
          your family well.
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

      <LegalSectionBlock
        id="ai-disclaimer"
        title="AI disclaimer — not professional advice"
      >
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
      </LegalSectionBlock>

      <LegalSectionBlock id="liability" title="Limitation of liability">
        <p>
          To the fullest extent permitted by law, Hale and its team will not be liable for any
          indirect, incidental, special, consequential, or punitive damages, or for any loss arising
          from your reliance on Hale&rsquo;s output or your use of (or inability to use) the service.
          Nothing in these terms limits any liability that cannot be limited under applicable law.
        </p>
      </LegalSectionBlock>

      <LegalSectionBlock id="termination" title="Suspension and termination">
        <p>
          You may stop using Hale and delete your account at any time. We may suspend or terminate
          access if you breach these terms, to protect the safety of a child or another user, or as
          required by law. When your account ends, we handle your data as described in our{' '}
          <a href="/privacy" className="link">
            Privacy Policy
          </a>
          .
        </p>
      </LegalSectionBlock>

      <LegalSectionBlock id="changes" title="Changes to these terms">
        <p>
          We may update these terms as Hale evolves. When we make a material change, we will update
          the date at the top and, where appropriate, ask you to agree again. Continuing to use Hale
          after a change means you accept the updated terms.
        </p>
      </LegalSectionBlock>

      <LegalSectionBlock id="governing-law" title="Governing law">
        <p>
          These terms are governed by the laws of the Province of Ontario and the federal laws of
          Canada that apply there, without regard to conflict-of-laws rules.
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
