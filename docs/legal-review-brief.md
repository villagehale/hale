# Legal review brief — Hale (Village Hale Technologies Inc.)

*Prepared for a Canadian privacy/tech lawyer. Goal: a fixed-fee review of our Terms of Service and Privacy Policy for **PIPEDA + Quebec Law 25 + CASL** compliance, with particular attention to **children's data** and **cross-border (US) processing**.*

## 1. The company & product
- **Entity:** Village Hale Technologies Inc., incorporated in **Ontario, Canada** (June 2026). Trading as **Hale**.
- **Product:** A passive, event-driven AI assistant for families across every stage of childhood (ages **0–18**). It surfaces local activities ("the village"), answers parenting questions, tracks a child's development, and — only with a parent's explicit approval — helps carry out tasks (e.g., booking). It handles **sensitive data about children, including newborns.**
- **Stage:** Pre-public-launch (closed beta). One real external user to date.

## 2. What we're asking for
A review of our two public legal documents and the data practices behind them:
- **Terms of Service:** https://app.villagehale.com/terms
- **Privacy Policy:** https://app.villagehale.com/privacy

We drafted these in good faith (clearly marked "not legal advice"). We need them validated and corrected before public launch.

## 3. What we collect
- **Account:** name + email (via Google sign-in), language, timezone.
- **Children's profiles:** first name (last optional), date of birth, optional gender/interests. DOB derives a "stage" (newborn/toddler/child/teen).
- **Care & activity logs:** feeds, naps, milestones, routine notes.
- **AI conversations + derived memory:** questions asked, answers, and a structured memory of inferred facts/preferences.
- **Coarse location only:** city/province/country + at most a postal code / forward-sortation area. **Never** the precise street address (a typed address is used transiently to derive the coarse area and is not retained).
- **Village endorsements:** that a family endorsed an activity (shown only as an aggregate count).
- **Integration tokens (encrypted)** if a parent connects a tool; **audit logs** (every action) + limited technical data (IP, browser).

## 4. Sub-processors & data flows (cross-border)
- **Supabase** — primary database, **hosted in Canada (Toronto, ca-central-1)**. Core family data lives here.
- **Anthropic** — AI model processing — **United States**.
- **Vercel** — app hosting + cookieless analytics — **US / global edge**.
- **Google Maps/Places** — coarse-area + public-venue lookups only (never the precise home).
- **Resend** — transactional/digest email — **US**.
- **PostHog** — product analytics; coarse non-identifying events only (no child data, no message content; opaque id).
- **Langfuse** — AI observability; teen raw content + contact details masked before sending.

Primary data is in Canada; AI, hosting, email, and observability occur in the **US**. We ask for consent to cross-border processing.

## 5. Compliance posture already built
- **Data residency:** primary store in Canada (ca-central-1); serverless functions pinned to a Canadian region.
- **Teen privacy (13+):** raw content redacted from parents **by default** (category/summary only); raw access requires an explicit, logged, time-limited grant; exception for genuine **safety escalation**, in which case the teen is notified.
- **Audit:** every action writes an immutable audit_log row (supports PIPEDA right-to-access).
- **Consent:** capture at sign-up + per sensitive purpose (cross-border, AI processing, integrations, automation) — *implementation in progress.*
- **Two-parent consent** required for actions affecting both parents' data.
- **Autonomy gates:** new accounts observe-only; automation unlocks only per-action-type with explicit approval. **Hard spending caps.**
- **Privacy Officer (Law 25):** **Anzhe Dong, Founder** — privacy@villagehale.com.

## 6. Specific questions / flags for you
1. **Children's data** — is our parental-consent model + capture sufficient under PIPEDA & Law 25 for a product centered on minors (incl. newborns)?
2. **Cross-border (US) processing** — is our disclosure + consent adequate? Any Law 25 transfer-impact-assessment obligations?
3. **CASL** — our digest/marketing email consent + unsubscribe + sender-identification model.
4. **Law 25 specifics** — Privacy Officer designation (done), whether a **privacy impact assessment (PIA)** is required, and the **breach-notification** process we need.
5. **Teen privacy (13+)** approach — is it defensible / age-appropriate?
6. **Retention** — do we need a documented retention schedule, and what's reasonable here?
7. Any **material gaps or risks** in the drafted ToS/Privacy for a children's-data product.

## 7. The ask
A **fixed-fee** review of the two documents + the above questions, with a written summary of required changes. Please share an estimate + timeline. We can implement the document edits ourselves once you flag them.

*Contact: Anzhe Dong, Founder — privacy@villagehale.com*
