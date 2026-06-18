import {
  Body,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Preview,
  Section,
  Text,
} from '@react-email/components';

/*
 * Branded waitlist welcome email. Built with React Email so the worker digest
 * can reuse the same component pattern later. Colors mirror apps/site's design
 * system (globals.css): Prussian #01204F ink, Linen #f6f1e7 page, Apricot
 * #c8622d as the warm large-graphic accent. Styles are inline (not Tailwind)
 * because inline styles are the most portable across email clients.
 *
 * Rule #1 (privacy): no PII in the body — not even the recipient's email. The
 * only audience-specific fact is "you joined", which the recipient already
 * knows. The address rides only in the envelope.
 */

const PRUSSIAN = '#01204F';
const LINEN = '#f6f1e7';
const APRICOT = '#c8622d';
const SLATE_GREEN = '#33486b';
const FADED_SAGE = '#5b6b86';

const FONT_STACK =
  'Inter, -apple-system, "Segoe UI", system-ui, Helvetica, Arial, sans-serif';

/** White sea-turtle silhouette — the same domed-shell + reaching-head profile
 * as components/illos.tsx and the OG card. Glows on the Prussian header band. */
function Turtle() {
  return (
    <svg
      width="96"
      height="66"
      viewBox="0 0 152 104"
      fill={LINEN}
      role="img"
      aria-label="Hale sea turtle"
    >
      <path d="M32 74 Q32 34 70 34 Q108 34 108 74 Z" />
      <rect x="32" y="64" width="76" height="13" rx="6.5" />
      <rect x="22" y="68" width="15" height="12" rx="6" />
      <rect x="38" y="72" width="23" height="15" rx="7.5" />
      <rect x="78" y="72" width="25" height="15" rx="7.5" />
      <rect x="104" y="48" width="22" height="15" rx="7.5" />
      <circle cx="126" cy="50" r="13" />
    </svg>
  );
}

export function WaitlistWelcomeEmail() {
  return (
    <Html lang="en">
      <Head />
      <Preview>You&rsquo;re on the Hale waitlist — the village your family lost, rebuilt.</Preview>
      <Body style={{ margin: 0, backgroundColor: LINEN, fontFamily: FONT_STACK }}>
        <Container style={{ margin: '0 auto', maxWidth: '37.5em', padding: '24px 0 40px' }}>
          <Section
            style={{
              backgroundColor: PRUSSIAN,
              borderRadius: '18px',
              padding: '40px 40px 32px',
              textAlign: 'center',
            }}
          >
            <Turtle />
            <Heading
              as="h1"
              style={{
                margin: '16px 0 0',
                color: LINEN,
                fontSize: '30px',
                fontWeight: 700,
                letterSpacing: '-0.02em',
              }}
            >
              You&rsquo;re on the list.
            </Heading>
            <Text style={{ margin: '12px 0 0', color: APRICOT, fontSize: '15px', fontWeight: 600 }}>
              Hale — the village your family lost, rebuilt.
            </Text>
          </Section>

          <Section style={{ padding: '32px 8px 0' }}>
            <Text style={{ margin: 0, color: SLATE_GREEN, fontSize: '16px', lineHeight: 1.65 }}>
              Thank you for joining. Hale is a calm companion that finds the genuinely good local
              things to do — the class, the story-time, the festival — matched to your kid&rsquo;s
              age and stage, and then helps make them happen.
            </Text>
            <Text
              style={{ margin: '20px 0 0', color: SLATE_GREEN, fontSize: '16px', lineHeight: 1.65 }}
            >
              It grows up right alongside your child: newborn, toddler, child, teenager. And it never
              acts until you have said it may — your inbox first, your calendar second, autonomy
              earned slowly.
            </Text>
            <Text
              style={{ margin: '20px 0 0', color: SLATE_GREEN, fontSize: '16px', lineHeight: 1.65 }}
            >
              We&rsquo;ll write to you when the early cohort opens. Nothing else, ever. Your
              family&rsquo;s data stays in Canada — PIPEDA, Quebec Law 25, and CASL compliant by
              default.
            </Text>
          </Section>

          <Hr style={{ margin: '32px 8px 0', borderColor: 'rgba(1, 32, 79, 0.12)' }} />

          <Section style={{ padding: '20px 8px 0' }}>
            <Text style={{ margin: 0, color: FADED_SAGE, fontSize: '13px', lineHeight: 1.6 }}>
              Hale · Toronto · Canada · a research preview
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}

export default WaitlistWelcomeEmail;
