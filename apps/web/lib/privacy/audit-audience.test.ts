import { afterEach, describe, expect, it } from 'vitest';
import { AUDIT_LOG_AUDIENCE_ENABLED_ENV, auditLogAudienceEnabled } from './audit-audience';

describe('auditLogAudienceEnabled', () => {
  afterEach(() => {
    Reflect.deleteProperty(process.env, AUDIT_LOG_AUDIENCE_ENABLED_ENV);
  });

  it('is off unless the value is exactly true', () => {
    expect(auditLogAudienceEnabled({})).toBe(false);
    expect(auditLogAudienceEnabled({ [AUDIT_LOG_AUDIENCE_ENABLED_ENV]: undefined })).toBe(false);
    expect(auditLogAudienceEnabled({ [AUDIT_LOG_AUDIENCE_ENABLED_ENV]: '' })).toBe(false);
    expect(auditLogAudienceEnabled({ [AUDIT_LOG_AUDIENCE_ENABLED_ENV]: 'TRUE' })).toBe(false);
    expect(auditLogAudienceEnabled({ [AUDIT_LOG_AUDIENCE_ENABLED_ENV]: 'true\n' })).toBe(false);
    expect(auditLogAudienceEnabled({ [AUDIT_LOG_AUDIENCE_ENABLED_ENV]: 'on' })).toBe(false);
    expect(auditLogAudienceEnabled({ [AUDIT_LOG_AUDIENCE_ENABLED_ENV]: '1' })).toBe(false);
    expect(auditLogAudienceEnabled({ [AUDIT_LOG_AUDIENCE_ENABLED_ENV]: 'true' })).toBe(true);
  });
});
