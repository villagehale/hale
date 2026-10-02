const FAMILY_ID = '11111111-1111-4111-8111-111111111111';

const DISTRIBUTION = {
  calendar_add: { clean: 6, duplicate: 4, quiet_window: 4, conflict: 4 },
  calendar_move: { clean: 4, duplicate: 4, quiet_window: 4, conflict: 4 },
  calendar_cancel: { clean: 8, duplicate: 8 },
};

const REQUIRED_CHECKS = {
  calendar_add: ['check_action_time_window', 'check_action_idempotency', 'check_calendar_conflict'],
  calendar_move: [
    'check_action_time_window',
    'check_action_idempotency',
    'check_calendar_conflict',
  ],
  calendar_cancel: ['check_action_idempotency'],
};

function uuid(sequence) {
  return `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`;
}
function checkPolicy(actionType, outcome) {
  const policy = Object.fromEntries(REQUIRED_CHECKS[actionType].map((check) => [check, true]));
  if (outcome === 'duplicate') policy.check_action_idempotency = false;
  if (outcome === 'quiet_window') policy.check_action_time_window = false;
  if (outcome === 'conflict') policy.check_calendar_conflict = false;
  return policy;
}

function fixture(actionType, outcome, sequence) {
  const startsAt = new Date(Date.UTC(2026, 9, sequence + 1, 16, 30)).toISOString();
  const endsAt = new Date(Date.parse(startsAt) + 60 * 60 * 1000).toISOString();
  const payload = {
    title: `Synthetic calendar item ${sequence}`,
    startsAt,
    endsAt,
    location: sequence % 2 === 0 ? 'Synthetic Community Centre' : null,
    childId: sequence % 3 === 0 ? uuid(9000 + sequence) : null,
    privacySensitive: sequence % 7 === 0,
    ...(actionType === 'calendar_add' ? {} : { reversalHandle: uuid(8000 + sequence) }),
  };

  return {
    id: `sms-${actionType.replace('calendar_', '')}-${outcome}-${String(sequence).padStart(2, '0')}`,
    note: `Synthetic SMS calendar ${actionType} with ${outcome} reviewer checks.`,
    familyId: FAMILY_ID,
    draft: {
      id: uuid(sequence),
      actionType,
      recipientVisibility: 'internal_only',
      payload,
    },
    checkPolicy: checkPolicy(actionType, outcome),
    expect: outcome === 'clean' ? 'approve' : 'not-approve',
  };
}

export const SMS_CALENDAR_REVIEWER_FIXTURES = [];
let sequence = 1;
for (const [actionType, outcomes] of Object.entries(DISTRIBUTION)) {
  for (const [outcome, count] of Object.entries(outcomes)) {
    for (let index = 0; index < count; index += 1) {
      SMS_CALENDAR_REVIEWER_FIXTURES.push(fixture(actionType, outcome, sequence));
      sequence += 1;
    }
  }
}
