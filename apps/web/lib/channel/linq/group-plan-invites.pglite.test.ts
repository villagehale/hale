import { schema } from '@hale/db';
import type { CalendarInviteReport, CalendarInviteRequest } from '@hale/worker/executor';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import {
  type GroupPlan,
  type GroupPlanAttendance,
  type GroupPlanFamily,
  type GroupPlanInviteDeps,
  type GroupPlanMessage,
  attendanceFromAnswer,
  attendanceUserMessage,
  createFamilyEventsCopyStore,
  driveGroupPlan,
  existingCopyFamilies,
  groupPlanCopyKey,
} from './group-plan-invites';

// Fixtures stand in for the VIL-399 group -> families mapping until it lands. The
// attendance reader is a fixed reading here: what the model reads is the eval's job
// (run-group-plan-attendance-eval.mjs). These tests cover only what code owns.

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});
afterEach(async () => {
  await db.exec('truncate table families, users cascade');
});

async function seedFamilies(n: number): Promise<GroupPlanFamily[]> {
  const out: GroupPlanFamily[] = [];
  for (let i = 0; i < n; i += 1) {
    const [f] = await db.database
      .insert(schema.families)
      .values({ displayName: `Fam${i}`, provinceOrState: 'ON' })
      .returning({ id: schema.families.id });
    out.push({ familyId: f?.id as string, label: `Fam${i}`, memberFirstNames: [`P${i}`] });
  }
  return out;
}

const PLAN: GroupPlan = {
  groupPlanId: 'plan-1',
  chatId: 'chat-g',
  title: 'Park playdate',
  startsAt: new Date('2026-11-07T15:00:00Z'),
  endsAt: new Date('2026-11-07T17:00:00Z'),
  location: 'Riverdale Park',
  cancelled: false,
};

function harness(
  families: GroupPlanFamily[],
  reading: Map<string, GroupPlanAttendance> | null,
  sendImpl?: (r: CalendarInviteRequest) => Promise<CalendarInviteReport>,
) {
  const invites: CalendarInviteRequest[] = [];
  const notes: { familyId: string; text: string }[] = [];
  const noteAsks: string[] = [];
  let noteText: string | null = 'note';
  const deps: GroupPlanInviteDeps = {
    directory: { familiesInGroup: async () => families },
    reader: { read: async () => reading },
    copies: createFamilyEventsCopyStore(db.database),
    invites: {
      send: async (r) => {
        invites.push(r);
        if (sendImpl) return sendImpl(r);
        return {
          status: 'reported',
          parents: [{ parentUserId: 'u', channel: 'sms', outcome: 'sent' }],
        };
      },
    },
    noteWriter: {
      write: async (input) => {
        noteAsks.push(input.failure);
        return noteText;
      },
    },
    privateNotes: {
      send: async (n) => {
        notes.push(n);
        return 'sent';
      },
    },
  };
  return {
    deps,
    invites,
    notes,
    noteAsks,
    setNoteText: (t: string | null) => {
      noteText = t;
    },
  };
}

/** One message from each family: every family has spoken for itself. */
const said = (fs: GroupPlanFamily[]): GroupPlanMessage[] =>
  fs.map((f) => ({ familyId: f.familyId, senderName: f.memberFirstNames[0] ?? null, text: '…' }));
const ids = (fs: GroupPlanFamily[]) => fs.map((f) => f.familyId);
const liveCopies = async (familyId: string) =>
  db.database.select().from(schema.familyEvents).where(eq(schema.familyEvents.familyId, familyId));

describe('VIL-455 group plan fan-out', () => {
  it('places one copy and one invite per in family only', async () => {
    const fams = await seedFamilies(3);
    const [a, b, c] = ids(fams) as [string, string, string];
    const h = harness(
      fams,
      new Map([
        [a, 'in'],
        [b, 'out'],
        [c, 'in'],
      ]),
    );
    const report = await driveGroupPlan(h.deps, PLAN, said(fams), new Set());
    expect(report.status).toBe('done');
    expect(h.invites.map((i) => [i.familyId, i.method]).sort()).toEqual(
      [
        [a, 'REQUEST'],
        [c, 'REQUEST'],
      ].sort(),
    );
    expect(await liveCopies(b)).toHaveLength(0);
    const [copy] = await liveCopies(a);
    expect(copy?.groupPlanCopyKey).toBe(groupPlanCopyKey(PLAN.groupPlanId, a));
    // Never the action claim key: readers join placed_by_action_id to actions.
    expect(copy?.placedByActionId).toBeNull();
    expect(copy?.source).toBe('placement');
  });

  it('a re-drive with nothing changed places nothing new and texts nobody', async () => {
    const fams = await seedFamilies(2);
    const reading = new Map(ids(fams).map((id) => [id, 'in' as const]));
    const h = harness(fams, reading);
    await driveGroupPlan(h.deps, PLAN, said(fams), new Set());
    const existing = await existingCopyFamilies(db.database, PLAN, ids(fams));
    await driveGroupPlan(h.deps, PLAN, said(fams), existing);
    expect(h.invites).toHaveLength(2);
    for (const id of ids(fams)) expect(await liveCopies(id)).toHaveLength(1);
  });

  it('dedupe is scoped to the group plan: a second plan gets its own copy', async () => {
    const fams = await seedFamilies(1);
    const reading = new Map([[fams[0]?.familyId as string, 'in' as const]]);
    const h = harness(fams, reading);
    await driveGroupPlan(h.deps, PLAN, said(fams), new Set());
    await driveGroupPlan(h.deps, { ...PLAN, groupPlanId: 'plan-2' }, said(fams), new Set());
    expect(await liveCopies(fams[0]?.familyId as string)).toHaveLength(2);
    expect(h.invites).toHaveLength(2);
  });

  it('an edit re-drives every copy with a fresh REQUEST', async () => {
    const fams = await seedFamilies(2);
    const reading = new Map(ids(fams).map((id) => [id, 'in' as const]));
    const h = harness(fams, reading);
    await driveGroupPlan(h.deps, PLAN, said(fams), new Set());
    const moved = { ...PLAN, startsAt: new Date('2026-11-08T15:00:00Z'), endsAt: null };
    const existing = await existingCopyFamilies(db.database, PLAN, ids(fams));
    await driveGroupPlan(h.deps, moved, said(fams), existing);
    expect(h.invites).toHaveLength(4);
    for (const id of ids(fams)) {
      const [row] = await liveCopies(id);
      expect(row?.startsAt.toISOString()).toBe('2026-11-08T15:00:00.000Z');
    }
  });

  it('a cancel soft-deletes every copy and sends CANCEL, without reading attendance', async () => {
    const fams = await seedFamilies(2);
    const reading = new Map(ids(fams).map((id) => [id, 'in' as const]));
    const h = harness(fams, reading);
    await driveGroupPlan(h.deps, PLAN, said(fams), new Set());
    const existing = await existingCopyFamilies(db.database, PLAN, ids(fams));
    h.deps.reader = {
      read: async () => {
        throw new Error('a cancel must not read attendance');
      },
    };
    await driveGroupPlan(h.deps, { ...PLAN, cancelled: true }, said(fams), existing);
    expect(h.invites.filter((i) => i.method === 'CANCEL')).toHaveLength(2);
    for (const id of ids(fams)) expect((await liveCopies(id))[0]?.deletedAt).not.toBeNull();
  });

  it('a family that backs out loses its copy; the others keep theirs', async () => {
    const fams = await seedFamilies(2);
    const [a, b] = ids(fams) as [string, string];
    const h = harness(
      fams,
      new Map([
        [a, 'in'],
        [b, 'in'],
      ]),
    );
    await driveGroupPlan(h.deps, PLAN, said(fams), new Set());
    h.deps.reader = {
      read: async () =>
        new Map([
          [a, 'in'],
          [b, 'out'],
        ]),
    };
    await driveGroupPlan(
      h.deps,
      PLAN,
      said(fams),
      await existingCopyFamilies(db.database, PLAN, [a, b]),
    );
    expect(h.invites.filter((i) => i.method === 'CANCEL').map((i) => i.familyId)).toEqual([b]);
    expect((await liveCopies(a))[0]?.deletedAt).toBeNull();
  });

  it('a failed read places nothing and sends nothing', async () => {
    const fams = await seedFamilies(2);
    const h = harness(fams, null);
    expect(await driveGroupPlan(h.deps, PLAN, said(fams), new Set())).toEqual({ status: 'unread' });
    expect(h.invites).toHaveLength(0);
    expect(h.notes).toHaveLength(0);
    for (const id of ids(fams)) expect(await liveCopies(id)).toHaveLength(0);
  });

  it('an invite failure sends a private note to that family only', async () => {
    const fams = await seedFamilies(2);
    const [a, b] = ids(fams) as [string, string];
    const h = harness(
      fams,
      new Map([
        [a, 'in'],
        [b, 'in'],
      ]),
      async (r) =>
        r.familyId === b
          ? {
              status: 'reported',
              parents: [{ parentUserId: 'u', channel: 'sms', outcome: 'send_failed' }],
            }
          : {
              status: 'reported',
              parents: [{ parentUserId: 'u', channel: 'sms', outcome: 'sent' }],
            },
    );
    const report = await driveGroupPlan(h.deps, PLAN, said(fams), new Set());
    expect(h.notes.map((n) => n.familyId)).toEqual([b]);
    expect(h.noteAsks).toEqual(['invite_failed']);
    if (report.status !== 'done') throw new Error('expected done');
    expect(report.families.find((f) => f.familyId === b)?.outcome).toBe('invite_failed');
  });

  it('a thrown sender counts as a failure; a suppressed leg does not', async () => {
    const fams = await seedFamilies(2);
    const [a, b] = ids(fams) as [string, string];
    const h = harness(
      fams,
      new Map([
        [a, 'in'],
        [b, 'in'],
      ]),
      async (r) => {
        if (r.familyId === a) throw new Error('boom');
        return {
          status: 'reported',
          parents: [{ parentUserId: 'u', channel: 'sms', outcome: 'suppressed' }],
        };
      },
    );
    await driveGroupPlan(h.deps, PLAN, said(fams), new Set());
    expect(h.notes.map((n) => n.familyId)).toEqual([a]);
  });

  it('suppressed, no_channel and not_configured legs get no note; send_failed does', async () => {
    const fams = await seedFamilies(4);
    const [a, b, c, d] = ids(fams) as [string, string, string, string];
    const outcomeFor = new Map([
      [a, 'suppressed'],
      [b, 'no_channel'],
      [c, 'not_configured'],
      [d, 'send_failed'],
    ] as const);
    const h = harness(fams, new Map(ids(fams).map((id) => [id, 'in'] as const)), async (r) => ({
      status: 'reported',
      parents: [
        { parentUserId: 'u', channel: 'sms', outcome: outcomeFor.get(r.familyId) ?? 'sent' },
      ],
    }));
    const report = await driveGroupPlan(h.deps, PLAN, said(fams), new Set());
    expect(h.notes.map((n) => n.familyId)).toEqual([d]);
    expect(h.noteAsks).toEqual(['invite_failed']);
    if (report.status !== 'done') throw new Error('expected done');
    for (const id of [a, b, c]) {
      const r = report.families.find((f) => f.familyId === id);
      expect(r?.outcome).toBe('invited');
      expect(r?.note).toBeUndefined();
    }
  });

  it('one family cannot put another in: a family that never spoke stays unclear', async () => {
    const fams = await seedFamilies(3);
    const [a, b, c] = ids(fams) as [string, string, string];
    // Fake reader that wrongly takes b's word for c ("the Tremblays are coming too").
    const h = harness(
      fams,
      new Map([
        [a, 'in'],
        [b, 'in'],
        [c, 'in'],
      ]),
    );
    const messages: GroupPlanMessage[] = [
      { familyId: a, senderName: 'P0', text: 'Saturday at the park, 10am' },
      { familyId: b, senderName: 'P1', text: 'we are in, and the Fam2s are coming too' },
    ];
    const report = await driveGroupPlan(h.deps, PLAN, messages, new Set());
    if (report.status !== 'done') throw new Error('expected done');
    expect(report.families.find((f) => f.familyId === c)).toMatchObject({
      attendance: 'unclear',
      outcome: 'not_in',
    });
    expect(h.invites.map((i) => i.familyId).sort()).toEqual([a, b].sort());
    expect(await liveCopies(c)).toHaveLength(0);
    // Same for out: another family can't take c out either; c's own word can.
    const h2 = harness(
      fams,
      new Map([
        [a, 'in'],
        [b, 'in'],
        [c, 'in'],
      ]),
    );
    const own = [...messages, { familyId: c, senderName: 'P2', text: 'we will come' }];
    const r2 = await driveGroupPlan(h2.deps, { ...PLAN, groupPlanId: 'plan-own' }, own, new Set());
    if (r2.status !== 'done') throw new Error('expected done');
    expect(r2.families.find((f) => f.familyId === c)?.attendance).toBe('in');
  });

  it('when the note draft fails, nothing is sent (no fixed fallback)', async () => {
    const fams = await seedFamilies(1);
    const a = fams[0]?.familyId as string;
    const h = harness(fams, new Map([[a, 'in']]), async () => ({
      status: 'errored',
      message: 'x',
    }));
    h.setNoteText(null);
    const report = await driveGroupPlan(h.deps, PLAN, said(fams), new Set());
    expect(h.notes).toHaveLength(0);
    if (report.status !== 'done') throw new Error('expected done');
    expect(report.families[0]?.note).toBe('draft_failed');
  });

  it('a placement failure notes that family and texts no invite', async () => {
    const fams = await seedFamilies(1);
    const a = fams[0]?.familyId as string;
    const h = harness(fams, new Map([[a, 'in']]));
    h.deps.copies = {
      upsertCopy: async () => {
        throw new Error('db down');
      },
      cancelCopy: async () => null,
    };
    await driveGroupPlan(h.deps, PLAN, said(fams), new Set());
    expect(h.invites).toHaveLength(0);
    expect(h.noteAsks).toEqual(['placement_failed']);
    expect(h.notes.map((n) => n.familyId)).toEqual([a]);
  });
});

describe('VIL-455 attendance request shape', () => {
  const fams: GroupPlanFamily[] = [
    { familyId: 'uuid-a', label: 'Lee', memberFirstNames: ['Ana'] },
    { familyId: 'uuid-b', label: 'Dong', memberFirstNames: ['Barton'] },
  ];

  it('never shows the model a family id', () => {
    const msg = attendanceUserMessage({
      plan: PLAN,
      families: fams,
      messages: [{ familyId: 'uuid-a', senderName: 'Ana', text: 'x' }],
    });
    expect(msg).not.toContain('uuid-');
  });

  it('rejects an answer that skips or invents a family key', () => {
    expect(attendanceFromAnswer(fams, { families: [{ key: 'f1', attendance: 'in' }] })).toBeNull();
    expect(
      attendanceFromAnswer(fams, {
        families: [
          { key: 'f1', attendance: 'in' },
          { key: 'f9', attendance: 'in' },
        ],
      }),
    ).toBeNull();
    expect(
      attendanceFromAnswer(fams, {
        families: [
          { key: 'f1', attendance: 'in' },
          { key: 'f2', attendance: 'out' },
        ],
      })?.get('uuid-b'),
    ).toBe('out');
  });
});
