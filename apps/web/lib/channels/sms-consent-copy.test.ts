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

const NAMES_THE_WEEKLY_PLAN = /weekly plan/i;
const TEACHES_A_KEYWORD = /\bSTOP\b|\breply\b/i;

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

  it('describes what Hale texts now in v2: the kids’ year, and stopping on any wording', () => {
    expect(SMS_CONSENT_COPY).toContain("the kids' year");
    expect(SMS_CONSENT_COPY).toContain('activities');
    expect(SMS_CONSENT_COPY).toContain('registration dates');
    expect(SMS_CONSENT_COPY).toContain('reminders');
    expect(SMS_CONSENT_COPY).toContain("questions that need the parent's OK");
    expect(SMS_CONSENT_COPY).toContain('stops when the parent asks, in any wording');
  });

  it('promises no weekly plan and teaches no keyword in v2', () => {
    // Positive control: both patterns fire on the v1 text, so a miss on v2 is a real absence.
    expect(V1_AS_RECORDED).toMatch(NAMES_THE_WEEKLY_PLAN);
    expect(V1_AS_RECORDED).toMatch(TEACHES_A_KEYWORD);

    expect(SMS_CONSENT_COPY).not.toMatch(NAMES_THE_WEEKLY_PLAN);
    expect(SMS_CONSENT_COPY).not.toMatch(TEACHES_A_KEYWORD);
  });

  it('has no words for a scope that is not a version of this copy', () => {
    expect(smsConsentCopyForScope('sms_intake_origination')).toBeUndefined();
    expect(smsConsentCopyForScope('sms_service_messages:v3')).toBeUndefined();
  });
});
