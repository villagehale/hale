/**
 * What a parent's SMS consent covers, versioned. No parent is shown these sentences
 * (Hale has no signup page; how it says what it does and how to stop is its own first
 * reply): each is the internal description of the scope, and a consent row's
 * consent_scope names the version it was recorded under. A recorded version's words
 * are a legal record and are never edited — a change of scope is a new version, and
 * new rows record the newest.
 */
const SMS_CONSENT_COPY_BY_VERSION = {
  v1: "Hale will text this number your family's weekly plan, reminders, and questions that need your OK. Msg&data rates may apply. Reply STOP anytime to turn this off.",
  v2: "Hale texts this number about the kids' year: activities, registration dates, reminders, and questions that need the parent's OK. Hale stops when the parent asks, in any wording.",
} as const;

export const SMS_CONSENT_COPY_VERSION = 'v2';

export const SMS_CONSENT_COPY = SMS_CONSENT_COPY_BY_VERSION[SMS_CONSENT_COPY_VERSION];

function smsConsentScope(version: string): string {
  return `sms_service_messages:${version}`;
}

/** consent_scope value — pins the consent-copy version the parent agreed to. */
export const SMS_CONSENT_SCOPE = smsConsentScope(SMS_CONSENT_COPY_VERSION);

/** The exact words a consent row's consent_scope was recorded under. */
export function smsConsentCopyForScope(consentScope: string): string | undefined {
  return Object.entries(SMS_CONSENT_COPY_BY_VERSION).find(
    ([version]) => smsConsentScope(version) === consentScope,
  )?.[1];
}
