import { type Database, schema } from '@hale/db';
import { and, eq, inArray } from 'drizzle-orm';
import { fakeSender, previewRouteGate } from '~/lib/channel/preview-fake-inbound';
import { isSyntheticProbeNumber } from '~/lib/channels/phone';
import { resolveVerifiedChannelByPhone } from '~/lib/channels/sms-consent-core';
import { decryptString } from '~/lib/crypto/string-cipher';
import {
  type ReminderRunDeps,
  type ReminderRunResult,
  defaultReminderRunDeps,
  runReminderCron,
} from '~/lib/loop/reminders/run';

/**
 * VIL-466 · Preview-only trigger for the reminder cron, scoped to ONE fake family.
 *
 * Reminders are the texts Hale sends on its own, so a proof run has to fire them, not
 * just reply turns. Vercel Cron does not run on Preview; this route runs the same
 * `runReminderCron` the hourly cron runs, with its readers narrowed to one family, and
 * the sends leave through the same channel.send dispatch (and so the capture transport).
 *
 * Same four gates and the same bearer secret as the fake inbound door. The family is
 * named by a fictional +1 437-555 number, and EVERY SMS channel in that family must sit
 * in that range, so a reminder can never fan out to a real co-parent or caregiver.
 */

type Env = Readonly<Record<string, string | undefined>>;

export interface PreviewReminderTriggerDeps {
  database: Database;
  env?: Env;
  /** The cron's readers and ports; tests swap the enqueue for an in-process dispatch. */
  reminderDeps?: () => ReminderRunDeps;
  runCron?: typeof runReminderCron;
  /** After the run, e.g. kick the drain so the queued sends leave now. */
  afterRun?: () => Promise<void> | void;
  now?: () => Date;
}

function json(body: Record<string, unknown>, status = 200): Response {
  return Response.json(body, { status });
}

/** Every SMS channel of every member of this family is a fictional probe number. */
export async function familyIsAllSyntheticProbe(
  database: Database,
  familyId: string,
): Promise<boolean> {
  const members = await database
    .select({ userId: schema.familyMembers.userId })
    .from(schema.familyMembers)
    .where(eq(schema.familyMembers.familyId, familyId));
  const userIds = [...new Set(members.map((m) => m.userId))];
  if (userIds.length === 0) return false;
  const channels = await database
    .select({ phoneE164Encrypted: schema.parentChannels.phoneE164Encrypted })
    .from(schema.parentChannels)
    .where(
      and(inArray(schema.parentChannels.userId, userIds), eq(schema.parentChannels.kind, 'sms')),
    );
  const sameFamily = await database
    .select({ phoneE164Encrypted: schema.parentChannels.phoneE164Encrypted })
    .from(schema.parentChannels)
    .where(eq(schema.parentChannels.familyId, familyId));
  const all = [...channels, ...sameFamily];
  if (all.length === 0) return false;
  return all.every((c) => isSyntheticProbeNumber(decryptString(c.phoneE164Encrypted)));
}

/** The cron's audience and due rows, narrowed to one family. Everything else is the cron's. */
export function scopeReminderDepsToFamily(
  deps: ReminderRunDeps,
  familyId: string,
): ReminderRunDeps {
  return {
    ...deps,
    selectReminderParents: async (db) =>
      (await deps.selectReminderParents(db)).filter((p) => p.familyId === familyId),
    selectReminderCaregivers: async (db) =>
      (await deps.selectReminderCaregivers(db)).filter((s) => s.familyId === familyId),
    loadDueReminders: async (db, now) =>
      (await deps.loadDueReminders(db, now)).filter((r) => r.familyId === familyId),
    enqueue: async (job) => {
      if (job.familyId !== familyId) throw new Error('preview reminder: job outside the family');
      await deps.enqueue(job);
    },
  };
}

/** POST { phone: "+1437555XXXX" } — fire the due reminders of that fake family. */
export async function handlePreviewReminderTrigger(
  req: Request,
  deps: PreviewReminderTriggerDeps,
): Promise<Response> {
  const env = deps.env ?? process.env;
  const shut = previewRouteGate(req, env);
  if (shut) return shut;

  let payload: { phone?: unknown };
  try {
    payload = (await req.json()) as typeof payload;
  } catch {
    return json({ error: 'malformed' }, 400);
  }
  const phone = fakeSender(payload.phone);
  if (!phone) return json({ error: 'sender_not_fictional' }, 400);

  const channel = await resolveVerifiedChannelByPhone(deps.database, phone);
  if (!channel) return json({ error: 'no_family' }, 404);
  if (!(await familyIsAllSyntheticProbe(deps.database, channel.familyId))) {
    return json({ error: 'family_not_fictional' }, 400);
  }

  const base = (deps.reminderDeps ?? defaultReminderRunDeps)();
  const run = deps.runCron ?? runReminderCron;
  const summary: ReminderRunResult = await run(
    deps.database,
    scopeReminderDepsToFamily(base, channel.familyId),
    deps.now?.() ?? new Date(),
  );
  await deps.afterRun?.();
  return json({ ok: true, ...summary });
}
