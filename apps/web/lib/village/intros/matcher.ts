import { FAMILY_STAGES, type FamilyStage, deriveStage } from '@hale/types';

/**
 * Village intros v1 — WHO gets paired with whom. Pure: no database, no clock of its
 * own, no sends. Everything this decides is decided from its arguments, so every rule
 * below is a test rather than an integration.
 *
 * MATCH QUALITY v1 IS TWO FACTS: the same forward sortation area, and an overlapping
 * child stage band. That is deliberately thin. A richer score (interests, schedules,
 * how chatty a parent is) needs data Hale would have to infer about families who never
 * asked to be scored, and the first version of a cross-household disclosure is the
 * wrong place to start inferring. Two families a walk apart with children the same age
 * is a good enough reason for two parents to meet; anything more is Hale's opinion.
 *
 * THE TEEN BAND IS EXCLUDED AT THE SOURCE (see {@link eligibleAnchorChildren}), which
 * is a deliberate narrowing of the spec. The card copy applies the child_name_level and
 * teen-redaction rules on top, so a teen's NAME could never reach a card either way —
 * but the existence of a 13+ child is still a fact about that child, and disclosing it
 * to another household is a third-party disclosure that Hale's parent-only consent
 * model does not cover (rule #1, rule #5's teen assent). The gate at the source is the
 * floor; the redaction in the copy is the backstop, exactly as the nudge sweep does it.
 */

/** A Canadian forward sortation area: letter, digit, letter. The ONLY locality grain
 * this feature matches on. */
const FSA_PATTERN = /^[A-Za-z]\d[A-Za-z]$/;

/**
 * The FSA in this value, or null when there is not one.
 *
 * `families.area_coarse` is NOT reliably an FSA: `deriveAreaCoarse` falls back to the
 * CITY when a family has no postal code, so half the column is "Toronto" and "North
 * York". Matching on a city would quietly turn "a Hale family near you" into "a Hale
 * family somewhere in a city of three million", which is a different product and a
 * worse one. Anything not FSA-shaped is refused here and the family is skipped by name.
 */
export function normalizeFsa(areaOrPostal: string | null): string | null {
  if (!areaOrPostal) return null;
  const compact = areaOrPostal.replace(/\s+/g, '');
  const head = compact.slice(0, 3);
  return FSA_PATTERN.test(head) ? head.toUpperCase() : null;
}

export interface IntroCandidateChild {
  id: string;
  dateOfBirth: string;
}

export interface IntroCandidateFamily {
  familyId: string;
  parentUserId: string;
  /** As stored — `families.area_coarse` or the postal code. Normalized here, not by the
   * caller, so no caller can pass a city in by mistake. */
  fsa: string | null;
  /** The address the intro email would reach this family at. Null is a real, common
   * state (an SMS-only family that never signed in) and it is why v1 matches only
   * families that HAVE one: the handoff is an email, and half a handoff is worse than
   * none. */
  parentEmail: string | null;
  children: readonly IntroCandidateChild[];
}

export interface AnchorChild {
  id: string;
  stage: FamilyStage;
}

/**
 * The children a proposal may be worded around: the family's UNDER-13s, with their
 * stage derived LIVE from the date of birth so the gate cannot go stale on a birthday.
 */
export function eligibleAnchorChildren(
  children: readonly IntroCandidateChild[],
  now: Date,
): AnchorChild[] {
  const eligible: AnchorChild[] = [];
  for (const child of children) {
    const stage = deriveStage(child.dateOfBirth, now);
    if (stage === 'teenager') continue;
    eligible.push({ id: child.id, stage });
  }
  return eligible;
}

/** Why a family that opted in still was not paired. An enum, never free text: it is
 * counted and logged, so it must be safe to emit and stable to aggregate on. */
export type IntroSkipReason = 'no_fsa' | 'no_parent_email' | 'no_matchable_child';

export interface IntroPairing {
  familyAId: string;
  familyBId: string;
  familyAChildId: string;
  familyBChildId: string;
  fsa: string;
  stage: FamilyStage;
}

export interface IntroSkip {
  familyId: string;
  reason: IntroSkipReason;
}

export interface MatchIntroPairsInput {
  /** Every family that has opted in to discoverability. Consent is the CALLER's read
   * (it is a ledger query); everything else about eligibility is decided here. */
  families: readonly IntroCandidateFamily[];
  /** Families already carrying an open proposal. One open question at a time: a parent
   * holding two "want an intro?" texts cannot tell which one a bare YES INTRO answers. */
  familiesWithOpenProposal: ReadonlySet<string>;
  /** Pairs that have been proposed before, as {@link pairKey}. A pair is never
   * re-proposed — not after a decline, not after an expiry, not after a completed
   * intro. Asking twice is how a "no" becomes nagging. */
  pairedBefore: ReadonlySet<string>;
  now: Date;
}

export interface MatchIntroPairsResult {
  pairings: IntroPairing[];
  skipped: IntroSkip[];
}

/** The canonical identity of an unordered pair. Id-ordered, so the same two families
 * produce the same key whichever way round they are read. */
export function pairKey(familyIdA: string, familyIdB: string): string {
  return familyIdA < familyIdB ? `${familyIdA}:${familyIdB}` : `${familyIdB}:${familyIdA}`;
}

interface Ready {
  familyId: string;
  fsa: string;
  /** Anchor children grouped by band, each already in oldest-first order. */
  byStage: Map<FamilyStage, AnchorChild[]>;
}

/**
 * The pairs to create this run, plus every family that was considered and left out.
 *
 * ONE NEW PROPOSAL PER FAMILY PER RUN, and one open proposal at a time. In an FSA with
 * three opted-in families that is one pair now and the third family next week — which
 * is the right shape even at scale, because an intro is a thing a parent does, not a
 * feed they scroll.
 *
 * Deterministic throughout: FSAs and families are walked in sorted order, bands in
 * childhood order, children oldest-first. The same input produces the same pairing, so
 * a re-run of the sweep cannot shuffle who gets matched with whom.
 */
export function matchIntroPairs(input: MatchIntroPairsInput): MatchIntroPairsResult {
  const skipped: IntroSkip[] = [];
  const byFsa = new Map<string, Ready[]>();

  for (const family of [...input.families].sort((a, b) => a.familyId.localeCompare(b.familyId))) {
    const fsa = normalizeFsa(family.fsa);
    if (fsa === null) {
      skipped.push({ familyId: family.familyId, reason: 'no_fsa' });
      continue;
    }
    if (!family.parentEmail) {
      skipped.push({ familyId: family.familyId, reason: 'no_parent_email' });
      continue;
    }
    const anchors = eligibleAnchorChildren(family.children, input.now);
    if (anchors.length === 0) {
      skipped.push({ familyId: family.familyId, reason: 'no_matchable_child' });
      continue;
    }
    // Already open? Not a skip REASON — the family is fine, it is just busy — so it is
    // dropped from the pool without being reported as ineligible.
    if (input.familiesWithOpenProposal.has(family.familyId)) continue;

    const byStage = new Map<FamilyStage, AnchorChild[]>();
    for (const anchor of anchors) {
      const bucket = byStage.get(anchor.stage);
      if (bucket) bucket.push(anchor);
      else byStage.set(anchor.stage, [anchor]);
    }
    // Oldest first inside each band, then by id — a stable anchor so re-running the
    // matcher on the same family cannot word the card around a different child.
    const order = new Map(family.children.map((child, i) => [child.id, i]));
    for (const bucket of byStage.values()) {
      bucket.sort((a, b) => {
        const dobA = family.children[order.get(a.id) as number]?.dateOfBirth ?? '';
        const dobB = family.children[order.get(b.id) as number]?.dateOfBirth ?? '';
        return dobA === dobB ? a.id.localeCompare(b.id) : dobA.localeCompare(dobB);
      });
    }

    const bucket = byFsa.get(fsa);
    if (bucket) bucket.push({ familyId: family.familyId, fsa, byStage });
    else byFsa.set(fsa, [{ familyId: family.familyId, fsa, byStage }]);
  }

  const pairings: IntroPairing[] = [];
  const taken = new Set<string>();

  for (const fsa of [...byFsa.keys()].sort()) {
    const pool = byFsa.get(fsa) as Ready[];
    for (let i = 0; i < pool.length; i += 1) {
      const left = pool[i] as Ready;
      if (taken.has(left.familyId)) continue;
      for (let j = i + 1; j < pool.length; j += 1) {
        const right = pool[j] as Ready;
        if (taken.has(right.familyId)) continue;
        if (input.pairedBefore.has(pairKey(left.familyId, right.familyId))) continue;

        const stage = FAMILY_STAGES.find((s) => left.byStage.has(s) && right.byStage.has(s));
        if (!stage) continue;

        const [a, b] =
          left.familyId < right.familyId ? ([left, right] as const) : ([right, left] as const);
        pairings.push({
          familyAId: a.familyId,
          familyBId: b.familyId,
          familyAChildId: (a.byStage.get(stage) as AnchorChild[])[0]?.id as string,
          familyBChildId: (b.byStage.get(stage) as AnchorChild[])[0]?.id as string,
          fsa,
          stage,
        });
        taken.add(left.familyId);
        taken.add(right.familyId);
        break;
      }
    }
  }

  return { pairings, skipped };
}
