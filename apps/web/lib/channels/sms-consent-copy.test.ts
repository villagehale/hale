import { describe, expect, it } from 'vitest';
import {
  SMS_CONSENT_COPY,
  SMS_CONSENT_COPY_VERSION,
  SMS_CONSENT_SCOPE,
  smsConsentCopyForScope,
} from './sms-consent-copy';

// The words v1 consents were recorded under, copied from the record as it shipped —
// never from the module under test, so an edit to the v1 text fails here.
const V1_AS_RECORDED =
  "Hale will text this number your family's weekly plan, reminders, and questions that need your OK. Msg&data rates may apply. Reply STOP anytime to turn this off.";

describe('SMS consent scope copy', () => {
  it('keeps a v1 consent row pointing at the exact words it was recorded under', () => {
    expect(smsConsentCopyForScope('sms_service_messages:v1')).toBe(V1_AS_RECORDED);
  });

  it('records new consents under v2', () => {
    expect(SMS_CONSENT_COPY_VERSION).toBe('v2');
    expect(SMS_CONSENT_SCOPE).toBe('sms_service_messages:v2');
    expect(smsConsentCopyForScope(SMS_CONSENT_SCOPE)).toBe(SMS_CONSENT_COPY);
    expect(SMS_CONSENT_COPY).not.toBe(V1_AS_RECORDED);
  });

  it('has no words for a scope that is not a version of this copy', () => {
    expect(smsConsentCopyForScope('sms_intake_origination')).toBeUndefined();
    expect(smsConsentCopyForScope('sms_service_messages:v3')).toBeUndefined();
  });
});
