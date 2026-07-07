import type { Metadata } from 'next';
import { LegalLayout, type LegalSection, LegalSectionBlock } from '~/components/hale/legal-layout';

export const metadata: Metadata = {
  title: 'Privacy Policy · Hale',
  description:
    "How Hale collects, uses, and protects your family's data — built for PIPEDA, Quebec Law 25, and CASL, with your data stored in Canada.",
};

const SECTIONS: LegalSection[] = [
  { id: 'who-we-are', title: 'Who we are' },
  { id: 'what-we-collect', title: 'What we collect' },
  { id: 'why-we-use-it', title: 'Why we use it (and our legal basis)' },
  { id: 'childrens-data', title: "Children's data" },
  { id: 'teen-privacy', title: 'Teen privacy (children 13 and older)' },
  { id: 'ai-processing', title: 'AI and automated processing' },
  { id: 'sub-processors', title: 'Sub-processors and cross-border processing' },
  { id: 'residency-retention', title: 'Data residency, retention, and security' },
  { id: 'your-rights', title: 'Your rights' },
  { id: 'casl', title: 'Email and electronic messages (CASL)' },
  { id: 'changes', title: 'Changes to this policy' },
  { id: 'contact', title: 'How to reach us' },
];

export default function PrivacyPage() {
  return (
    <LegalLayout
      eyebrow="legal"
      title="Privacy Policy"
      intro={
        <p>
          Hale helps families across every stage of childhood, and that means we handle some of the
          most sensitive data there is — including information about newborns and children. We treat
          that responsibility as the centre of the product, not an afterthought. This policy
          explains, in plain language, what we collect, why, where it lives, and the control you
          keep over it. It is written for Canada&rsquo;s federal privacy law (PIPEDA),
          Quebec&rsquo;s Law 25, and Canada&rsquo;s anti-spam law (CASL).
        </p>
      }
      sections={SECTIONS}
      crossLinkHref="/terms"
      crossLinkLabel="Terms of Service"
    >
      <LegalSectionBlock id="who-we-are" title="Who we are">
        <p>
          Hale is a passive, event-driven household assistant for families. You (a parent or legal
          guardian) create an account, add your children, and optionally connect tools you already
          use. Hale watches for things that matter, drafts helpful suggestions, and — only with your
          approval — helps carry them out. Hale is operated by Village Hale Technologies Inc., a
          company incorporated in Ontario, Canada, which is the organization responsible for your
          family&rsquo;s data; see{' '}
          <a href="#contact" className="link">
            How to reach us
          </a>
          .
        </p>
      </LegalSectionBlock>

      <LegalSectionBlock id="what-we-collect" title="What we collect">
        <p>We collect only what we need to run Hale for your family:</p>
        <ul>
          <li>
            <strong>Your account.</strong> Your name and email address, provided through Google
            sign-in, plus basic preferences such as language and time zone.
          </li>
          <li>
            <strong>Your children&rsquo;s profiles.</strong> Each child&rsquo;s first name (and last
            name if you add it), date of birth, and — only if you choose to share them — gender and
            other optional details such as interests. Hale uses date of birth to derive each
            child&rsquo;s stage (newborn, toddler, child, or teenager).
          </li>
          <li>
            <strong>Care and activity logs.</strong> The day-to-day entries you or connected tools
            record — feeds, naps, milestones, and similar notes about your child&rsquo;s routine.
          </li>
          <li>
            <strong>Concierge conversations and derived memory.</strong> The questions you ask your
            Concierge and its answers, plus a structured memory of facts and patterns Hale infers
            from your family&rsquo;s activity (for example, a usual nap window or a stated preference)
            so it can be more helpful over time.
          </li>
          <li>
            <strong>Coarse location only.</strong> If you opt in to local discovery, we store a
            coarse area — your city, province, country, and at most a postal code or
            forward-sortation area. We never store your precise street address or your child&rsquo;s
            location. The full address you may type into the address box is used only to derive that
            coarse area and is not retained.
          </li>
          <li>
            <strong>Village endorsements.</strong> When you endorse a local activity, we record that
            your family endorsed it so we can show an aggregate count (&ldquo;loved by several
            families near you&rdquo;). We never reveal which family endorsed what.
          </li>
          <li>
            <strong>Connected integrations.</strong> If you connect a tool (such as email, calendar,
            or a daycare app), we store an encrypted authorization token and the minimum metadata
            needed to sync. You control which integrations are connected and can disconnect them.
          </li>
          <li>
            <strong>Audit logs and technical data.</strong> Every action Hale takes produces an
            immutable audit record (see{' '}
            <a href="#your-rights" className="link">
              Your rights
            </a>
            ), and we keep limited technical information such as your IP address and browser type
            for security and to honour your access requests.
          </li>
        </ul>
      </LegalSectionBlock>

      <LegalSectionBlock id="why-we-use-it" title="Why we use it (and our legal basis)">
        <p>
          We use your family&rsquo;s data to provide and improve Hale: to understand what&rsquo;s
          happening in your family&rsquo;s day, to draft suggestions, to find genuinely useful local
          things to do, to keep an accurate record of what Hale did, and to keep your account
          secure. We do not sell your data, and we do not use your children&rsquo;s data for
          advertising.
        </p>
        <p>
          Our processing rests on your consent. We ask for that consent clearly when you sign up and
          again for specific, sensitive purposes — connecting an integration, sending your context
          to our AI provider, processing data across borders, and unlocking any automated action. We
          record each consent (including the policy version and time) so the choice is verifiable,
          and you can withdraw it at any time (see{' '}
          <a href="#your-rights" className="link">
            Your rights
          </a>
          ).
        </p>
      </LegalSectionBlock>

      <LegalSectionBlock id="childrens-data" title="Children's data">
        <p>
          Hale is built around children&rsquo;s information, and we apply heightened protection to
          it. A child&rsquo;s data is provided by you, their parent or guardian, and is processed on
          your authority and for your family&rsquo;s benefit. Optional and sensitive fields — such
          as gender — are exactly that: optional, and stored only if you provide them. A
          child&rsquo;s information belongs to one family and is never visible to another family.
        </p>
      </LegalSectionBlock>

      <LegalSectionBlock id="teen-privacy" title="Teen privacy (children 13 and older)">
        <p>
          As children grow, their privacy matters more. For a child aged 13 or older, raw content
          (the actual text of a message or post Hale observes) is{' '}
          <strong>redacted from parents by default</strong>. Parents see only a category or short
          summary — enough to stay involved, without reading their teen&rsquo;s words verbatim.
        </p>
        <p>
          Controls to grant a parent time-limited, explicitly logged access to a teen&rsquo;s raw
          content — and a safety-escalation path for a credible risk of harm, in which relevant
          content may be surfaced and the teen is notified — are planned and not yet available.
          Until then, the default redaction above always applies.
        </p>
      </LegalSectionBlock>

      <LegalSectionBlock id="ai-processing" title="AI and automated processing">
        <p>
          Hale uses artificial intelligence (Anthropic&rsquo;s Claude models) to read your
          family&rsquo;s context and draft suggestions. To do this, relevant conversation and
          context data is sent to our AI provider to generate a response.
        </p>
        <p>
          <strong>Hale never acts on its own.</strong> The AI only drafts; a parent approves every
          action before anything happens in the outside world. New accounts begin in an observe-only
          mode, and any move toward more automation requires your explicit, per-action-type
          approval. You are always the decision-maker.
        </p>
      </LegalSectionBlock>

      <LegalSectionBlock id="sub-processors" title="Sub-processors and cross-border processing">
        <p>
          We rely on a small set of trusted service providers to run Hale. We share with each only
          what that service needs, under contractual safeguards:
        </p>
        <ul>
          <li>
            <strong>Supabase</strong> — our primary database. Hosted in Canada (Toronto,
            <code> ca-central-1</code>). This is where your family&rsquo;s core data lives.
          </li>
          <li>
            <strong>Anthropic</strong> — AI processing (the Claude models that draft suggestions).
            Processed in the United States.
          </li>
          <li>
            <strong>Google Maps / Places</strong> — address autocomplete and public-venue lookup.
            Only coarse-area and public-venue queries are sent; your precise home address is never
            sent.
          </li>
          <li>
            <strong>Vercel</strong> — application hosting and content delivery, plus Web Analytics
            and Speed Insights. Operates in the United States and on a global edge network. Vercel
            Web Analytics is <strong>cookieless</strong> — it sets no cookies and builds no
            cross-site profile.
          </li>
          <li>
            <strong>PostHog</strong> — product analytics, session replay, and error tracking. Event
            data is coarse and non-identifying (no child data, no message content) — we capture only
            a few key product steps. Session replay is on so we can understand and fix problems, but
            every typed value (names, dates of birth, email, address) and all personal data shown on
            screen — child names and ages, the health and activity timeline, and Concierge
            conversations — is <strong>masked</strong> before the recording leaves your browser.
            Error tracking captures unhandled errors (a stack trace, not your data) so we can fix
            them. Autocapture stays off, and we identify you by an opaque account id, never your name
            or email. Region per <code>NEXT_PUBLIC_POSTHOG_HOST</code>.
          </li>
          <li>
            <strong>Resend</strong> — delivery of transactional and digest emails (United States).
          </li>
          <li>
            <strong>Langfuse</strong> — AI observability, so we can monitor and debug the assistant.
            A teen&rsquo;s raw content and contact details (emails, phone numbers, postal codes, and
            precise addresses) are masked before any data is sent to this service.
          </li>
        </ul>
        <p>
          To be clear about where data travels: your primary data store is in Canada, while some
          processing — AI, application hosting, email delivery, and observability — happens in the
          United States. We ask for your consent to cross-border processing, and we put appropriate
          contractual safeguards in place with these providers. Because some processing occurs
          outside Quebec and Canada, that data may be accessible to authorities in those
          jurisdictions under their laws.
        </p>
      </LegalSectionBlock>

      <LegalSectionBlock id="residency-retention" title="Data residency, retention, and security">
        <p>
          <strong>Residency.</strong> Your family&rsquo;s primary data is stored in Canada
          (Toronto). See{' '}
          <a href="#sub-processors" className="link">
            Sub-processors
          </a>{' '}
          for the processing that occurs elsewhere.
        </p>
        <p>
          <strong>Retention.</strong> We keep your family&rsquo;s data for as long as your account
          is active and as needed to provide Hale. When you delete your account or ask us to erase
          your data, we delete it, except where we must retain certain records (such as audit logs)
          to meet legal obligations. Removing a child removes that child&rsquo;s identifying data;
          some family history is retained in de-identified form.
        </p>
        <p>
          <strong>Security.</strong> Access to your data is isolated per family at the database
          level (row-level security), data is encrypted in transit, and integration tokens are
          encrypted before they are stored. We log every action Hale takes so it can always be
          reviewed.
        </p>
      </LegalSectionBlock>

      <LegalSectionBlock id="your-rights" title="Your rights">
        <p>Under PIPEDA and Quebec&rsquo;s Law 25, you have the right to:</p>
        <ul>
          <li>
            <strong>Access</strong> the personal information we hold about your family. Because
            every action Hale takes is recorded in an immutable audit log, we can show you what
            happened and when.
          </li>
          <li>
            <strong>Correct</strong> information that is inaccurate or incomplete.
          </li>
          <li>
            <strong>Delete</strong> your data and close your account.
          </li>
          <li>
            <strong>Withdraw consent</strong> at any time, including consent to AI processing,
            cross-border processing, a specific integration, or any automated action.
          </li>
          <li>
            <strong>Port</strong> your data — receive a copy in a structured, commonly used format.
          </li>
          <li>
            <strong>Complain.</strong> If you are not satisfied with how we handle your data, you
            may contact the Office of the Privacy Commissioner of Canada, or, in Quebec, the
            Commission d&rsquo;accès à l&rsquo;information du Québec.
          </li>
        </ul>
        <p>
          To exercise any of these rights, contact us at the address in{' '}
          <a href="#contact" className="link">
            How to reach us
          </a>
          .
        </p>
      </LegalSectionBlock>

      <LegalSectionBlock id="casl" title="Email and electronic messages (CASL)">
        <p>
          We send you email that is necessary to run your account — such as security notices and the
          updates and digests you ask Hale to prepare. If we ever send commercial electronic
          messages, we do so only with your consent, we identify ourselves, and every such message
          includes a clear, working way to unsubscribe. You can opt out of non-essential messages at
          any time without affecting your account.
        </p>
      </LegalSectionBlock>

      <LegalSectionBlock id="changes" title="Changes to this policy">
        <p>
          We may update this policy as Hale evolves. When we make a material change, we will update
          the date at the top and, where appropriate, ask for your renewed consent. The version you
          agreed to is recorded with your consent.
        </p>
      </LegalSectionBlock>

      <LegalSectionBlock id="contact" title="How to reach us">
        <p>
          Our Privacy Officer &mdash; the person in charge of personal information under
          Quebec&rsquo;s Law 25 &mdash; is <strong>Anzhe Dong, Founder</strong>. For any privacy
          question, or to exercise your rights, contact us at{' '}
          <a href="mailto:privacy@villagehale.com" className="link">
            privacy@villagehale.com
          </a>
          .
        </p>
      </LegalSectionBlock>
    </LegalLayout>
  );
}
