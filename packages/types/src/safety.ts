/**
 * Per-family safety policy. Reviewer consults this for every draft action.
 * Defaults are configured at family creation and editable in /settings.
 */
export interface SafetyPolicy {
  spendingCaps: {
    perActionMaxUsd: number;
    perDayMaxUsd: number;
    perMonthMaxUsd: number;
    categoriesRequiringApproval: string[];
  };

  recipientRules: {
    allowlist: string[];
    blocklist: string[];
    autoAddIfRepliedTo: boolean;
    medicalRecipientsRequireApproval: boolean;
    legalRecipientsRequireApproval: boolean;
  };

  timeWindow: {
    /** 24h format, "HH:mm" */
    allowActionsBetween: [string, string];
    timezone: string;
    blackoutDates: string[];
  };

  actionTypeOverrides: Record<string, 'always_ask' | 'autonomous_allowed' | 'never'>;

  piiProtection: {
    redactInOutgoing: boolean;
  };

  /** Single-click family pause for 24h. */
  pausedUntil?: string;
}

export const DEFAULT_SAFETY_POLICY: SafetyPolicy = {
  spendingCaps: {
    perActionMaxUsd: 50,
    perDayMaxUsd: 200,
    perMonthMaxUsd: 1000,
    categoriesRequiringApproval: ['medical', 'legal'],
  },
  recipientRules: {
    allowlist: [],
    blocklist: [],
    autoAddIfRepliedTo: true,
    medicalRecipientsRequireApproval: true,
    legalRecipientsRequireApproval: true,
  },
  timeWindow: {
    allowActionsBetween: ['06:00', '22:00'],
    timezone: 'America/Toronto',
    blackoutDates: [],
  },
  actionTypeOverrides: {},
  piiProtection: {
    redactInOutgoing: true,
  },
};
