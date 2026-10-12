import { type Database, schema } from '@hale/db';

/**
 * The smoke family's History rows for what Hale does on its own (VIL-131), written
 * with the verbs and `after` shapes the worker writes them with:
 *
 *   - one email Hale sent on its own (`action.executed`, decision.source 'autonomous');
 *   - the parent switching email off (`autonomous_action_class.revoked`);
 *   - a registration form, a kind that is never autonomous, brought as a draft
 *     (`action.gated.autonomy_denied_kind`), which the parent later dismissed.
 *
 * Every step sits on its own calendar day, more than 24 hours from the next, so the
 * trail shows each as its own row rather than folding an action's steps into one
 * disclosure. Nothing is left waiting for approval. PII-free: example.test only.
 */

const HOUR_MS = 60 * 60 * 1000;

function one<T>(rows: T[], what: string): T {
  const row = rows[0];
  if (!row) throw new Error(`smoke-autonomy-trail: insert returned no row for ${what}`);
  return row;
}

export async function seedSmokeAutonomyTrail(
  db: Database,
  fam: { familyId: string; parentUserId: string },
  now: Date = new Date(),
): Promise<void> {
  const hoursAgo = (hours: number) => new Date(now.getTime() - hours * HOUR_MS);
  const formBroughtAt = hoursAgo(125);
  const formDismissedAt = hoursAgo(100);
  const emailSentAt = hoursAgo(75);
  const switchedOffAt = hoursAgo(50);

  const mintAction = async (
    dedupHash: string,
    status: 'actioned' | 'reviewed',
    action: Omit<typeof schema.actions.$inferInsert, 'eventId' | 'familyId'>,
  ) => {
    const event = one(
      await db
        .insert(schema.events)
        .values({
          familyId: fam.familyId,
          source: 'smoke',
          eventType: 'signal.smoke',
          dedupHash,
          status,
          contentProvenance: 'hale_authored',
        })
        .returning({ id: schema.events.id }),
      `${dedupHash} event`,
    );
    return one(
      await db
        .insert(schema.actions)
        .values({ ...action, eventId: event.id, familyId: fam.familyId })
        .returning({ id: schema.actions.id }),
      `${dedupHash} action`,
    );
  };

  const form = await mintAction('smoke-registration-form', 'reviewed', {
    actionType: 'fill_pdf_form',
    payload: { form: 'Swim lessons registration' },
    draftedAt: formBroughtAt,
    reviewerVerdict: 'approved',
    reviewerVerdictAt: formBroughtAt,
    userVisibleState: 'reverted',
    revertedAt: formDismissedAt,
    revertedReason: 'declined_by_human',
  });
  const emailDetail = { kind: 'email_sent', messageId: 'smoke-1', recipientDomain: 'example.test' };
  const email = await mintAction('smoke-autonomous-email', 'actioned', {
    actionType: 'send_email',
    payload: {
      to: 'office@example.test',
      subject: 'Pickup on Thursday',
      body: 'Juniper will be picked up at 3:30 on Thursday.',
    },
    draftedAt: emailSentAt,
    reviewerVerdict: 'approved',
    reviewerVerdictAt: emailSentAt,
    userVisibleState: 'autonomous',
    executedAt: emailSentAt,
    executorResult: emailDetail,
  });
  const switchOff = one(
    await db
      .insert(schema.consentRecords)
      .values({
        familyId: fam.familyId,
        userId: fam.parentUserId,
        consentType: 'autonomous_action_class',
        consentScope: 'send_email',
        granted: false,
        grantedAt: switchedOffAt,
        policyVersion: 'smoke',
      })
      .returning({ id: schema.consentRecords.id }),
    'switch-off consent record',
  );

  await db.insert(schema.auditLog).values([
    {
      familyId: fam.familyId,
      actor: 'system',
      actionTaken: 'action.gated.autonomy_denied_kind',
      targetTable: 'actions',
      targetId: form.id,
      after: { actionType: 'fill_pdf_form' },
      occurredAt: formBroughtAt,
    },
    {
      familyId: fam.familyId,
      actor: fam.parentUserId,
      actionTaken: 'action.declined_by_human',
      targetTable: 'actions',
      targetId: form.id,
      occurredAt: formDismissedAt,
    },
    {
      familyId: fam.familyId,
      actor: 'system',
      actionTaken: 'action.executed',
      targetTable: 'actions',
      targetId: email.id,
      after: {
        ...emailDetail,
        decision: { source: 'autonomous', reason: 'All reviewer checks passed.' },
      },
      occurredAt: emailSentAt,
    },
    {
      familyId: fam.familyId,
      actor: fam.parentUserId,
      actionTaken: 'autonomous_action_class.revoked',
      targetTable: 'consent_records',
      targetId: switchOff.id,
      after: { consentType: 'autonomous_action_class', consentScope: 'send_email' },
      occurredAt: switchedOffAt,
    },
  ]);
}
