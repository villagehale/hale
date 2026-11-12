/**
 * Launch-flag catalog. Each row is one env var the product already reads, plus
 * the PostHog key it maps to. Payment flags are listed separately and are never
 * synced: nothing in PostHog may turn a payment on.
 */

export const POSTHOG_FLAGS_ENABLED_ENV = 'POSTHOG_FLAGS_ENABLED';
export const POSTHOG_FEATURE_FLAGS_KEY_ENV = 'POSTHOG_FEATURE_FLAGS_KEY';

export type FlagParser =
  | 'exact-true'
  | 'trimmed-true'
  | 'trimmed-on'
  | 'exact-on'
  | 'not-exact-false'
  | 'trimmed-not-false'
  | 'trimmed-not-off'
  | 'inverted-disabled'
  | 'multivariate';

/** How a family allowlist combines with the global env value on the fallback path. */
export type AllowlistMode = 'arm' | 'narrow' | 'both';

export interface FlagSpec {
  /** Catalog key passed to isEnabled / flagValue. */
  key: string;
  env: string;
  posthogKey: string;
  type: 'boolean' | 'multivariate';
  parser: FlagParser;
  /** Code default when the env is unset (and PostHog did not answer). */
  default: boolean | string;
  variants?: readonly string[];
  /** Multivariate variant treated as ON for isEnabled and for 100% sync. */
  onVariant?: string;
  allowlistEnv?: string;
  allowlistMode?: AllowlistMode;
  /** Extra AND on the env path only (e.g. preview-only mentions). */
  envAlso?: { env: string; value: string };
  /** Catalog + sync only — no reader is wired on this branch. */
  upcoming?: boolean;
}

function exact<K extends string>(
  key: K,
  env: string,
  extra: Partial<FlagSpec> = {},
): FlagSpec & { key: K } {
  return {
    type: 'boolean',
    parser: 'exact-true',
    default: false,
    posthogKey: extra.posthogKey ?? key,
    ...extra,
    key,
    env,
  };
}

function trimmed<K extends string>(
  key: K,
  env: string,
  extra: Partial<FlagSpec> = {},
): FlagSpec & { key: K } {
  return exact(key, env, { parser: 'trimmed-true', ...extra });
}

export const FLAGS = [
  exact('activity-reviews', 'ACTIVITY_REVIEWS_ENABLED'),
  exact('activity-reviews-surface', 'ACTIVITY_REVIEWS_SURFACE'),
  exact('any-page-spot-watch', 'ANY_PAGE_SPOT_WATCH_ENABLED'),
  exact('autonomous-execute', 'AUTONOMOUS_EXECUTE_ENABLED'),
  exact('booked-detection-backfill', 'BOOKED_DETECTION_BACKFILL_ENABLED'),
  exact('booked-detection', 'BOOKED_DETECTION_ENABLED', {
    allowlistEnv: 'BOOKED_DETECTION_FAMILY_ALLOWLIST',
    allowlistMode: 'arm',
  }),
  exact('browser-use-signup', 'BROWSER_USE_SIGNUP_ENABLED'),
  exact('browser-use-watch', 'BROWSER_USE_WATCH_ENABLED'),
  exact('calendar-alert', 'CALENDAR_ALERT_ENABLED'),
  exact('check-in-anchor', 'CHECK_IN_ANCHOR_ENABLED'),
  exact('cold-start-ladder', 'COLD_START_LADDER_ENABLED'),
  exact('coparent-duty-asks', 'COPARENT_DUTY_ASKS_ENABLED', {
    allowlistEnv: 'COPARENT_DUTY_ASKS_FAMILY_ALLOWLIST',
    allowlistMode: 'arm',
  }),
  exact('coparent-duty-burden-surface', 'COPARENT_DUTY_BURDEN_SURFACE_ENABLED'),
  exact('coparent-duty-lopsided', 'COPARENT_DUTY_LOPSIDED_ENABLED'),
  exact('coparent-duty-memory', 'COPARENT_DUTY_MEMORY_ENABLED'),
  exact('coparent-duty-sends', 'COPARENT_DUTY_SENDS_ENABLED', {
    allowlistEnv: 'COPARENT_DUTY_SENDS_FAMILY_ALLOWLIST',
    allowlistMode: 'arm',
  }),
  exact('email-alert', 'EMAIL_ALERT_ENABLED'),
  exact('email-alert-body', 'EMAIL_ALERT_BODY_ENABLED'),
  exact('f14', 'F14_ENABLED', {
    allowlistEnv: 'F14_FAMILY_ALLOWLIST',
    allowlistMode: 'arm',
  }),
  exact('family-memory-kinds', 'FAMILY_MEMORY_KINDS_ENABLED'),
  exact('first-reply-action-line', 'FIRST_REPLY_ACTION_LINE'),
  exact('first-touch-location-card', 'FIRST_TOUCH_LOCATION_CARD_ENABLED'),
  exact('followup-asks', 'FOLLOWUP_ASKS_ENABLED', {
    allowlistEnv: 'FOLLOWUP_ASKS_FAMILY_ALLOWLIST',
    allowlistMode: 'arm',
  }),
  exact('going-count', 'GOING_COUNT_ENABLED'),
  exact('google-push-sync', 'GOOGLE_PUSH_SYNC_ENABLED'),
  exact('google-write-scopes', 'GOOGLE_WRITE_SCOPES_ENABLED'),
  exact('holding-line', 'HOLDING_LINE_ENABLED', {
    allowlistEnv: 'HOLDING_LINE_FAMILY_ALLOWLIST',
    allowlistMode: 'arm',
  }),
  exact('inbound-photo-facts', 'INBOUND_PHOTO_FACTS_ENABLED'),
  exact('interest-passport', 'INTEREST_PASSPORT_ENABLED'),
  exact('loop-send', 'LOOP_SEND_ENABLED'),
  exact('memory-digest-apply', 'MEMORY_DIGEST_APPLY', {
    allowlistEnv: 'MEMORY_DIGEST_FAMILY_ALLOWLIST',
    allowlistMode: 'both',
  }),
  exact('memory-synthesis-apply', 'MEMORY_SYNTHESIS_APPLY'),
  exact('mid-activity-ask', 'MID_ACTIVITY_ASK_ENABLED'),
  exact('mid-activity-signup-tool', 'MID_ACTIVITY_SIGNUP_TOOL_ENABLED'),
  exact('next-day-checkback', 'NEXT_DAY_CHECKBACK_ENABLED'),
  exact('orphan-user-sweep', 'ORPHAN_USER_SWEEP_ENABLED'),
  exact('parent-calendar-mirror', 'PARENT_CALENDAR_MIRROR_ENABLED'),
  exact('registration-assisted-run', 'REGISTRATION_ASSISTED_RUN_ENABLED'),
  exact('registration-ladder', 'REGISTRATION_LADDER_ENABLED'),
  exact('registration-plan-run', 'REGISTRATION_PLAN_RUN_ENABLED'),
  exact('same-activity-meet', 'SAME_ACTIVITY_MEET_ENABLED'),
  exact('signup-sandbox-runtime', 'SIGNUP_SANDBOX_RUNTIME_ENABLED'),
  exact('travel-brief', 'TRAVEL_BRIEF_ENABLED', {
    allowlistEnv: 'TRAVEL_BRIEF_FAMILY_ALLOWLIST',
    allowlistMode: 'narrow',
  }),
  exact('village-intros', 'VILLAGE_INTROS_ENABLED'),
  exact('watched-spots', 'WATCHED_SPOTS_ENABLED'),
  exact('weekday-care', 'WEEKDAY_CARE_ENABLED'),
  exact('workstreams', 'WORKSTREAMS_ENABLED'),
  exact('group-shared-lists', 'GROUP_SHARED_LISTS_ENABLED'),
  exact('coparent-split-duty', 'COPARENT_SPLIT_DUTY_ENABLED', { upcoming: true }),
  exact('team-schedule-changes', 'TEAM_SCHEDULE_CHANGES_ENABLED', { upcoming: true }),
  exact('untrusted-field-marking', 'UNTRUSTED_FIELD_MARKING_ENABLED', { upcoming: true }),
  exact('friend-voice-leftover-marks', 'FRIEND_VOICE_LEFTOVER_MARKS_ENABLED', {
    upcoming: true,
  }),
  exact('prompt-cache-layout', 'PROMPT_CACHE_LAYOUT_ENABLED', { upcoming: true }),

  trimmed('linq-group-carpool', 'LINQ_GROUP_CARPOOL_ENABLED'),
  trimmed('linq-group-conflict-alerts', 'LINQ_GROUP_CONFLICT_ALERTS_ENABLED'),
  trimmed('cross-parent-clash', 'CROSS_PARENT_CLASH_ENABLED'),
  trimmed('linq-group-members', 'LINQ_GROUP_MEMBERS_ENABLED'),
  // VIL-475: Production may light it like any other env (preview-only gate lifted).
  trimmed('linq-group-mentions', 'LINQ_GROUP_MENTIONS_ENABLED'),
  trimmed('linq-group-onboarding-v2', 'LINQ_GROUP_ONBOARDING_V2_ENABLED'),
  trimmed('linq-group-plan-rsvp', 'LINQ_GROUP_PLAN_RSVP_ENABLED'),
  trimmed('linq-group-polls', 'LINQ_GROUP_POLLS_ENABLED'),
  trimmed('linq-group-reminders', 'LINQ_GROUP_REMINDERS_ENABLED'),
  trimmed('linq-group-turn-ai', 'LINQ_GROUP_TURN_AI_ENABLED'),
  trimmed('linq-multi-family-groups', 'LINQ_MULTI_FAMILY_GROUPS_ENABLED'),
  trimmed('linq-stickers', 'LINQ_STICKERS_ENABLED'),
  trimmed('linq-voice-memos', 'LINQ_VOICE_MEMOS_ENABLED'),
  trimmed('linq-experiences', 'LINQ_EXPERIENCES_ENABLED'),
  trimmed('linq-group-leave', 'LINQ_GROUP_LEAVE_ENABLED'),
  trimmed('linq-group-common-time', 'LINQ_GROUP_COMMON_TIME_ENABLED'),
  trimmed('calendar-write-notice', 'CALENDAR_WRITE_NOTICE_ENABLED'),
  trimmed('group-plan-calendar-report', 'GROUP_PLAN_CALENDAR_REPORT_ENABLED'),
  trimmed('village-intro-groups', 'VILLAGE_INTRO_GROUPS_ENABLED'),

  exact('authorized-signup', 'AUTHORIZED_SIGNUP_ENABLED', { parser: 'trimmed-on' }),
  exact('booking-reference-connector', 'BOOKING_REFERENCE_CONNECTOR_ENABLED', {
    parser: 'trimmed-on',
  }),
  exact('first-touch-ladder', 'FIRST_TOUCH_LADDER_ENABLED', { parser: 'trimmed-on' }),
  exact('linq-polls', 'LINQ_POLLS', { parser: 'trimmed-on' }),
  exact('social-watchlist', 'SOCIAL_WATCHLIST', { parser: 'exact-on' }),

  exact('general-answer-search', 'GENERAL_ANSWER_SEARCH_ENABLED', {
    parser: 'not-exact-false',
    default: true,
  }),
  exact('gcal-past-classify-skip', 'GCAL_PAST_CLASSIFY_SKIP', {
    parser: 'trimmed-not-false',
    default: true,
  }),
  exact('linq-group-coparent', 'LINQ_GROUP_COPARENT', {
    parser: 'trimmed-not-off',
    default: true,
  }),
  exact('voice', 'VOICE_DISABLED', {
    parser: 'inverted-disabled',
    default: true,
  }),

  {
    key: 'claim-reader-mode',
    env: 'CLAIM_READER_MODE',
    posthogKey: 'claim-reader-mode',
    type: 'multivariate',
    parser: 'multivariate',
    default: 'off',
    variants: ['off', 'shadow', 'enforce'],
    onVariant: 'enforce',
  },
  {
    key: 'proactive-cadence',
    env: 'PROACTIVE_CADENCE',
    posthogKey: 'proactive-cadence',
    type: 'multivariate',
    parser: 'multivariate',
    default: 'off',
    variants: ['off', 'shadow', 'live'],
    onVariant: 'live',
  },
  {
    key: 'registration-date-check',
    env: 'REGISTRATION_DATE_CHECK',
    posthogKey: 'registration-date-check',
    type: 'multivariate',
    parser: 'multivariate',
    default: 'off',
    variants: ['off', 'shadow', 'enforce'],
    onVariant: 'enforce',
  },
] as const satisfies readonly FlagSpec[];

export type FlagKey = (typeof FLAGS)[number]['key'];

export const FLAG_BY_KEY: Record<FlagKey, FlagSpec> = Object.fromEntries(
  FLAGS.map((flag) => [flag.key, flag]),
) as Record<FlagKey, FlagSpec>;

export const FLAG_BY_ENV: Record<string, FlagSpec> = Object.fromEntries(
  FLAGS.map((flag) => [flag.env, flag]),
);

/**
 * Payment stays env-only and OFF. These are never created in PostHog, so a
 * mis-clicked dashboard cannot start a charge. Runtime still stops before any
 * payment > $0 and still caps a signup run at $3.
 */
export const PAYMENT_ENV_ONLY = [
  {
    env: 'BROWSER_USE_SIGNUP_PAYMENT_ENABLED',
    posthogKey: null,
    type: 'boolean' as const,
    note: 'env-only; exact `true`; nothing in PostHog may turn this on',
  },
  {
    env: 'LINQ_APP_CLIP_PAY_ENABLED',
    posthogKey: null,
    type: 'boolean' as const,
    note: 'env-only; stays OFF; nothing in PostHog may turn this on',
  },
] as const;

export function getFlag(key: string): FlagSpec {
  const spec = FLAG_BY_KEY[key as FlagKey];
  if (!spec) throw new Error(`unknown launch flag: ${key}`);
  return spec;
}

export function parseAllowlist(env: Record<string, string | undefined>, name: string): Set<string> {
  return new Set(
    (env[name] ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id.length > 0),
  );
}

export function parseEnvBoolean(spec: FlagSpec, env: Record<string, string | undefined>): boolean {
  const raw = env[spec.env];
  switch (spec.parser) {
    case 'exact-true':
      return raw === 'true';
    case 'trimmed-true':
      return (raw ?? '').trim() === 'true';
    case 'trimmed-on':
      return (raw ?? '').trim() === 'on';
    case 'exact-on':
      return raw === 'on';
    case 'not-exact-false':
      return raw !== 'false';
    case 'trimmed-not-false':
      return raw?.trim() !== 'false';
    case 'trimmed-not-off':
      return (raw ?? '').trim() !== 'off';
    case 'inverted-disabled':
      return raw !== 'true';
    case 'multivariate':
      return envVariant(spec, env) !== spec.default;
  }
}

export function envVariant(spec: FlagSpec, env: Record<string, string | undefined>): string {
  const raw = env[spec.env];
  if (raw !== undefined && spec.variants?.includes(raw)) return raw;
  return String(spec.default);
}

/**
 * Env-path (and PostHog-miss fallback) boolean, including family allowlists
 * and preview-only extra gates. Kill switch is applied by isEnabled, not here.
 */
export function envEnabled(
  spec: FlagSpec,
  familyId: string | undefined,
  env: Record<string, string | undefined>,
): boolean {
  if (spec.envAlso && env[spec.envAlso.env] !== spec.envAlso.value) return false;
  if (spec.type === 'multivariate') {
    return envVariant(spec, env) !== spec.default;
  }
  const on = parseEnvBoolean(spec, env);
  if (!spec.allowlistEnv || !spec.allowlistMode) return on;
  const list = parseAllowlist(env, spec.allowlistEnv);
  if (spec.allowlistMode === 'arm') {
    if (on) return true;
    return familyId !== undefined && list.has(familyId);
  }
  if (spec.allowlistMode === 'narrow') {
    if (!on) return false;
    if (list.size === 0) return true;
    return familyId === undefined || list.has(familyId);
  }
  // both: flag AND a non-empty allowlist (memory digest). A named family must
  // be on the list; a process-wide read is true only when the list is non-empty.
  if (!on || list.size === 0) return false;
  return familyId === undefined || list.has(familyId);
}
