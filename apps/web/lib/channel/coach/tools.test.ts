import type { GuardDeps } from '@hale/agent';
import { invokeTool } from '@hale/agent';
import { describe, expect, it } from 'vitest';
import type { ChannelDraftInput, ChannelDraftPort } from './draft';
import {
  MAX_DRAFTS_PER_TURN,
  type ChannelScheduleReader,
  type ScheduleEvent,
  buildChannelCoachTools,
} from './tools';

/**
 * The schedule verbs, driven against a fake reader and a fake draft port.
 *
 * What is asserted here is everything the SKILL cannot be trusted to enforce, because a
 * prompt is a request and these are guarantees:
 *
 *   · an eventId the reader never handed out is REFUSED, so "move the swim I invented"
 *     cannot become a draft — the model can write a uuid, it cannot conjure a row;
 *   · a third change in one turn is REFUSED, so a multi-intent text cannot fill the
 *     approvals queue faster than a parent can read it;
 *   · a move keeps the row's OWN title and place, so the model re-times an event
 *     without getting a second chance to rename it;
 *   · nothing here ever executes — every verb ends at a draft.
 */

const FAMILY = '11111111-1111-4111-8111-111111111111';
const PARENT = '22222222-2222-4222-8222-222222222222';
const MON_SWIM = '33333333-3333-4333-8333-333333333333';
const THU_SWIM = '44444444-4444-4444-8444-444444444444';
const TEEN_KID = '55555555-5555-4555-8555-555555555555';
const NOW = new Date('2026-07-30T12:00:00.000Z');
const TZ = 'America/Toronto';

function scheduleEvent(overrides: Partial<ScheduleEvent> = {}): ScheduleEvent {
  return {
    eventId: MON_SWIM,
    title: 'Swim lesson',
    startsAt: new Date('2026-08-03T20:30:00.000Z'),
    endsAt: null,
    location: 'West pool',
    childId: null,
    teen: false,
    sensitive: false,
    ...overrides,
  };
}

function fakeReader(events: ScheduleEvent[]): ChannelScheduleReader {
  return {
    async timeZone() {
      return TZ;
    },
    async weekPlanSummary() {
      return 'A quiet week with two swims.';
    },
    async eventsInWeek() {
      return events;
    },
    async resolveEvent(_familyId, eventId) {
      return events.find((e) => e.eventId === eventId) ?? null;
    },
  };
}

function fakePort(): ChannelDraftPort & { drafts: ChannelDraftInput[] } {
  const port = {
    drafts: [] as ChannelDraftInput[],
    async draft(input: ChannelDraftInput) {
      port.drafts.push(input);
      return { actionId: `action-${port.drafts.length}` };
    },
  };
  return port;
}

/** Guard deps shaped like the real web ones: every call audits (rule #6), and a
 * teen child's content is refused (rule #1). */
function guardDeps(audit: unknown[], teenChildIds: ReadonlySet<string>): GuardDeps {
  return {
    async writeAudit(entry) {
      audit.push(entry);
    },
    async checkChildContentAccess(_familyId, _toolName, input) {
      const childId = (input as { childId?: unknown } | null)?.childId;
      return typeof childId === 'string' && teenChildIds.has(childId)
        ? { ok: false, reason: 'teen content is redacted (rule #1)' }
        : { ok: true, reason: 'ok' };
    },
  };
}

interface Harness {
  tools: ReturnType<typeof buildChannelCoachTools>;
  port: ChannelDraftPort & { drafts: ChannelDraftInput[] };
  audit: unknown[];
  /** Every actionId the turn committed, in order — what a failed turn reports. */
  minted: string[];
  call(name: string, input: unknown): Promise<unknown>;
}

function harness(
  events: ScheduleEvent[] = [scheduleEvent()],
  teenChildIds: ReadonlySet<string> = new Set(),
): Harness {
  const port = fakePort();
  const audit: unknown[] = [];
  const minted: string[] = [];
  const deps = guardDeps(audit, teenChildIds);
  const tools = buildChannelCoachTools({
    familyId: FAMILY,
    reader: fakeReader(events),
    draftPort: port,
    villageTool: null,
    onDraft: (actionId) => minted.push(actionId),
    now: NOW,
  });
  return {
    tools,
    port,
    audit,
    minted,
    call(name, input) {
      const tool = tools.find((t) => t.name === name);
      if (!tool) throw new Error(`no tool named ${name}`);
      return invokeTool(tool, input, { familyId: FAMILY, actor: PARENT }, deps);
    },
  };
}

describe('lookup_week', () => {
  it('returns the week summary plus every resolvable event, family-local', async () => {
    const h = harness([
      scheduleEvent(),
      scheduleEvent({ eventId: THU_SWIM, startsAt: new Date('2026-08-06T21:15:00.000Z') }),
    ]);

    const result = (await h.call('lookup_week', {})) as {
      summary: string | null;
      events: Array<{ eventId: string; what: string; when: string }>;
    };

    expect(result.summary).toBe('A quiet week with two swims.');
    expect(result.events.map((e) => e.eventId)).toEqual([MON_SWIM, THU_SWIM]);
    // Family-local wall clock, not UTC: 20:30Z in Toronto (EDT) is 4:30pm Monday.
    expect(result.events[0]?.when).toBe('Mon 4:30pm');
    expect(result.events[1]?.when).toBe('Thu 5:15pm');
  });

  it("genericizes a teen's event title and drops its place (rule #1)", async () => {
    const h = harness([scheduleEvent({ childId: TEEN_KID, teen: true, title: 'Therapy' })]);

    const result = (await h.call('lookup_week', {})) as {
      events: Array<{ what: string; where: string | null }>;
    };

    expect(result.events[0]?.what).not.toContain('Therapy');
    expect(result.events[0]?.where).toBeNull();
  });

  it('writes an audit row for the read (rule #6)', async () => {
    const h = harness();
    await h.call('lookup_week', {});

    expect(h.audit).toHaveLength(1);
  });
});

describe('propose_calendar_move', () => {
  it('drafts a move that keeps the row title and place, re-timed to family-local', async () => {
    const h = harness();

    const result = (await h.call('propose_calendar_move', {
      eventId: MON_SWIM,
      date: '2026-08-04',
      time: '16:30',
    })) as { drafted: boolean; actionId: string };

    expect(result.drafted).toBe(true);
    expect(h.port.drafts).toHaveLength(1);
    const draft = h.port.drafts[0];
    expect(draft?.actionType).toBe('calendar_move');
    expect(draft?.payload.title).toBe('Swim lesson');
    expect(draft?.payload.location).toBe('West pool');
    expect(draft?.payload.reversalHandle).toBe(MON_SWIM);
    // 4:30pm Toronto on 2026-08-04 (EDT, UTC-4) is 20:30Z.
    expect(draft?.payload.startsAt).toBe('2026-08-04T20:30:00.000Z');
  });

  it('refuses an eventId the reader never handed out — no draft, no invention', async () => {
    const h = harness();

    await expect(
      h.call('propose_calendar_move', {
        eventId: '99999999-9999-4999-8999-999999999999',
        date: '2026-08-04',
        time: '16:30',
      }),
    ).rejects.toThrow(/not on this family's calendar/i);
    expect(h.port.drafts).toEqual([]);
  });

  it('flags the synthetic event as teen content when the target is a teen’s', async () => {
    const h = harness([scheduleEvent({ childId: TEEN_KID, teen: true })]);

    await h.call('propose_calendar_move', { eventId: MON_SWIM, date: '2026-08-04', time: '16:30' });

    expect(h.port.drafts[0]?.teenContent).toBe(true);
    expect(h.port.drafts[0]?.payload.childId).toBe(TEEN_KID);
  });
});

describe('propose_calendar_cancel', () => {
  it('drafts a cancel against the resolved row', async () => {
    const h = harness();

    await h.call('propose_calendar_cancel', { eventId: MON_SWIM });

    expect(h.port.drafts[0]?.actionType).toBe('calendar_cancel');
    expect(h.port.drafts[0]?.payload.reversalHandle).toBe(MON_SWIM);
  });

  it('refuses an unknown eventId — the destructive verb never guesses', async () => {
    const h = harness();

    await expect(
      h.call('propose_calendar_cancel', { eventId: '99999999-9999-4999-8999-999999999999' }),
    ).rejects.toThrow(/not on this family's calendar/i);
    expect(h.port.drafts).toEqual([]);
  });
});

describe('propose_calendar_add', () => {
  it('drafts an add from a family-local date and time', async () => {
    const h = harness();

    await h.call('propose_calendar_add', {
      title: 'Library storytime',
      date: '2026-08-05',
      time: '10:00',
      location: 'Beaches branch',
    });

    const draft = h.port.drafts[0];
    expect(draft?.actionType).toBe('calendar_add');
    expect(draft?.payload.title).toBe('Library storytime');
    expect(draft?.payload.startsAt).toBe('2026-08-05T14:00:00.000Z');
    expect(draft?.payload.reversalHandle).toBeUndefined();
  });

  it("is refused by the child-content guard for a teen's child id (rule #1)", async () => {
    const h = harness([scheduleEvent()], new Set([TEEN_KID]));

    await expect(
      h.call('propose_calendar_add', {
        title: 'Orthodontist',
        date: '2026-08-05',
        time: '10:00',
        childId: TEEN_KID,
      }),
    ).rejects.toThrow(/guardrail/i);
    expect(h.port.drafts).toEqual([]);
  });
});

describe('the per-turn draft cap', () => {
  it(`refuses the change after ${MAX_DRAFTS_PER_TURN} and says where the rest lives`, async () => {
    const h = harness([
      scheduleEvent(),
      scheduleEvent({ eventId: THU_SWIM }),
    ]);

    await h.call('propose_calendar_cancel', { eventId: MON_SWIM });
    await h.call('propose_calendar_cancel', { eventId: THU_SWIM });

    await expect(
      h.call('propose_calendar_add', { title: 'Third thing', date: '2026-08-05', time: '10:00' }),
    ).rejects.toThrow(/at most two changes/i);
    expect(h.port.drafts).toHaveLength(MAX_DRAFTS_PER_TURN);
  });

  it('is per turn — a fresh tool set starts from zero', async () => {
    const first = harness();
    await first.call('propose_calendar_cancel', { eventId: MON_SWIM });
    await first.call('propose_calendar_cancel', { eventId: MON_SWIM });

    const second = harness();
    await expect(
      second.call('propose_calendar_cancel', { eventId: MON_SWIM }),
    ).resolves.toBeDefined();
  });

  /**
   * VIL-260 · WS4 — the drafts are committed rows the moment a verb returns, so the turn
   * that made them has to be able to say so when it later breaks. A refusal mints
   * nothing and must report nothing, or a failed turn would claim changes that do not
   * exist.
   */
  it('reports every actionId it committed, and only those', async () => {
    const h = harness([scheduleEvent(), scheduleEvent({ eventId: THU_SWIM })]);

    await h.call('propose_calendar_cancel', { eventId: MON_SWIM });
    await expect(
      h.call('propose_calendar_move', {
        eventId: '99999999-9999-4999-8999-999999999999',
        date: '2026-08-04',
        time: '16:30',
      }),
    ).rejects.toThrow();
    await h.call('propose_calendar_add', { title: 'Story time', date: '2026-08-05', time: '10:00' });

    expect(h.minted).toEqual(['action-1', 'action-2']);
    expect(h.minted).toEqual(h.port.drafts.map((_, i) => `action-${i + 1}`));
  });

  it('a refused draft does not consume the budget', async () => {
    const h = harness();

    await expect(
      h.call('propose_calendar_cancel', { eventId: '99999999-9999-4999-8999-999999999999' }),
    ).rejects.toThrow();
    await h.call('propose_calendar_cancel', { eventId: MON_SWIM });
    await h.call('propose_calendar_cancel', { eventId: MON_SWIM });

    expect(h.port.drafts).toHaveLength(MAX_DRAFTS_PER_TURN);
  });
});
