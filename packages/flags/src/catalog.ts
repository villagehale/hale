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
  /**
   * Multivariate kill variant, for one whose default is ON. The env value, trimmed, picks
   * it, and so does a trimmed `false` (a trailing newline from `vercel env add` must
   * still kill, and `=false` is the kill switch on every flag), and a kill or a
   * PostHog flag switched off resolves to it instead of the default. Arming values stay
   * exact. Unset: the default is the off variant, as before.
   */
  offVariant?: string;
  allowlistEnv?: string;
  allowlistMode?: AllowlistMode;
  /** Extra AND on the env path only (e.g. preview-only mentions). */
  envAlso?: { env: string; value: string };
  /** Catalog + sync only — no reader is wired on this branch. */
  upcoming?: boolean;
  /**
   * Read from the env in every mode and never created in PostHog. For a gate that runs
   * before any family is known: PostHog answers a family-scoped flag "off" for no family,
   * and a 100% rollout would turn it on with no env value at all.
   */
  envOnly?: boolean;
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
  exact('caregiver-reminder-model-copy', 'CAREGIVER_REMINDER_MODEL_COPY_ENABLED'),
  exact('check-in-anchor', 'CHECK_IN_ANCHOR_ENABLED'),
  exact('claim-read-own-mirrors', 'CLAIM_READ_OWN_MIRRORS_ENABLED'),
  exact('claim-refusal-store', 'CLAIM_REFUSAL_STORE_ENABLED'),
  exact('coach-bubbles', 'COACH_BUBBLES_ENABLED', {
    parser: 'trimmed-not-false',
    default: true,
  }),
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
  exact('deep-followup-now', 'DEEP_FOLLOWUP_NOW_ENABLED', {
    parser: 'trimmed-not-false',
    default: true,
  }),
  exact('email-alert', 'EMAIL_ALERT_ENABLED'),
  exact('email-alert-body', 'EMAIL_ALERT_BODY_ENABLED'),
  // VIL-762. One alert per real appointment, and a clash with a known commitment
  // is named in that alert. The model decides both. Exact `true`. Env-only: the
  // read has to stay exact `true` with no family on the call, and a PostHog
  // answer must not turn it on from `true\n` or from unset.
  exact('email-alert-once', 'EMAIL_ALERT_ONCE_ENABLED', { envOnly: true }),
  exact('f14', 'F14_ENABLED', {
    allowlistEnv: 'F14_FAMILY_ALLOWLIST',
    allowlistMode: 'arm',
  }),
  exact('family-memory-kinds', 'FAMILY_MEMORY_KINDS_ENABLED'),
  exact('family-home-metro', 'FAMILY_HOME_METRO_ENABLED'),
  exact('family-tz-resolve', 'FAMILY_TZ_RESOLVE_ENABLED'),
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
    parser: 'trimmed-not-false',
    default: true,
  }),
  // VIL-717. A slow 1:1 ask (a registration, research, a find) gets a model-written ack
  // with a time from facts, and one honest note if that time passes with no answer.
  // Exact `true`; anything else, `true\n` included, is off.
  exact('ack-eta', 'ACK_ETA_ENABLED', { envOnly: true }),
  exact('inbound-burst', 'INBOUND_BURST_ENABLED', {
    parser: 'trimmed-not-false',
    default: true,
  }),
  exact('inbound-midturn', 'INBOUND_MIDTURN_ENABLED', {
    parser: 'trimmed-not-false',
    default: true,
  }),
  exact('inbound-photo-facts', 'INBOUND_PHOTO_FACTS_ENABLED'),
  exact('intake-stated-place', 'INTAKE_STATED_PLACE_ENABLED'),
  exact('intake-photo-read', 'INTAKE_PHOTO_READ_ENABLED'),
  exact('interest-passport', 'INTEREST_PASSPORT_ENABLED'),
  exact('join-door-model-copy', 'JOIN_DOOR_MODEL_COPY_ENABLED'),
  exact('loop-send', 'LOOP_SEND_ENABLED'),
  exact('memory-digest-apply', 'MEMORY_DIGEST_APPLY', {
    allowlistEnv: 'MEMORY_DIGEST_FAMILY_ALLOWLIST',
    allowlistMode: 'both',
  }),
  exact('memory-synthesis-apply', 'MEMORY_SYNTHESIS_APPLY'),
  exact('mid-activity-ask', 'MID_ACTIVITY_ASK_ENABLED'),
  exact('mid-activity-signup-tool', 'MID_ACTIVITY_SIGNUP_TOOL_ENABLED'),
  exact('next-day-checkback', 'NEXT_DAY_CHECKBACK_ENABLED', {
    parser: 'trimmed-not-false',
    default: true,
  }),
  exact('orphan-user-sweep', 'ORPHAN_USER_SWEEP_ENABLED'),
  exact('parent-calendar-mirror', 'PARENT_CALENDAR_MIRROR_ENABLED'),
  exact('party-guest-model-copy', 'PARTY_GUEST_MODEL_COPY_ENABLED', { envOnly: true }),
  exact('registration-assisted-run', 'REGISTRATION_ASSISTED_RUN_ENABLED'),
  exact('registration-ladder', 'REGISTRATION_LADDER_ENABLED'),
  exact('registration-plan-run', 'REGISTRATION_PLAN_RUN_ENABLED'),
  // VIL-715. Pre-flight and approval binding on top of the plan lane. Exact `true`.
  exact('registration-preflight', 'REGISTRATION_PREFLIGHT_ENABLED', {
    envOnly: true,
    allowlistEnv: 'REGISTRATION_PREFLIGHT_FAMILIES',
    allowlistMode: 'narrow',
  }),
  exact('plan-ops-stop', 'PLAN_OPS_STOP_ENABLED', { envOnly: true }),
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
  // VIL-707. A failed opt-out read does not reach the coach. Exact `true`.
  exact('opt-out-unread-hold-turn', 'OPT_OUT_UNREAD_HOLD_TURN_ENABLED'),
  // VIL-707. A hold write that throws ends the turn. Exact `true`.
  exact('opt-out-hold-write-stops-turn', 'OPT_OUT_HOLD_WRITE_STOPS_TURN_ENABLED'),
  // A stop reading keeps its text's hold until the stop is recorded. Exact `true`.
  exact('opt-out-hold-until-stop-commits', 'OPT_OUT_HOLD_UNTIL_STOP_COMMITS_ENABLED'),
  // VIL-707. An in-flight group reminder with no provider id can be cancelled,
  // and the send checks opt-out again. Exact `true`.
  exact('group-reminder-inflight-cancel', 'GROUP_REMINDER_INFLIGHT_CANCEL_ENABLED'),
  // VIL-728. After a run of Hale group messages with no seated person speaking, Hale
  // answers nobody unseated in that chat until a seated person speaks. Exact `true`.
  exact('group-loop-guard', 'GROUP_LOOP_GUARD_ENABLED', { envOnly: true }),
  // VIL-719. The three-tier ask policy: an ask-first kind runs only on the parent's
  // recorded yes, a just-do kind sends no on-its-own text, and a tell-after text the
  // model cannot write pages #ops. Exact `true`. Env-only (VIL-755): a PostHog sync must
  // never light a policy that changes who gets texted.
  exact('ask-policy-tiers', 'ASK_POLICY_TIERS_ENABLED', { envOnly: true }),
  // VIL-740. A send key names the family, so one family's text cannot use up another's.
  exact('family-scoped-send-keys', 'FAMILY_SCOPED_SEND_KEYS_ENABLED', { envOnly: true }),
  // VIL-749 / VIL-753. One send path: a stable family-scoped Linq key, and a row
  // that says sent only after Linq accepts. Env-only: a failure has no family for
  // PostHog, and a synced 100% flag would light this with no env value.
  exact('parent-send-receipt', 'PARENT_SEND_RECEIPT_ENABLED', { envOnly: true }),
  // VIL-742. The RSVP page names no reply keyword. Exact `true`.
  exact('rsvp-guest-plain-stop', 'RSVP_GUEST_PLAIN_STOP_ENABLED'),
  // VIL-744. The group lines, the coach's answer to doubt and two app pages name no reply
  // keyword. Exact `true`.
  exact('no-stop-keyword-copy', 'NO_STOP_KEYWORD_COPY_ENABLED'),
  exact('coparent-split-duty', 'COPARENT_SPLIT_DUTY_ENABLED', { upcoming: true }),
  exact('team-schedule-changes', 'TEAM_SCHEDULE_CHANGES_ENABLED', { upcoming: true }),
  // VIL-734. A team-schedule driver text is on the ledger as sent only once Linq accepts
  // it; a refused send is retried and the last try pages #ops. Exact `true`.
  exact('team-schedule-send-receipt', 'TEAM_SCHEDULE_SEND_RECEIPT_ENABLED'),
  // VIL-734. A group reminder that closes failed pages #ops. Exact `true`.
  exact('group-reminder-unsent-page', 'GROUP_REMINDER_UNSENT_PAGE_ENABLED'),
  exact('untrusted-field-marking', 'UNTRUSTED_FIELD_MARKING_ENABLED'),
  exact('friend-voice-model-fields', 'FRIEND_VOICE_MODEL_FIELDS_ENABLED'),
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
  trimmed('linq-reactions', 'LINQ_REACTIONS_ENABLED', {
    parser: 'trimmed-not-false',
    default: true,
  }),
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
  exact('linq-refused-for-certain', 'LINQ_REFUSED_FOR_CERTAIN_ENABLED', { envOnly: true }),
  exact('social-watchlist', 'SOCIAL_WATCHLIST', { parser: 'exact-on' }),

  exact('general-answer-search', 'GENERAL_ANSWER_SEARCH_ENABLED', {
    parser: 'not-exact-false',
    default: true,
  }),
  exact('gcal-past-classify-skip', 'GCAL_PAST_CLASSIFY_SKIP', {
    parser: 'trimmed-not-false',
    default: true,
  }),
  trimmed('own-city-registration', 'OWN_CITY_REGISTRATION_ENABLED'),
  trimmed('school-break', 'SCHOOL_BREAK_ENABLED'),
  exact('linq-group-coparent', 'LINQ_GROUP_COPARENT', {
    parser: 'trimmed-not-off',
    default: true,
  }),
  exact('secret-santa', 'SECRET_SANTA', { parser: 'trimmed-not-false', default: true }),
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
    default: 'enforce',
    variants: ['off', 'shadow', 'enforce'],
    onVariant: 'enforce',
    offVariant: 'off',
  },
  exact('proactive-family-decision-cap', 'PROACTIVE_FAMILY_DECISION_CAP_ENABLED'),
  exact('proactive-review-guards', 'PROACTIVE_REVIEW_GUARDS_ENABLED'),
  exact('proactive-sends-paused', 'PROACTIVE_SENDS_PAUSED'),
  exact('nudge-model-only', 'NUDGE_MODEL_ONLY_ENABLED', { envOnly: true }),
  exact('ingest-body-max', 'INGEST_BODY_MAX_ENABLED', { envOnly: true }),
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
    env: 'REGISTRATION_FREE_CHECKOUT_ENABLED',
    posthogKey: null,
    type: 'boolean' as const,
    note: 'env-only; exact `true`, and only for the family ids in REGISTRATION_FREE_CHECKOUT_FAMILIES (an empty list is off); presses complete only on a $0 order bound as free; nothing in PostHog may turn this on',
  },
  {
    env: 'LINQ_APP_CLIP_PAY_ENABLED',
    posthogKey: null,
    type: 'boolean' as const,
    note: 'env-only; stays OFF; nothing in PostHog may turn this on',
  },
  {
    env: 'HOLIDAY_PROMO_ENABLED',
    posthogKey: null,
    type: 'boolean' as const,
    note: 'env-only; exact `true`; founding checkout + USD list path; PROMO_PREVIEW_FAMILY_IDS / PROMO_PREVIEW_TOKEN are separate env-only proofs while this stays off; nothing in PostHog may turn this on',
  },
  {
    env: 'PROMO_NEW_VISITOR_CHECKOUT_ENABLED',
    posthogKey: null,
    type: 'boolean' as const,
    note: 'env-only; exact `true`; ads new-visitor OTP + pending family + Stripe; nothing in PostHog may turn this on',
  },
  {
    env: 'CONVERSIONS_API_ENABLED',
    posthogKey: null,
    type: 'boolean' as const,
    note: 'env-only; exact `true`; Google Ads Website Purchase + Meta Pixel PageView. Site PageView also needs NEXT_PUBLIC_CONVERSIONS_API_ENABLED at build. Nothing in PostHog may turn this on',
  },
  {
    env: 'META_CAPI_ENABLED',
    posthogKey: null,
    type: 'boolean' as const,
    note: 'env-only; exact `true`; Meta Conversions API Purchase; nothing in PostHog may turn this on',
  },
  {
    env: 'CHECKOUT_SERVER_CURRENCY_ENABLED',
    posthogKey: null,
    type: 'boolean' as const,
    note: 'env-only; exact `true`; checkout currency is US/CA geo only, no client currency, no USD-to-CAD list fallback; nothing in PostHog may turn this on',
  },
  {
    env: 'CHECKOUT_SUCCESS_STATES_ENABLED',
    posthogKey: null,
    type: 'boolean' as const,
    note: 'env-only; exact `true`; the checkout success page picks its state from Stripe and the DB. Read by apps/web and apps/site, so both Vercel projects carry it, hale-web first; nothing in PostHog may turn this on',
  },
  {
    env: 'STRIPE_BILLING_REVOKE_ENABLED',
    posthogKey: null,
    type: 'boolean' as const,
    note: 'env-only; exact `true`; refund and dispute webhooks revoke the tier, checkout waits for an applied billing event, reconcile pages #ops; nothing in PostHog may turn this on',
  },
  {
    env: 'STRIPE_REFUND_ENDS_SUBSCRIPTION_ENABLED',
    posthogKey: null,
    type: 'boolean' as const,
    note: 'env-only; exact `true`; the plan follows what Stripe says is still paid: every entitlement event re-reads Stripe, and a full refund of the current period cancels that one subscription; only takes effect with STRIPE_BILLING_REVOKE_ENABLED also exactly `true`; nothing in PostHog may turn this on',
  },
  {
    env: 'STRIPE_CLEAR_DELETED_SUBSCRIPTION_ENABLED',
    posthogKey: null,
    type: 'boolean' as const,
    note: 'env-only; exact `true`; customer.subscription.deleted that sets the plan to free clears families.stripe_subscription_id when it is that subscription; a different stored id is left as it is; nothing in PostHog may turn this on',
  },
  {
    env: 'BILLING_THREAD_NOTICES_ENABLED',
    posthogKey: null,
    type: 'boolean' as const,
    note: 'env-only; exact `true`, armed only with a strict BILLING_THREAD_NOTICES_SINCE instant; AI-written Linq text to the paying parent after a payment, cancel or refund; nothing in PostHog may turn this on',
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
  // The kill reads like isFlagKilled: trimmed, and `false` as well as the off variant.
  const trimmed = raw?.trim();
  if (spec.offVariant !== undefined && (trimmed === spec.offVariant || trimmed === 'false')) {
    return spec.offVariant;
  }
  if (raw !== undefined && spec.variants?.includes(raw)) return raw;
  return String(spec.default);
}

/** The variant a multivariate is OFF at: its kill variant, else its default. */
export function offVariantOf(spec: FlagSpec): string {
  return spec.offVariant ?? String(spec.default);
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
    return envVariant(spec, env) !== offVariantOf(spec);
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

export type FlagValueFault = 'wrong-case' | 'whitespace';

/** A catalog env value that looks like the expected word and is not that word. */
export interface InexactFlagValue {
  key: string;
  env: string;
  raw: string;
  /** The catalog word the value resembles once case and surrounding whitespace are ignored. */
  expected: string;
  faults: readonly FlagValueFault[];
}

/** Words a parser compares as text. Trimmed parsers still require the case. */
function exactWords(spec: FlagSpec): readonly string[] {
  switch (spec.parser) {
    case 'exact-true':
    case 'trimmed-true':
    case 'inverted-disabled':
      return ['true'];
    case 'exact-on':
    case 'trimmed-on':
      return ['on'];
    case 'not-exact-false':
    case 'trimmed-not-false':
      return ['false'];
    case 'trimmed-not-off':
      return ['off'];
    case 'multivariate': {
      const words = [...(spec.variants ?? [])];
      // `=false` is the kill switch on a multivariate that has an off variant.
      if (spec.offVariant !== undefined && !words.includes('false')) words.push('false');
      return words;
    }
    default: {
      const exhaustive: never = spec.parser;
      return exhaustive;
    }
  }
}

/**
 * Whether the parser treats `raw` as `word`. This mirrors {@link parseEnvBoolean}
 * and {@link envVariant}: exact parsers demand the bytes, trimmed parsers accept
 * surrounding whitespace, and a multivariate off variant (plus `false`) is read
 * trimmed. A fall-through to the default is not acceptance.
 */
function parserAcceptsWord(spec: FlagSpec, raw: string, word: string): boolean {
  const trimmed = raw.trim();
  switch (spec.parser) {
    case 'exact-true':
    case 'inverted-disabled':
      return word === 'true' && raw === 'true';
    case 'trimmed-true':
      return word === 'true' && trimmed === 'true';
    case 'exact-on':
      return word === 'on' && raw === 'on';
    case 'trimmed-on':
      return word === 'on' && trimmed === 'on';
    case 'not-exact-false':
      return word === 'false' && raw === 'false';
    case 'trimmed-not-false':
      return word === 'false' && trimmed === 'false';
    case 'trimmed-not-off':
      return word === 'off' && trimmed === 'off';
    case 'multivariate':
      if (raw === word) return true;
      if (spec.offVariant !== undefined && word === spec.offVariant && trimmed === word) {
        return true;
      }
      if (spec.offVariant !== undefined && word === 'false' && trimmed === 'false') return true;
      return false;
    default: {
      const exhaustive: never = spec.parser;
      return exhaustive;
    }
  }
}

/** The expected word, with the raw value's surrounding whitespace left in place. */
function withExpectedCase(raw: string, expected: string): string {
  const start = raw.length - raw.trimStart().length;
  const end = raw.trimEnd().length;
  return raw.slice(0, start) + expected + raw.slice(end);
}

/**
 * Reports a flag value that is the word the catalog expects, but in the wrong
 * case or with whitespace, including a trailing newline (`'True'`, `'true\n'`).
 * Whitespace is a fault only when the parser still rejects the value after the
 * letters are corrected, so a trimmed parser reports case alone for `' True\n'`.
 * Nothing here changes what a flag evaluates to.
 */
export function reportInexactFlagValue(
  spec: FlagSpec,
  raw: string | undefined,
): InexactFlagValue | null {
  if (raw === undefined) return null;
  const folded = raw.trim().toLowerCase();
  const expected = exactWords(spec).find((word) => word.toLowerCase() === folded);
  if (!expected || parserAcceptsWord(spec, raw, expected)) return null;
  const faults: FlagValueFault[] = [];
  if (!parserAcceptsWord(spec, withExpectedCase(raw, expected), expected)) {
    faults.push('whitespace');
  }
  if (raw.trim() !== expected) faults.push('wrong-case');
  if (faults.length === 0) return null;
  return { key: spec.key, env: spec.env, raw, expected, faults };
}
