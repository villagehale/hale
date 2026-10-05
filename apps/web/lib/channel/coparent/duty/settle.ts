import { type Database, schema } from '@hale/db';
import { eq, inArray } from 'drizzle-orm';
import { queueGroupActivityDecision } from '~/lib/channel/linq/family-outbound';
import { dutyAssigneeIds } from '~/lib/channel/linq/group-members';
import { loadRememberedLogistics } from '~/lib/channel/linq/logistics-poll';
import { acknowledgeDutyWrite } from './ack';
import { asksBurden, burdenMayLeave } from './burden';
import { coparentDutyMemoryEnabled } from './flag';
import type { DutyExtractor } from './interpret';
import { interpretDutyReply } from './interpret';
import { commitDutyUpdate, loadLiveDutyFacts } from './model';
import { readDutySyncDecision } from './sync-line';
import { applyDutyUndo } from './undo';
import type { DutyVoice } from './voice';

/**
 * VIL-383 write path. Flag off returns before any read. Sends, when they
 * happen at all, go to the chat the parent just used — never a 1:1 Hale
 * opened, and never during quiet hours. Burden counts are not spoken.
 */

export interface DutySettleResult {
  status: 'skipped' | 'recorded' | 'undone' | 'reassigned' | 'held';
  reason: string | null;
  sent: false | true;
  spoken: string | null;
}

export async function settleDutyMemory(
  database: Database,
  input: {
    familyId: string;
    actorUserId: string;
    text: string;
    now: Date;
    inboundChatId: string | null;
    inboundMessageId: string | null;
    surface: 'group' | 'reply';
    subjectKey?: string | null;
    timeZone?: string;
    language?: 'en' | 'fr';
    extract?: DutyExtractor;
    /** The duty voice for the restate line. Absent means the production composer. */
    voice?: DutyVoice;
    fetch?: typeof fetch;
  },
): Promise<DutySettleResult> {
  if (!coparentDutyMemoryEnabled()) {
    return { status: 'skipped', reason: 'flag_off', sent: false, spoken: null };
  }
  if (asksBurden(input.text)) {
    return {
      status: 'skipped',
      reason: burdenMayLeave() ? 'burden_surface_unlocked' : 'burden_internal',
      sent: false,
      spoken: null,
    };
  }

  const home = await household(database, input.familyId, input.actorUserId);
  if (home.parentCount < 2) {
    return { status: 'skipped', reason: 'single_parent', sent: false, spoken: null };
  }
  const timeZone = input.timeZone ?? home.timeZone;
  const language = input.language ?? home.language;

  const undo = await applyDutyUndo(database, {
    familyId: input.familyId,
    actorUserId: input.actorUserId,
    parentCount: home.parentCount,
    parents: home.parents,
    childNames: home.childNames,
    text: input.text,
    now: input.now,
    childId: null,
  });
  if (undo.status === 'undone' || undo.status === 'reassigned') {
    const ack = await acknowledgeDutyWrite({
      database,
      familyId: input.familyId,
      actorUserId: input.actorUserId,
      source: 'text',
      now: input.now,
      timeZone,
      inboundChatId: input.inboundChatId,
      inboundMessageId: input.inboundMessageId,
      language,
      name: null,
      kid: null,
      event: null,
      day: null,
      time: null,
      ...('voice' in input ? { voice: input.voice } : {}),
      fetch: input.fetch,
    });
    return {
      status: ack.status === 'held' ? 'held' : undo.status === 'undone' ? 'undone' : 'reassigned',
      reason: ack.status === 'held' ? 'quiet_hours' : undo.reason,
      sent: ack.sent,
      spoken: ack.status === 'restated' ? ack.text : null,
    };
  }

  const sync = input.surface === 'reply' ? readDutySyncDecision(input.text) : null;
  if (sync && input.inboundChatId) {
    await queueGroupActivityDecision(database, {
      familyId: input.familyId,
      parentUserId: input.actorUserId,
      originChatId: input.inboundChatId,
      decision: sync,
      now: input.now,
    });
    const subjectKey = `duty-sync/${encodeURIComponent(sync.kid)}/${encodeURIComponent(sync.activity)}/${encodeURIComponent(sync.day)}/${encodeURIComponent(sync.time)}`;
    await commitDutyUpdate(database, {
      mode: 'write',
      familyId: input.familyId,
      actorUserId: input.actorUserId,
      parentCount: home.parentCount,
      subjectKey,
      eventTitle: `${sync.kid} ${sync.activity}`,
      childNames: home.childNames,
      slot: {
        role: 'attend',
        claim: 'self',
        name: null,
        userId: input.actorUserId,
        confidence: 1,
      },
      prior: null,
      source: 'text',
      now: input.now,
      childId: null,
      question: false,
      askWhichKid: false,
    });
    const ack = await acknowledgeDutyWrite({
      database,
      familyId: input.familyId,
      actorUserId: input.actorUserId,
      source: 'text',
      now: input.now,
      timeZone,
      inboundChatId: input.inboundChatId,
      inboundMessageId: input.inboundMessageId,
      language,
      name: home.speakerName,
      kid: sync.kid,
      event: sync.activity,
      day: sync.day,
      time: sync.time,
      ...('voice' in input ? { voice: input.voice } : {}),
      fetch: input.fetch,
    });
    return {
      status: ack.status === 'held' ? 'held' : 'recorded',
      reason: ack.status === 'skipped' || ack.status === 'held' ? ack.reason : null,
      sent: ack.sent,
      spoken: null,
    };
  }

  const subjectKey = input.subjectKey ?? (await loneSubject(database, input.familyId));
  if (!subjectKey) return { status: 'skipped', reason: 'no_event', sent: false, spoken: null };
  const interpreted = await interpretDutyReply(
    {
      text: input.text,
      speakerUserId: input.actorUserId,
      parents: home.parents,
      childNames: home.childNames,
      eventTitle: null,
    },
    input.extract,
  );
  const slot = interpreted.slots[0];
  if (!interpreted.write || !slot) {
    return { status: 'skipped', reason: 'not_duty', sent: false, spoken: null };
  }
  const committed = await commitDutyUpdate(database, {
    mode: 'write',
    familyId: input.familyId,
    actorUserId: input.actorUserId,
    parentCount: home.parentCount,
    subjectKey,
    eventTitle: null,
    childNames: home.childNames,
    slot,
    prior: null,
    source: interpreted.method === 'llm' ? 'llm' : 'text',
    now: input.now,
    childId: null,
    question: interpreted.question,
    askWhichKid: interpreted.askWhichKid,
  });
  if (!committed.written) {
    return { status: 'skipped', reason: committed.reason, sent: false, spoken: null };
  }
  const ack = await acknowledgeDutyWrite({
    database,
    familyId: input.familyId,
    actorUserId: input.actorUserId,
    source: interpreted.method === 'llm' ? 'llm' : 'rules',
    now: input.now,
    timeZone,
    inboundChatId: input.inboundChatId,
    inboundMessageId: input.inboundMessageId,
    language,
    name: home.speakerName,
    kid: null,
    event: null,
    day: null,
    time: null,
    ...('voice' in input ? { voice: input.voice } : {}),
    fetch: input.fetch,
  });
  return {
    status: ack.status === 'held' ? 'held' : 'recorded',
    reason: ack.status === 'held' ? 'quiet_hours' : null,
    sent: ack.sent,
    spoken: ack.status === 'restated' ? ack.text : null,
  };
}

async function loneSubject(database: Database, familyId: string): Promise<string | null> {
  const remembered = await loadRememberedLogistics(database, familyId);
  const who = remembered.filter((row) => row.kind === 'who_takes');
  if (who.length === 1) return who[0]?.factKey ?? null;
  const duties = await loadLiveDutyFacts(database, familyId);
  const keys = duties.filter((row) => row.factKey.startsWith('duty/'));
  if (keys.length === 1) return keys[0]?.factKey ?? null;
  return null;
}

async function household(
  database: Database,
  familyId: string,
  actorUserId: string,
): Promise<{
  parents: Array<{ userId: string; name: string }>;
  childNames: string[];
  parentCount: number;
  timeZone: string;
  language: 'en' | 'fr';
  speakerName: string | null;
}> {
  const parentIds = await dutyAssigneeIds(database, familyId);
  const people =
    parentIds.length === 0
      ? []
      : await database
          .select({ id: schema.users.id, name: schema.users.name, timezone: schema.users.timezone })
          .from(schema.users)
          .where(inArray(schema.users.id, parentIds));
  const parents = parentIds.map((userId) => ({
    userId,
    name: people.find((row) => row.id === userId)?.name ?? '',
  }));
  const [family] = await database
    .select({ primaryLanguage: schema.families.primaryLanguage })
    .from(schema.families)
    .where(eq(schema.families.id, familyId))
    .limit(1);
  const children = await database
    .select({ name: schema.children.name, familyId: schema.children.familyId })
    .from(schema.children)
    .where(eq(schema.children.familyId, familyId));
  return {
    parents,
    childNames: children
      .filter((row) => row.familyId === familyId && row.name)
      .map((row) => row.name),
    parentCount: parentIds.length,
    timeZone: people[0]?.timezone ?? 'America/Toronto',
    language: family?.primaryLanguage?.toLowerCase().startsWith('fr') ? 'fr' : 'en',
    speakerName: people.find((row) => row.id === actorUserId)?.name ?? null,
  };
}
