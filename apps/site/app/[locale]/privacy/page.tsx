import type { Metadata } from 'next';
import { LegalLayout, type LegalSection, LegalSectionBlock } from '~/components/legal-layout';
import { buildAlternates } from '~/i18n/metadata';
import { localeHref } from '~/i18n/navigation';
import type { Locale } from '~/i18n/routing';
import { pageSource } from '~/lib/page-source';

/**
 * villagehale.com/privacy — the canonical home for the Privacy Policy
 * (VIL-250 · M14 · B-legal). A legal-copy change is its own change, never bundled
 * with a design move.
 *
 * 2026-08-19: two FACTUAL corrections, both flagged by review — the PostHog
 * jurisdiction and the account-first opening paragraph.
 *
 * 2026-08-20: STRUCTURAL. The section architecture is adapted from the CC0
 * General-Legal "GDPR-Enhanced Privacy Policy" template
 * (github.com/General-Legal/legal-templates, CC0 1.0 — no attribution owed,
 * recorded because provenance matters on a legal surface). Three of its patterns
 * were worth having and we did not: collection organised by SOURCE, use organised
 * by PURPOSE, and sharing organised by RECIPIENT rather than only by named
 * vendor.
 *
 * That third one is why this revision is not cosmetic. `consent_records` has
 * carried caregiver_access_grant, mcp_third_party_model and village_intro rows —
 * three ways a family's data leaves the family — while this page described only
 * sub-processors. Every fact in the new sharing section was read out of the code
 * that performs the disclosure, not drafted: the caregiver's scoped slice on a
 * named number, the MCP read re-rendered to the strictest outbound standard
 * (lib/mcp/read-tools.ts), and the introduction's four disclosed fields exactly as
 * the audit row names them (lib/village/intros/run.ts).
 *
 * Everything the template ships that is not ours was dropped, not translated: the
 * California notice at collection, the state privacy rights notice, and the whole
 * "Notice to European users" — legal bases, data subjects, legitimate interests, a
 * DPO and EU/UK representatives. PIPEDA vocabulary replaces it, and the Law 25
 * automated-decision statement (s.12.1) is stated plainly in the AI section.
 *
 * 2026-08-27: Google Ads gtag (AW-18412881223) now loads in the document head of
 * every public marketing page so advertising landing-page visits can be measured.
 * That may set advertising cookies on villagehale.com; the product app still does
 * not load it. PostHog on the marketing site remains memory-only. The pairing is
 * gated — apps/site/lib/analytics/google-ads.test.ts fails if the tag and this
 * disclosure move alone; posthog-config.test.ts still gates the PostHog half.
 *
 * 2026-10-07: Sloane's redline. Product facts that the draft left open are stated only
 * where the code or a confirmed fact supports them (message retention, consent records,
 * Google Drive read-only, PostHog replay).
 *
 * The public "last updated" line is the Toronto calendar day the text was last
 * edited (2026-10-07), not the UTC day. A later merge should bump that line to
 * the merge date. The Canada hosting sentence, the cookie banner, and the Speed
 * Insights wording all landed in that same edit. Counsel should read the diff.
 *
 * app.villagehale.com/privacy is now a permanent 308 here (VIL-256), so this is
 * the only copy. Still noindexed by choice — whether a privacy policy should be
 * findable in search on a product whose moat is privacy is a founder call.
 * Reachable by direct link either way — the footer, the app, the mobile listing
 * and every consent surface point straight at it.
 */

const TITLE = 'Privacy Policy · Hale';
const DESCRIPTION = "How Hale collects, uses, and protects your family's data, in plain language.";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: Locale }>;
}): Promise<Metadata> {
  const { locale } = await params;
  return {
    title: TITLE,
    description: DESCRIPTION,
    alternates: buildAlternates(locale, '/privacy'),
    // The locale layout's homepage preview still says family data stays in Canada.
    // A legal URL must not inherit that claim.
    openGraph: {
      title: TITLE,
      description: DESCRIPTION,
      url: localeHref(locale, '/privacy'),
    },
    twitter: {
      title: TITLE,
      description: DESCRIPTION,
    },
    robots: { index: false, follow: false },
  };
}

const SECTIONS: LegalSection[] = [
  { id: 'who-we-are', title: 'Who we are' },
  { id: 'what-we-collect', title: 'What we collect, and where it comes from' },
  { id: 'why-we-use-it', title: 'Why we use it, and the consent we rely on' },
  { id: 'childrens-data', title: 'Children’s data' },
  { id: 'teen-privacy', title: 'Teen privacy (children 13 and older)' },
  { id: 'ai-processing', title: 'AI and automated processing' },
  { id: 'how-we-share', title: 'Who your family’s data is shared with' },
  { id: 'sub-processors', title: 'Sub-processors and cross-border processing' },
  { id: 'google-api-limited-use', title: 'Google API Services User Data Policy' },
  { id: 'sms', title: 'Text messages (iMessage and SMS)' },
  { id: 'residency-retention', title: 'Data residency, retention, and security' },
  { id: 'your-rights', title: 'Your rights' },
  { id: 'your-choices', title: 'Your choices' },
  { id: 'other-services', title: 'Other sites and services' },
  { id: 'casl', title: 'Email and electronic messages (CASL)' },
  { id: 'changes', title: 'Changes to this policy' },
  { id: 'contact', title: 'How to reach us' },
];

export default async function PrivacyPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: Locale }>;
  searchParams?: Promise<{ s?: string | string[] }>;
}) {
  const { locale } = await params;
  return (
    <LegalLayout
      locale={locale}
      source={await pageSource(searchParams)}
      title="Privacy Policy"
      lastUpdatedIso="2026-10-09"
      intro={
        <p>
          Hale is a texted assistant for parents. It handles kids&rsquo; activities, reminders,
          family group chats and parenting questions, so it handles information about children. We
          treat that responsibility as the centre of the product, not an afterthought. This policy
          explains, in plain language, what we collect, why, who it is ever shared with, and the
          control you keep over it. Village Hale Technologies Inc. is a Canadian company, and this
          policy is written to meet Canada&rsquo;s PIPEDA, Quebec&rsquo;s Law 25 and CASL.
        </p>
      }
      sections={SECTIONS}
      crossLinkHref="/terms"
      crossLinkLabel="Terms of Service"
    >
      <LegalSectionBlock id="who-we-are" title="Who we are">
        <p>
          Hale is a family assistant you reach by iMessage or text message. It finds activities for
          your kids, reminds you before registration opens, watches for open spots, can join a
          family group chat, and answers parenting questions. Today Hale does not book or register
          on your behalf. If we later offer a feature that acts on your instruction (for example,
          completing a sign-up), it will only act after you confirm that specific action, and we
          will update this policy first. You (a parent or legal guardian) text the number and tell
          Hale about your children. There is no account you must create, though you may sign in to
          the web app, and you may optionally connect tools you already use. Hale is operated by
          Village Hale Technologies Inc., a corporation incorporated in Ontario, Canada (corporation
          no. 1001656484), which is the organization responsible for your family&rsquo;s data under
          PIPEDA; see{' '}
          <a href="#contact" className="link">
            How to reach us
          </a>
          . Our{' '}
          <a href={localeHref(locale, '/terms')} className="link">
            Terms of Service
          </a>{' '}
          govern your use of Hale; this policy governs your family&rsquo;s data.
        </p>
      </LegalSectionBlock>

      <LegalSectionBlock id="what-we-collect" title="What we collect, and where it comes from">
        <p>
          We collect only what we need to run Hale for your family. It reaches us four ways, and the
          difference matters — most of it you typed, and none of it was bought.
        </p>
        <p>
          <strong>What you give us.</strong> The things you tell Hale, in a text or in the web app:
        </p>
        <ul>
          <li>
            <strong>Your contact details.</strong> The phone number you text from, which is also how
            you sign in to the web app with a one-time code. Plus basic preferences such as language
            and time zone.
          </li>
          <li>
            <strong>Your children&rsquo;s profiles.</strong> Each child&rsquo;s first name (and last
            name if you add it), date of birth, and — only if you choose to share them — gender and
            other optional details such as interests. Hale uses date of birth to derive each
            child&rsquo;s stage (newborn, toddler, child, or teenager).
          </li>
          <li>
            <strong>Care and activity logs.</strong> The day-to-day entries you record — feeds,
            naps, diapers, milestones, and growth measurements.
          </li>
          <li>
            <strong>Hale conversations.</strong> The questions you ask Hale and its answers.
          </li>
          <li>
            <strong>Group chats.</strong> If you add Hale to a group chat, or ask Hale to start one,
            Hale receives the messages in that chat, including messages from other members (a
            co-parent, a grandparent, a caregiver) and their phone numbers. Hale uses them only to
            help that family, and only for the purposes in this policy. Please add Hale only to
            chats whose members you have told about Hale. Hale introduces itself when it joins, and
            a member can reply STOP to stop Hale writing to them in that chat. A member who is not a
            Hale user can ask us at{' '}
            <a href="mailto:privacy@villagehale.com" className="link">
              privacy@villagehale.com
            </a>{' '}
            to access or delete their messages.
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
        </ul>
        <p>
          <strong>What comes from services you connect.</strong> If you connect a tool (such as
          email or calendar), we store an encrypted authorization token and the
          minimum metadata needed to sync, plus the entries that tool records into your
          family&rsquo;s timeline. You control which integrations are connected and can disconnect
          them. When a flight, hotel or rental confirmation in a connected mailbox shows that your
          children are travelling with you, what we keep is the destination city and the dates only;
          we never store the message, the confirmation number, or what the trip cost.
        </p>
        <p>
          PIPEDA asks for the purpose to be identified before the collection, and that is per-source
          and per-use rather than one paragraph. So, for each thing you can connect:
        </p>
        <ul>
          <li>
            <strong>Gmail (optional).</strong> What is read: the subject, the sender, the first
            line, and the time it arrived. When a message looks like it carries a date your family
            has to be somewhere, that message is opened. Why: to notice the date and offer to put it
            on your week. What is never read: anything you have not connected, and any message that
            does not look like a family date.
          </li>
          <li>
            <strong>Calendar (optional).</strong> What is read: an event&rsquo;s title, its notes,
            start, end, place, and whether it was cancelled or moved. Why: so a change to your week
            reaches you as a text rather than as a surprise.
          </li>
          <li>
            <strong>Google Drive (optional).</strong> What is read: a file&rsquo;s name, its type,
            when it was last modified, and a link to open it. Hale does not read the contents of the
            file. Why: so Hale can find a file you ask about, such as a permission form.
          </li>
          <li>
            <strong>How it went.</strong> What is stored: your one-line answer to Hale&rsquo;s
            evening question, for thirty days, readable only by you and never shown to another
            family.
          </li>
        </ul>
        <p>
          By default Hale asks Google for read-only access to Gmail (<code>gmail.readonly</code>),
          Calendar (<code>calendar.readonly</code>), and Drive (<code>drive.readonly</code>), plus
          your basic profile (your name). For some accounts, Hale may also ask for permission to
          create email drafts (<code>gmail.compose</code>; it never sends them) and to add or change
          calendar events (<code>calendar.events</code>). Hale asks for these separately and uses
          them only when you ask. It never deletes your email, it never asks for permission to send
          email as you, and Drive stays read-only.
        </p>
        <p>
          <strong>What Hale works out for itself.</strong> A structured memory of facts and patterns
          Hale infers from your family&rsquo;s activity — for example, a stated preference — so it
          can be more helpful over time. Inferred information about your
          family is your family&rsquo;s personal information too, and everything in this policy
          applies to it.
        </p>
        <p>
          <strong>What is collected automatically.</strong> Every action Hale takes produces an
          immutable audit record (see{' '}
          <a href="#your-rights" className="link">
            Your rights
          </a>
          ), and we keep limited technical information such as your IP address and browser type for
          security and to honour your access requests, plus the coarse product-usage events
          described under{' '}
          <a href="#sub-processors" className="link">
            Sub-processors
          </a>
          . On the public website, Google Ads measures a visit only after the visitor taps Accept in
          the cookie banner, so we can tell whether an advertisement led them there. If they choose
          No thanks, or make no choice, that measurement does not run. It does not include family
          data. We do not buy personal information about your family from data brokers, and we do
          not collect it from social media or other public sources.
        </p>
      </LegalSectionBlock>

      <LegalSectionBlock id="why-we-use-it" title="Why we use it, and the consent we rely on">
        <p>
          PIPEDA asks an organization to identify its purposes before it collects anything, so here
          they are — the whole list:
        </p>
        <ul>
          <li>
            <strong>Running Hale for your family.</strong> Understanding what is happening in your
            family&rsquo;s day, answering your questions, drafting suggestions, finding genuinely
            useful local things to do, and keeping an accurate record of what Hale did.
          </li>
          <li>
            <strong>Keeping your family&rsquo;s data safe.</strong> Recognising you, protecting
            accounts and the service against abuse, and maintaining the audit record that lets us
            show you exactly what happened.
          </li>
          <li>
            <strong>Making Hale better.</strong> Understanding which parts of the product work and
            which fail, and finding and fixing errors.
          </li>
          <li>
            <strong>Meeting our obligations.</strong> Complying with the law, responding to lawful
            requests, enforcing our{' '}
            <a href={localeHref(locale, '/terms')} className="link">
              Terms of Service
            </a>
            , and protecting a child or another person from harm.
          </li>
          <li>
            <strong>Travel briefs.</strong> Noticing, from a flight, hotel or rental confirmation in
            a mailbox you connected, that your children are going somewhere with you &mdash; so that
            about a week before you go, Hale can text you a couple of things that are on for them
            where you are going. We read the confirmation for the destination and the dates and for
            whether a child is on the booking, and nothing else.
          </li>
          <li>
            <strong>Measuring our advertisements.</strong> Understanding whether an ad led a visitor
            to the marketing site. This is about the advertisement and the visit, not about your
            family.
          </li>
        </ul>
        <p>
          That is all of them. We do not sell your data, we do not use your children&rsquo;s data
          for advertising, and Hale shows no advertising.
        </p>
        <p>
          <strong>The consent we rely on.</strong> Everything above rests on your consent, and
          PIPEDA asks that it be <strong>meaningful consent</strong> — that you understand what you
          are agreeing to, in language you can actually read, before you agree. So we ask plainly at
          the start, and separately again for each purpose that deserves its own answer: connecting
          an integration, sending your context to our AI provider, processing data across borders,
          letting Hale watch and text you unprompted, sharing a slice of your week with a caregiver
          you name, letting a tool you connect read from Hale, being introduced to another
          household, and unlocking any automated action. We record each consent — what was asked,
          the words you answered in, the version of this policy, and the time — so the choice is
          verifiable afterwards, and you can withdraw it at any time (see{' '}
          <a href="#your-rights" className="link">
            Your rights
          </a>{' '}
          and{' '}
          <a href="#your-choices" className="link">
            Your choices
          </a>
          ).
        </p>
      </LegalSectionBlock>

      <LegalSectionBlock id="childrens-data" title="Children’s data">
        <p>
          Hale is built around children&rsquo;s information, and we apply heightened protection to
          it. Information you share about your child is part of your family&rsquo;s information. You
          provide it as their parent or guardian, and you can correct or delete it at any time. A
          child&rsquo;s data is processed on your authority and for your family&rsquo;s benefit.
          Optional and sensitive fields — such as gender — are exactly that: optional, and stored
          only if you provide them. Messages sent in a multi-family group chat are visible to the
          members of that chat. Nothing from one family&rsquo;s private data — an inbox, a calendar,
          or a one-to-one text — is shown to another family unless that parent opts in to share it.
        </p>
        <p>
          Hale is for parents and guardians. A child does not have a Hale account. We do not
          knowingly collect information directly from a child. The exception is a family group chat
          Hale is part of: Hale receives the messages a child sends there, the same as any other
          member&rsquo;s messages, and those messages are visible to everyone in the chat. Hale does
          not knowingly collect more from that child than the messages already in the chat and the
          information you provide.
        </p>
      </LegalSectionBlock>

      <LegalSectionBlock id="teen-privacy" title="Teen privacy (children 13 and older)">
        <p>
          As children grow, their privacy matters more. For a child aged 13 or older, raw content
          Hale would show a parent on its own surfaces — the actual text of a message or post Hale
          observes — is <strong>redacted from parents by default</strong>. Parents see only a
          category or short summary. That is the web app, and the texts, email, calendar feeds,
          exports, and connected tools Hale sends. A group chat is different: messages in a chat
          Hale is part of, including a child&rsquo;s, are visible to the members of that chat. Hale
          does not hide them from the people already in it. When Hale writes into that chat, it does
          not name a child aged 13 or older, or that child&rsquo;s events.
        </p>
        <p>
          A parent can ask to see it. Asking reveals nothing on its own: we record what was asked
          for and the reason given, tell the teen, and open the content only if the teen agrees.
          Access is limited to the kind of content that was asked for, lasts at most seven days, and
          can be closed at any time by either of you. Every step — the request, the teen&rsquo;s
          answer, the expiry, and any closure — is written to your family&rsquo;s record.
        </p>
        <p>
          There is one exception in this policy: a credible risk of harm, where relevant content may
          be opened without waiting for the teen to agree. Because it skips their agreement it is
          held to the strictest limits — at most 24 hours, a written reason on the record, and the
          teen is always told.
        </p>
        <p>
          Two limits worth stating plainly, because they describe Hale as it is today rather than as
          we intend it.
        </p>
        <p>
          First, access is only ever in-app. Even with an open grant, nothing widens what appears in
          an email, a text message, a calendar feed, a data export, or anything Hale shares with a
          connected tool — those always stay redacted.
        </p>
        <p>
          Second, and more importantly: a child&rsquo;s record holds no contact details, and a teen
          has no Hale account. A phone number that appears because someone is in a group chat is not
          used to tell a teen about a privacy request. Since telling the teen is a condition of
          opening anything, <strong>no request can be granted yet</strong> — a request is recorded,
          the notification we owe the teen is recorded as still outstanding, and the default
          redaction above continues to apply unchanged. The same is true of the safety exception: it
          is policy, not a button, and it stays unavailable until a teen can actually be told. You
          can see the pending state and the outstanding notification on any request in Settings. We
          will not enable either path before a teen can be reached.
        </p>
      </LegalSectionBlock>

      <LegalSectionBlock id="ai-processing" title="AI and automated processing">
        <p>
          Hale uses AI providers, including Anthropic, to write its replies and reminders. Anthropic
          is called directly. Some requests are routed through Vercel AI Gateway, which may send
          them to another model provider. The relevant parts of your conversation and family context
          are sent to the provider that generates the reply.
        </p>
        <p>
          Hale does not take any action in the outside world for you, such as registering, paying,
          or sending an email in your name, unless you have confirmed that specific action. You are
          the decision-maker for those actions.
        </p>
        <p>
          Stated the way Quebec&rsquo;s Law 25 asks us to state it:{' '}
          <strong>No decision about your family is made by automated processing alone.</strong> We
          do not profile your family for advertising, and we do not use your family&rsquo;s data to
          train AI models.
        </p>
      </LegalSectionBlock>

      <LegalSectionBlock id="how-we-share" title="Who your family’s data is shared with">
        <p>
          Nothing about your family is shared by default. There are six kinds of recipient, and four
          of them exist only because you asked for them.
        </p>
        <ul>
          <li>
            <strong>Service providers who run Hale for us.</strong> A small, named set — the
            database, the AI models, hosting, email and text delivery, analytics and observability.
            Each receives only what that service needs, under contractual safeguards. They are
            listed one by one in{' '}
            <a href="#sub-processors" className="link">
              Sub-processors
            </a>
            .
          </li>
          <li>
            <strong>A caregiver you name.</strong> If you invite a grandparent, a nanny or a
            babysitter, Hale texts them only the slice of your week that the role you chose covers,
            on the number you gave, and only after they have agreed to be texted. Your authorization
            is recorded as its own consent, and you can end it.
          </li>
          <li>
            <strong>A tool you connect.</strong> If you authorize an AI assistant or another tool to
            read from Hale, it receives only the scopes you selected — and what it reads is
            re-rendered at the moment of the read to the strictest standard we apply anywhere: a
            teen&rsquo;s content removed on their age as of that moment, health and sensitive items
            generalized, locations dropped. You can revoke the authorization at any time.
          </li>
          <li>
            <strong>Another household, in an introduction.</strong> Hale can offer to introduce your
            family to another local family around an activity. Nothing crosses until{' '}
            <strong>both households have said yes</strong> to that specific introduction, and what
            crosses is exactly four things: a parent&rsquo;s first name, an email address, the stage
            of a child (never a name or a date of birth), and the activity that anchored the match.
            The introduction is written to your family&rsquo;s record with those fields named, so
            you can always see what was disclosed.
          </li>
          <li>
            <strong>Other members of a group chat you add Hale to.</strong> Hale&rsquo;s replies in
            a group are visible to everyone in it.
          </li>
          <li>
            <strong>Where the law requires it.</strong> To authorities and in legal process where we
            are required or permitted to, to protect a child or another person from serious harm,
            and to our professional advisers — legal advisers, accountants, insurers — in the course
            of
            their work for us. If Hale is ever acquired, merged, or reorganized, your family&rsquo;s
            data may transfer with the business; this policy keeps applying to it, and we will tell
            you.
          </li>
        </ul>
      </LegalSectionBlock>

      <LegalSectionBlock id="sub-processors" title="Sub-processors and cross-border processing">
        <p>
          We rely on a small set of trusted service providers to run Hale. We share with each only
          what that service needs, under contractual safeguards:
        </p>
        <ul>
          <li>
            <strong>Supabase</strong> — our primary database. Hale&rsquo;s main database is hosted
            in Canada. This is where your family&rsquo;s core data lives.
          </li>
          <li>
            <strong>Anthropic</strong> — AI processing (the Claude models that write replies and
            reminders). Called directly. Processed in the United States.
          </li>
          <li>
            <strong>Vercel AI Gateway</strong> — routes some AI requests, which may be handled by
            another model provider, including DeepSeek. Processed in the United States or another
            country, depending on the provider that handles the request.
          </li>
          <li>
            <strong>Google Maps / Places</strong> — address autocomplete and public-venue lookup.
            Only coarse-area and public-venue queries are sent; your precise home address is never
            sent.
          </li>
          <li>
            <strong>Vercel</strong> — application hosting and content delivery, plus Web Analytics
            and Speed Insights. The content-delivery network is global. Vercel Web Analytics is{' '}
            <strong>cookieless</strong> — it sets no cookies and builds no cross-site profile.
            Vercel Speed Insights runs on the public website without a consent choice. Vercel
            documents that measurement as anonymous: it is not tied to a visitor or an IP address,
            and it does not store information that would reconstruct a browsing session or identify
            someone. A data point includes the page, the browser and device, the country, and a web
            vital.
          </li>
          <li>
            <strong>PostHog</strong> — product analytics, session replay, and error tracking. Event
            data is coarse and non-identifying (no child data, no message content) — we capture only
            a few key product steps. Session replay is on so we can understand and fix problems, but
            every typed value (names, dates of birth, email, address) and all personal data shown on
            screen — child names and ages, care logs, and Hale conversations
            — is <strong>masked</strong> before the recording leaves your browser. Product analytics
            and session replay are kept for 30 days. Error tracking captures unhandled errors (a
            stack trace, not your data) so we can fix them. Autocapture stays off, and we identify
            you by an opaque account id, never your name or email. Processed in the United States.
            On the public website, PostHog analytics and session replay load only after the visitor
            taps Accept in the cookie banner. If they choose No thanks, or make no choice, neither
            loads. Visitors can change that choice at any time with Cookie settings in the site
            footer. On the marketing site, PostHog is configured to write nothing to your device.
          </li>
          <li>
            <strong>Google Ads</strong> — advertising measurement on the marketing site
            (villagehale.com) only. Google&rsquo;s gtag (AW-18412881223) records that a visitor
            reached a landing page after seeing an advertisement. It may set advertising cookies on
            that visit. On the public website it loads only after the visitor taps Accept in the
            cookie banner. If they choose No thanks, or make no choice, it does not load. Visitors
            can change that choice at any time with Cookie settings in the site footer. It does not
            run on the product app, does not receive family data, message content, or
            children&rsquo;s information, and Hale still shows no advertising. Processed in the
            United States.
          </li>
          <li>
            <strong>Resend</strong> — delivery of transactional and weekly-brief emails (United
            States).
          </li>
          <li>
            <strong>Linq</strong> — delivery of iMessage and SMS. The content of those messages
            passes through Linq; see{' '}
            <a href="#sms" className="link">
              Text messages
            </a>
            .
          </li>
          <li>
            <strong>Langfuse</strong> — AI observability, so we can monitor and debug Hale. A
            teen&rsquo;s raw content and contact details (emails, phone numbers, postal codes, and
            precise addresses) are masked before any data is sent to this service.
          </li>
        </ul>
        <p>
          Hale&rsquo;s main database is hosted in Canada. Some service providers listed in this
          policy — for example hosting, AI model providers, and analytics — may process data outside
          Canada, mainly in the United States. We ask for your consent to that cross-border
          processing, and we put appropriate contractual safeguards in place with these providers.
          Because some processing occurs outside Quebec and Canada, that data may be accessible to
          authorities in those jurisdictions under their laws.
        </p>
      </LegalSectionBlock>

      <LegalSectionBlock id="google-api-limited-use" title="Google API Services User Data Policy">
        <p>
          Hale&rsquo;s use and transfer to any other app of information received from Google APIs
          will adhere to the{' '}
          <a
            href="https://developers.google.com/terms/api-services-user-data-policy"
            className="link"
          >
            Google API Services User Data Policy
          </a>
          , including the Limited Use requirements.
        </p>
        <p>In particular:</p>
        <ol type="i">
          <li>We use Google user data only to provide and improve the features you see in Hale.</li>
          <li>We do not use Google user data to train generalized or machine-learning models.</li>
          <li>We do not use Google user data for advertising, and we do not sell it.</li>
          <li>
            We do not transfer Google user data to others, except as needed to provide those
            features, for security, to comply with the law, or with your consent.
          </li>
          <li>
            No person reads Google user data unless you ask us to, it is needed for security, the
            law requires it, or the data is aggregated and used for internal operations.
          </li>
        </ol>
      </LegalSectionBlock>

      <LegalSectionBlock id="sms" title="Text messages (iMessage and SMS)">
        <p>
          Whether Hale reaches you by iMessage or SMS, your messages pass through our messaging
          provider, Linq, and, for SMS, your mobile carrier.{' '}
          <strong>Treat them as not end-to-end encrypted between you and Hale.</strong> Anyone
          holding the phone can read the thread. That is how these channels work; we cannot change
          it, so we tell you plainly and we write to it.
        </p>
        <p>
          Because the channel is open, the strictest limits we apply anywhere apply to what we put
          into a text message:
        </p>
        <ul>
          <li>
            a health or appointment reminder <strong>names the task, never the condition</strong> —
            &ldquo;Sam&rsquo;s appointment Thursday at 4&rdquo;, never what it is for;
          </li>
          <li>
            for a child aged 13 or older, nothing they wrote goes out over text — only a category or
            a short summary, as described in{' '}
            <a href="#teen-privacy" className="link">
              Teen privacy
            </a>
            ;
          </li>
          <li>
            anything recorded as sensitive is generalized before it is sent — the time survives, the
            subject does not;
          </li>
          <li>
            messages are short by design, one idea each, so there is less in transit to begin with.
          </li>
        </ul>
        <p>
          Your phone number is encrypted where we store it and matched through a keyed hash, so we
          can recognise your family without keeping a readable list of numbers. Your consent to
          receive messages is recorded in the words you used to give it, and you can end it at any
          time: reply STOP to any message and we stop, immediately, until you ask us to start again.
          Standard message and data rates from your carrier apply.
        </p>
        <p>
          If you would rather not use text for a particular request, the web app is available, and
          you can email us at{' '}
          <a href="mailto:privacy@villagehale.com" className="link">
            privacy@villagehale.com
          </a>
          .
        </p>
      </LegalSectionBlock>

      <LegalSectionBlock id="residency-retention" title="Data residency, retention, and security">
        <p>
          <strong>Where data is stored.</strong> Hale&rsquo;s main database is hosted in Canada.
          Some service providers listed in this policy — for example hosting, AI model providers,
          and analytics — may process data outside Canada, mainly in the United States. The named
          providers are in{' '}
          <a href="#sub-processors" className="link">
            Sub-processors
          </a>
          .
        </p>
        <p>
          <strong>Retention.</strong> We keep your family&rsquo;s information only as long as we
          need it. Your profile, your children&rsquo;s profiles, and what Hale remembers about your
          family are kept while you use Hale, and deleted within 30 days of you asking us to delete
          them. You can ask from the web app, or by emailing{' '}
          <a href="mailto:privacy@villagehale.com" className="link">
            privacy@villagehale.com
          </a>
          .
        </p>
        <p>
          Message content, including messages from other members of a group chat Hale is in and from
          people who are not Hale users, is deleted or redacted 12 months after it was sent, and
          sooner if you or they ask. Your answer to Hale&rsquo;s evening question is kept for thirty
          days. Disconnecting Gmail, Calendar, or Drive stops Hale reading that account. The details
          already saved from it are deleted when your account is deleted, and message content within
          them is deleted or redacted on the same 12-month schedule.
        </p>
        <p>
          We keep a record of your consents and approvals, without the text of the messages, until
          your account is deleted. If you pay for Hale, we keep the billing records tax law
          requires. Anyone who is not a Hale user but whose messages Hale received can ask us to
          delete them. In deciding how long to keep anything, we weigh how sensitive it is, what we
          still genuinely need it for, the harm that holding it could cause, and any legal
          requirement to keep it.
        </p>
        <p>
          <strong>Security.</strong> Access to your data is isolated per family at the database
          level (row-level security), data is encrypted in transit, and integration tokens are
          encrypted before they are stored. We log every action Hale takes so it can always be
          reviewed. No system is completely secure and we will not pretend otherwise; if a breach
          ever creates a real risk of significant harm to your family, we will report it to the
          Office of the Privacy Commissioner of Canada — and, where Law 25 applies, to the
          Commission d&rsquo;accès à l&rsquo;information du Québec — and tell you, as those laws
          require.
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

      <LegalSectionBlock id="your-choices" title="Your choices">
        <p>
          Those are the rights the law gives you. These are the switches in the product, and none of
          them requires writing to us:
        </p>
        <ul>
          <li>
            <strong>Stop the texts.</strong> Reply STOP to any message and the messages stop,
            immediately, until you ask us to start again.
          </li>
          <li>
            <strong>Stop the email.</strong> Every non-essential email carries a working unsubscribe
            link; see{' '}
            <a href="#casl" className="link">
              Email and electronic messages
            </a>
            .
          </li>
          <li>
            <strong>Stop the introductions.</strong> Text NO INTROS and Hale will not look for a
            match for your family or raise it again.
          </li>
          <li>
            <strong>Disconnect a tool.</strong> Any integration you connected can be disconnected,
            and any tool you authorized to read from Hale can have that authorization revoked.
          </li>
          <li>
            <strong>Skip the address.</strong> Coarse location is opt-in — local discovery is the
            only thing that needs it, and Hale works without it.
          </li>
          <li>
            <strong>Decline to tell us something.</strong> Optional fields are optional. Some of
            Hale gets less useful without them, and none of Hale stops working.
          </li>
          <li>
            <strong>Cookies on the public website.</strong> On villagehale.com, Google Ads and
            PostHog (analytics and session replay) load only after the visitor taps Accept in the
            cookie banner. If they choose No thanks, or make no choice, neither loads. Visitors can
            change their choice at any time with Cookie settings in the site footer. Vercel Speed
            Insights runs without that choice. Vercel documents it as anonymous performance data: it
            is not tied to a visitor or an IP address, and it does not store information that would
            reconstruct a browsing session or identify someone. Strictly necessary storage, such as
            the theme and language choice, needs no consent. Google Ads may set advertising cookies
            only after Accept. Blocking third-party scripts in your browser also stops that
            measurement and does not affect Hale over text. The product app does not load this tag.
          </li>
        </ul>
      </LegalSectionBlock>

      <LegalSectionBlock id="other-services" title="Other sites and services">
        <p>
          Hale points you at things other people run — a city&rsquo;s registration page, a program,
          a venue. Those sites are not ours and this policy does not cover them; what they collect
          when you arrive is governed by their own privacy practices, which are worth reading before
          you register. The same is true of any tool you connect to Hale.
        </p>
      </LegalSectionBlock>

      <LegalSectionBlock id="casl" title="Email and electronic messages (CASL)">
        <p>
          We send you email that is necessary to run your account — such as security notices and the
          weekly brief and other updates you ask Hale to prepare. If we ever send commercial
          electronic messages, we do so only with your consent, we identify ourselves, and every
          such message includes a clear, working way to unsubscribe. You can opt out of
          non-essential messages at any time without affecting your account.
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
          Our Privacy Officer, the person in charge of the protection of personal information under
          Quebec&rsquo;s Law 25, is <strong>Anzhe Dong, Founder</strong>. For any privacy question,
          or to exercise your rights, email{' '}
          <a href="mailto:privacy@villagehale.com" className="link">
            privacy@villagehale.com
          </a>{' '}
          or write to: Privacy Officer, Village Hale Technologies Inc., 13394 Tenth Line,
          Georgetown, ON L7G 4S8, Canada.
        </p>
      </LegalSectionBlock>
    </LegalLayout>
  );
}
