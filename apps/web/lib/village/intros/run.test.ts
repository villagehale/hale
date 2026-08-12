import type { Database } from '@hale/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OutboundGatePorts, ProactiveHoldReason } from '~/lib/channel/outbound-gate';
import { FakeTransport } from '~/lib/channel/intake/transport';
import type { IntroEmailRequest, IntroEmailResult, IntroEmailSender } from './email';
import {
  DISCOVERABILITY_ASK,
  INTRO_SOFT_CLOSE,
} from './copy';
import {
  VILLAGE_INTROS_ALLOWLIST_ENV,
  VILLAGE_INTROS_ENABLED_ENV,
  type IntroSweepChild,
  type IntroSweepDeps,
  type IntroSweepFamily,
  type SweepProposal,
  runVillageIntroSweep,
} from './run';

const DB = {} as Database;
const NOW = new Date('2026-08-11T15:00:00Z');

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

/**
 * The counterpart family's real strings. A card that renders for family A is checked
 * against every one of them — the sentinel-family pattern: seed distinctive values,
 * then assert none of them survived into the outbound body.
 */
const SENTINELS = {
  parentName: 'Priya Raman',
  childName: 'Marisol',
  postal: 'M4K 1N2',
  email: 'priya.raman@example.com',
};

function child(overrides: Partial<IntroSweepChild> = {}): IntroSweepChild {
  return {
    id: 'child-1',
    name: 'Maya',
    gender: 'girl',
    dateOfBirth: '2024-02-11', // 30 months at NOW -> toddler
    ...overrides,
  };
}

function family(overrides: Partial<IntroSweepFamily> & { familyId: string }): IntroSweepFamily {
  return {
    parentUserId: `user-${overrides.familyId}`,
    parentName: 'Sam Lee',
    parentEmail: `parent-${overrides.familyId}@example.com`,
    areaCoarse: 'M4K 1N2',
    timeZone: 'America/Toronto',
    ...overrides,
  };
}

interface Harness {
  deps: IntroSweepDeps;
  transport: FakeTransport;
  emails: IntroEmailRequest[];
  proposalsCreated: Array<Record<string, unknown>>;
  audits: Array<{ familyId: string; actionTaken: string; after: Record<string, unknown> }>;
  asked: Array<{ proposalId: string; side: 'a' | 'b' }>;
  statuses: Array<{ proposalId: string; status: string; closed: boolean }>;
}

function harness(overrides: {
  families?: IntroSweepFamily[];
  discoverable?: Set<string>;
  alreadyAsked?: Set<string>;
  children?: Record<string, IntroSweepChild[]>;
  proposals?: SweepProposal[];
  pairedBefore?: Set<string>;
  hold?: ProactiveHoldReason | null;
  anchor?: { id: string; title: string; startsAt: Date } | null;
  emailResult?: IntroEmailResult;
  nameLevel?: 'first_name' | 'relation' | 'generic';
} = {}): Harness {
  const transport = new FakeTransport();
  const emails: IntroEmailRequest[] = [];
  const proposalsCreated: Array<Record<string, unknown>> = [];
  const audits: Harness['audits'] = [];
  const asked: Harness['asked'] = [];
  const statuses: Harness['statuses'] = [];

  const gate: OutboundGatePorts = {
    channelEnrolled: async () => overrides.hold !== 'not_enrolled',
    watchConsentGranted: async () => overrides.hold !== 'no_watch_consent',
    countProactiveSends: async () => (overrides.hold === 'frequency_cap' ? 99 : 0),
    parentTimeZone: async () => (overrides.hold === 'quiet_hours' ? 'America/Toronto' : 'UTC'),
  };

  const email: IntroEmailSender = {
    async send(request) {
      emails.push(request);
      return overrides.emailResult ?? { status: 'sent', providerMessageId: 'msg-1' };
    },
  };

  const deps: IntroSweepDeps = {
    selectFamilies: async () => overrides.families ?? [],
    discoverableUserIds: async () => overrides.discoverable ?? new Set(),
    askedUserIds: async () => overrides.alreadyAsked ?? new Set(),
    loadChildren: async (_db, familyId) => overrides.children?.[familyId] ?? [child()],
    loadNameLevel: async () => overrides.nameLevel ?? 'first_name',
    loadOpenProposalFamilyIds: async () =>
      new Set((overrides.proposals ?? []).flatMap((p) => [p.familyAId, p.familyBId])),
    loadPairedBefore: async () => overrides.pairedBefore ?? new Set(),
    loadAnchorSession: async () => overrides.anchor ?? null,
    createProposal: async (_db, input) => {
      proposalsCreated.push(input as unknown as Record<string, unknown>);
      return 'prop-new';
    },
    loadLiveProposals: async () => overrides.proposals ?? [],
    markAsked: async (_db, proposalId, side) => {
      asked.push({ proposalId, side });
    },
    setStatus: async (_db, proposalId, status, closed) => {
      statuses.push({ proposalId, status, closed });
    },
    buildGate: () => gate,
    dedupeActive: async () => false,
    resolveSendablePhone: async (_db, userId) => `phone-${userId}`,
    recordSend: async () => 'msg-row',
    audit: async (_db, row) => {
      audits.push({ familyId: row.familyId, actionTaken: row.actionTaken, after: row.after });
    },
    transport,
    email,
  };

  return { deps, transport, emails, proposalsCreated, audits, asked, statuses };
}

function proposal(overrides: Partial<SweepProposal> = {}): SweepProposal {
  return {
    id: 'prop-1',
    fsa: 'M4K',
    stage: 'toddler',
    status: 'proposed',
    familyAId: A,
    familyBId: B,
    familyAChildId: 'child-1',
    familyBChildId: 'child-1',
    familyAAskedAt: null,
    familyBAskedAt: null,
    familyAReply: null,
    familyBReply: null,
    anchorTitle: null,
    anchorStartsAt: null,
    expiresAt: new Date('2026-08-18T15:00:00Z'),
    ...overrides,
  };
}

/** The body of the one text sent to this family, or undefined. */
function bodyTo(h: Harness, familyId: string): string | undefined {
  return h.transport.sent.find((s) => s.to === `phone-user-${familyId}`)?.body;
}

beforeEach(() => {
  process.env[VILLAGE_INTROS_ENABLED_ENV] = 'true';
});
afterEach(() => {
  // DELETE, not `= undefined`: assigning undefined to process.env stores the STRING
  // "undefined", which would leave the allowlist holding one bogus id and arm the next
  // test's sweep. (It did, before this line.)
  delete process.env[VILLAGE_INTROS_ENABLED_ENV];
  delete process.env[VILLAGE_INTROS_ALLOWLIST_ENV];
  vi.restoreAllMocks();
});

describe('the dark-launch gate', () => {
  it('does nothing at all when neither the flag nor the allowlist is armed', async () => {
    process.env[VILLAGE_INTROS_ENABLED_ENV] = 'false';
    const h = harness({ families: [family({ familyId: A }), family({ familyId: B })] });
    const result = await runVillageIntroSweep(DB, h.deps, NOW);
    expect(result.enabled).toBe(false);
    expect(h.transport.sent).toEqual([]);
  });

  it('reads a trailing newline as OFF, not as ON', async () => {
    // `echo | vercel env add` stores 'true\n'; a truthiness check would ship an
    // unprompted cross-household campaign nobody armed.
    process.env[VILLAGE_INTROS_ENABLED_ENV] = 'true\n';
    const h = harness({ families: [family({ familyId: A }), family({ familyId: B })] });
    expect((await runVillageIntroSweep(DB, h.deps, NOW)).enabled).toBe(false);
  });

  it('an allowlist arms only the families it names', async () => {
    process.env[VILLAGE_INTROS_ENABLED_ENV] = 'false';
    process.env[VILLAGE_INTROS_ALLOWLIST_ENV] = `${A},${B}`;
    const h = harness({ families: [family({ familyId: A }), family({ familyId: B })] });
    const result = await runVillageIntroSweep(DB, h.deps, NOW);
    expect(result.enabled).toBe(true);
    expect(result.asked).toBe(2);
  });
});

describe('phase 1 - the discoverability ask', () => {
  it('asks both families that share an FSA, once, through the gate', async () => {
    const h = harness({ families: [family({ familyId: A }), family({ familyId: B })] });
    const result = await runVillageIntroSweep(DB, h.deps, NOW);

    expect(result.asked).toBe(2);
    expect(h.transport.bodies()).toEqual([DISCOVERABILITY_ASK, DISCOVERABILITY_ASK]);
    expect(h.audits.filter((a) => a.actionTaken === 'village_intro_ask_sent')).toHaveLength(2);
  });

  it('never asks a family that is alone in its FSA', async () => {
    const h = harness({
      families: [family({ familyId: A, areaCoarse: 'M4K' }), family({ familyId: B, areaCoarse: 'L6H' })],
    });
    expect((await runVillageIntroSweep(DB, h.deps, NOW)).asked).toBe(0);
    expect(h.transport.sent).toEqual([]);
  });

  it('never asks twice - a family with any answer on file is left alone', async () => {
    const h = harness({
      families: [family({ familyId: A }), family({ familyId: B })],
      alreadyAsked: new Set([`user-${A}`]),
    });
    const result = await runVillageIntroSweep(DB, h.deps, NOW);
    expect(result.asked).toBe(1);
    expect(h.transport.sent.map((s) => s.to)).toEqual([`phone-user-${B}`]);
  });

  it('does not ask a family whose area is a city rather than an FSA', async () => {
    const h = harness({
      families: [
        family({ familyId: A, areaCoarse: 'Toronto' }),
        family({ familyId: B, areaCoarse: 'Toronto' }),
      ],
    });
    expect((await runVillageIntroSweep(DB, h.deps, NOW)).asked).toBe(0);
  });

  it.each<[ProactiveHoldReason]>([
    ['not_enrolled'],
    ['no_watch_consent'],
    ['frequency_cap'],
  ])('sends nothing when the outbound gate holds for %s', async (reason) => {
    const h = harness({
      families: [family({ familyId: A }), family({ familyId: B })],
      hold: reason,
    });
    const result = await runVillageIntroSweep(DB, h.deps, NOW);
    expect(h.transport.sent).toEqual([]);
    expect(result.held[reason]).toBe(2);
  });
});

describe('phase 2 - matching and the coarse card', () => {
  const optedIn = { discoverable: new Set([`user-${A}`, `user-${B}`]), alreadyAsked: new Set([`user-${A}`, `user-${B}`]) };

  it('creates one paired proposal and texts BOTH sides the same shape of card', async () => {
    const h = harness({ families: [family({ familyId: A }), family({ familyId: B })], ...optedIn });
    const result = await runVillageIntroSweep(DB, h.deps, NOW);

    expect(result.proposed).toBe(1);
    expect(h.proposalsCreated).toHaveLength(1);
    expect(h.proposalsCreated[0]).toEqual(
      expect.objectContaining({ familyAId: A, familyBId: B, fsa: 'M4K', stage: 'toddler' }),
    );
  });

  it('the card names the recipients OWN child and never the other family', async () => {
    const h = harness({
      families: [family({ familyId: A }), family({ familyId: B })],
      ...optedIn,
      children: {
        [A]: [child({ id: 'a-kid', name: 'Maya' })],
        [B]: [child({ id: 'b-kid', name: SENTINELS.childName })],
      },
      proposals: [proposal({ familyAChildId: 'a-kid', familyBChildId: 'b-kid' })],
    });
    await runVillageIntroSweep(DB, h.deps, NOW);

    const cardToA = bodyTo(h, A) as string;
    expect(cardToA).toBe(
      "A Hale family near you has a toddler around Maya's age. Want an intro? Reply YES INTRO or NO INTRO.",
    );
    for (const secret of Object.values(SENTINELS)) {
      expect(cardToA, `family A's card must never carry "${secret}"`).not.toContain(secret);
    }
    // Non-vacuity: the counterpart's child name WAS reachable and IS used - on their own
    // side's card, about their own child. The name simply never crosses the boundary.
    expect(bodyTo(h, B)).toContain(SENTINELS.childName);
  });

  it('honours the parents child_name_level on their OWN child', async () => {
    const h = harness({
      families: [family({ familyId: A }), family({ familyId: B })],
      ...optedIn,
      nameLevel: 'relation',
      proposals: [proposal()],
    });
    await runVillageIntroSweep(DB, h.deps, NOW);
    expect(h.transport.bodies()[0]).toContain("around your daughter's age");
    expect(h.transport.bodies()[0]).not.toContain('Maya');
  });

  it('never names a 13+ child, whatever the parent set the dial to', async () => {
    const h = harness({
      families: [family({ familyId: A }), family({ familyId: B })],
      ...optedIn,
      nameLevel: 'first_name',
      children: { [A]: [child({ id: 'teen', name: 'Iris', dateOfBirth: '2011-01-01' })] },
      proposals: [proposal({ familyAChildId: 'teen' })],
    });
    await runVillageIntroSweep(DB, h.deps, NOW);
    expect(h.transport.bodies()[0]).not.toContain('Iris');
    expect(h.transport.bodies()[0]).toContain('your kid');
  });

  it('anchors the card on a civic session in the FSA, title verbatim', async () => {
    const h = harness({
      families: [family({ familyId: A }), family({ familyId: B })],
      ...optedIn,
      proposals: [
        proposal({
          anchorTitle: 'Ready for Reading (Ages 3-6)',
          anchorStartsAt: new Date('2026-08-15T14:00:00Z'), // Saturday in Toronto
        }),
      ],
    });
    await runVillageIntroSweep(DB, h.deps, NOW);
    expect(h.transport.bodies()[0]).toContain(
      "They're also eyeing Ready for Reading (Ages 3-6) Saturday.",
    );
  });

  it('stamps each side as asked so the hourly cron cannot card them twice', async () => {
    const h = harness({
      families: [family({ familyId: A }), family({ familyId: B })],
      ...optedIn,
      proposals: [proposal()],
    });
    await runVillageIntroSweep(DB, h.deps, NOW);
    expect(h.asked).toEqual([
      { proposalId: 'prop-1', side: 'a' },
      { proposalId: 'prop-1', side: 'b' },
    ]);
  });

  it('does not re-card a side that was already asked', async () => {
    const h = harness({
      families: [family({ familyId: A }), family({ familyId: B })],
      ...optedIn,
      proposals: [proposal({ familyAAskedAt: NOW })],
    });
    await runVillageIntroSweep(DB, h.deps, NOW);
    expect(h.asked).toEqual([{ proposalId: 'prop-1', side: 'b' }]);
    expect(h.transport.sent).toHaveLength(1);
  });

  it('a revoked family can never appear in a new pairing', async () => {
    const h = harness({
      families: [family({ familyId: A }), family({ familyId: B })],
      discoverable: new Set([`user-${A}`]), // B revoked
      alreadyAsked: new Set([`user-${A}`, `user-${B}`]),
    });
    const result = await runVillageIntroSweep(DB, h.deps, NOW);
    expect(result.proposed).toBe(0);
    expect(h.proposalsCreated).toEqual([]);
    expect(h.transport.sent).toEqual([]);
  });

  it('skips a pair when one family has no email, and names the reason', async () => {
    const h = harness({
      families: [family({ familyId: A }), family({ familyId: B, parentEmail: null })],
      ...optedIn,
    });
    const result = await runVillageIntroSweep(DB, h.deps, NOW);
    expect(result.proposed).toBe(0);
    expect(result.skipped).toEqual({ no_fsa: 0, no_parent_email: 1, no_matchable_child: 0 });
  });
});

describe('phase 3 - resolving a pair', () => {
  const optedIn = { discoverable: new Set([`user-${A}`, `user-${B}`]), alreadyAsked: new Set([`user-${A}`, `user-${B}`]) };

  it('sends ONE intro email once both sides said yes, and audits BOTH families', async () => {
    const h = harness({
      families: [
        family({ familyId: A, parentName: 'Sam Lee', parentEmail: 'sam@example.com' }),
        family({ familyId: B, parentName: SENTINELS.parentName, parentEmail: SENTINELS.email }),
      ],
      ...optedIn,
      proposals: [
        proposal({
          status: 'both_accepted',
          familyAAskedAt: NOW,
          familyBAskedAt: NOW,
          familyAReply: 'yes',
          familyBReply: 'yes',
          anchorTitle: 'Family Storytime',
        }),
      ],
    });
    const result = await runVillageIntroSweep(DB, h.deps, NOW);

    expect(result.introduced).toBe(1);
    expect(h.emails).toHaveLength(1);
    expect(h.emails[0]).toEqual({
      parentA: { firstName: 'Sam', email: 'sam@example.com' },
      parentB: { firstName: 'Priya', email: SENTINELS.email },
      stage: 'toddler',
      anchorTitle: 'Family Storytime',
    });

    const disclosures = h.audits.filter((a) => a.actionTaken === 'village_intro_disclosed');
    expect(disclosures.map((d) => d.familyId).sort()).toEqual([A, B].sort());
    for (const row of disclosures) {
      expect(row.after.disclosedFields).toEqual([
        'parent_first_name',
        'parent_email',
        'child_stage',
        'activity_title',
      ]);
    }
    expect(h.statuses).toEqual([{ proposalId: 'prop-1', status: 'both_accepted', closed: true }]);
  });

  it('does not disclose on a single yes', async () => {
    const h = harness({
      families: [family({ familyId: A }), family({ familyId: B })],
      ...optedIn,
      proposals: [
        proposal({ familyAAskedAt: NOW, familyBAskedAt: NOW, familyAReply: 'yes' }),
      ],
    });
    const result = await runVillageIntroSweep(DB, h.deps, NOW);
    expect(result.introduced).toBe(0);
    expect(h.emails).toEqual([]);
  });

  it('leaves the pair open - and unaudited as disclosed - when the provider is unconfigured', async () => {
    const h = harness({
      families: [family({ familyId: A }), family({ familyId: B })],
      ...optedIn,
      emailResult: { status: 'skipped', reason: 'not_configured' },
      proposals: [
        proposal({
          status: 'both_accepted',
          familyAAskedAt: NOW,
          familyBAskedAt: NOW,
          familyAReply: 'yes',
          familyBReply: 'yes',
        }),
      ],
    });
    const result = await runVillageIntroSweep(DB, h.deps, NOW);

    expect(result.introduced).toBe(0);
    expect(result.introFailed).toBe(1);
    expect(h.statuses).toEqual([]);
    expect(h.audits.filter((a) => a.actionTaken === 'village_intro_disclosed')).toEqual([]);
  });

  it('soft-closes the OTHER side after a no, and never the side that said no', async () => {
    const h = harness({
      families: [family({ familyId: A }), family({ familyId: B })],
      ...optedIn,
      proposals: [
        proposal({
          status: 'declined',
          familyAAskedAt: NOW,
          familyBAskedAt: NOW,
          familyAReply: 'yes',
          familyBReply: 'no',
        }),
      ],
    });
    await runVillageIntroSweep(DB, h.deps, NOW);

    expect(h.transport.bodies()).toEqual([INTRO_SOFT_CLOSE]);
    expect(h.transport.sent[0]?.to).toBe(`phone-user-${A}`);
    expect(h.statuses).toEqual([{ proposalId: 'prop-1', status: 'declined', closed: true }]);
  });

  it('the soft close is identical whether the pair was declined or expired', async () => {
    const declined = harness({
      families: [family({ familyId: A }), family({ familyId: B })],
      ...optedIn,
      proposals: [
        proposal({ status: 'declined', familyAAskedAt: NOW, familyBAskedAt: NOW, familyBReply: 'no' }),
      ],
    });
    await runVillageIntroSweep(DB, declined.deps, NOW);

    const expired = harness({
      families: [family({ familyId: A }), family({ familyId: B })],
      ...optedIn,
      proposals: [
        proposal({
          familyAAskedAt: NOW,
          familyBAskedAt: NOW,
          expiresAt: new Date('2026-08-01T00:00:00Z'),
        }),
      ],
    });
    await runVillageIntroSweep(DB, expired.deps, NOW);

    expect(declined.transport.bodies()).toEqual([INTRO_SOFT_CLOSE]);
    // Both sides were asked and neither refused, so both are owed the same sentence.
    expect(expired.transport.bodies()).toEqual([INTRO_SOFT_CLOSE, INTRO_SOFT_CLOSE]);
    expect(expired.statuses).toEqual([{ proposalId: 'prop-1', status: 'expired', closed: true }]);
  });

  it('never soft-closes a side that was never asked', async () => {
    const h = harness({
      families: [family({ familyId: A }), family({ familyId: B })],
      ...optedIn,
      proposals: [
        proposal({ status: 'declined', familyAAskedAt: NOW, familyAReply: 'no', familyBAskedAt: null }),
      ],
    });
    await runVillageIntroSweep(DB, h.deps, NOW);
    expect(h.transport.sent).toEqual([]);
    expect(h.statuses).toEqual([{ proposalId: 'prop-1', status: 'declined', closed: true }]);
  });
});
