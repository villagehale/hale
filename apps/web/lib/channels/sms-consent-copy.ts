/**
 * The exact CASL consent copy shown at capture, versioned. Kept in its own
 * dependency-free module so the client Settings component can render the SAME
 * string the server records as consent — without pulling the server-only enrolment
 * engine (db / node:crypto) into the client bundle. Bump the version if the text
 * changes; the version is stored in each consent row's scope.
 */
export const SMS_CONSENT_COPY =
  "Hale will text this number your family's weekly plan, reminders, and questions that need your OK. Msg&data rates may apply. Reply STOP anytime to turn this off.";

export const SMS_CONSENT_COPY_VERSION = 'v1';

/** consent_scope value — pins the consent-copy version the parent agreed to. */
export const SMS_CONSENT_SCOPE = `sms_service_messages:${SMS_CONSENT_COPY_VERSION}`;
