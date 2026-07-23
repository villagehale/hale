import type { AgentClient } from '@hale/agent';
import { stageFromAgeInMonths } from '@hale/types';
import { DEFAULT_TIMEZONE } from '~/lib/format/datetime';
import { correlateExtraction, type CorrelationCandidate } from './correlate';
import { extractChildEvent } from './extract';
import { triageEmail } from './triage';
import type { ExtractionKind, FamilyChildRef, InboxEnvelope, SentinelClassification } from './types';

/**
 * The E2 sentinel — the callable library function E3 wires up. Two-stage,
 * cost-shaped: cheap triage (Haiku) over the envelope decides whether the
 * expensive stage (fetch body + Sonnet 5 extraction) runs at all, then
 * deterministic code (never the LLM) correlates the extraction against the
 * family's known occasions.
 *
 * All I/O is injected (`deps`) so the loop's mechanics are unit-testable with a
 * fake client + fake body fetch (rule #8 — quality is eval-gated separately,
 * against real cached Claude, never a mocked model).
 */

export interface ClassifyChildEventEmailDeps {
  client: AgentClient;
  /** This family's children only (rule #1: no cross-family leakage). */
  children: readonly FamilyChildRef[];
  /** Fetches the full body for a triage-positive message only — never called
   * for a triaged-out envelope. */
  fetchBody: (messageId: string) => Promise<string>;
  /** IANA timezone the extraction resolves relative dates against. Defaults to
   * DEFAULT_TIMEZONE (apps/web/lib/format/datetime.ts) when the caller has no
   * resolved family timezone on hand. */
  familyTimezone?: string;
  /** The family's known occasions to correlate against (B1/B3). An empty array
   * is valid — correlation then always returns null (every extraction reads as
   * unmatched/new). */
  correlationCandidates: readonly CorrelationCandidate[];
}

/** Below this, an ambiguous-but-teen-attributed extraction is treated as
 * possible personal correspondence rather than trusted logistics — mirrors
 * classify-event.md's own "< 0.7 → needs_human" calibration constant, so the
 * two teen-content gates in the codebase agree on what "confident" means. */
const CONFIDENCE_FLOOR = 0.7;

const GENERIC_TITLE: Record<ExtractionKind, string> = {
  cancellation: 'A scheduled activity was cancelled',
  reschedule: 'A scheduled activity was moved',
  new_event: 'A new event was mentioned',
  reminder_only: 'A reminder about a scheduled activity',
  unclear: 'A possible schedule change',
};

/**
 * Rule #1 backstop: the extraction's own `teen_content` is a probabilistic
 * signal, same as classify-event's (ingest.ts applies the identical pattern).
 * It is OR'd true when the resolved child is a teenager AND the extraction is
 * itself ambiguous (`unclear` kind, or below CONFIDENCE_FLOOR) — a confident,
 * clearly-logistics extraction about a teen (a cancelled practice, picture day)
 * is deliberately NOT forced true, per the ticket's explicit carve-out: school/
 * logistics notices about a teen are fine to surface with full detail. Only
 * genuine ambiguity defaults to the more restrictive read.
 */
function resolveTeenContent(
  llmFlag: boolean,
  kind: ExtractionKind,
  sourceConfidence: number,
  childRef: string | null,
  children: readonly FamilyChildRef[],
): boolean {
  if (llmFlag) return true;
  if (childRef === null) return false;
  const child = children.find((c) => c.id === childRef);
  if (!child || stageFromAgeInMonths(child.ageInMonths) !== 'teenager') return false;
  return kind === 'unclear' || sourceConfidence < CONFIDENCE_FLOOR;
}

export async function classifyChildEventEmail(
  envelope: InboxEnvelope,
  deps: ClassifyChildEventEmailDeps,
): Promise<SentinelClassification> {
  const childNames = deps.children.map((c) => c.name);
  const triage = await triageEmail(
    { subject: envelope.subject, from: envelope.from, snippet: envelope.snippet },
    childNames,
    deps.client,
  );

  if (!triage.childRelated) {
    return {
      status: 'triaged_out',
      familyId: envelope.familyId,
      messageId: envelope.messageId,
      extraction: null,
      usage: { triage: triage.usage, extract: null },
    };
  }

  const body = await deps.fetchBody(envelope.messageId);
  const extracted = await extractChildEvent(
    {
      subject: envelope.subject,
      from: envelope.from,
      body,
      receivedAt: envelope.receivedAt,
      familyTimezone: deps.familyTimezone ?? DEFAULT_TIMEZONE,
      children: deps.children,
    },
    deps.client,
  );

  const teenContent = resolveTeenContent(
    extracted.teenContent,
    extracted.kind,
    extracted.sourceConfidence,
    extracted.event.childRef,
    deps.children,
  );

  const matchedEventRef = correlateExtraction(
    {
      kind: extracted.kind,
      title: extracted.event.title,
      originalTime: extracted.event.originalTime,
      newTime: extracted.event.newTime,
    },
    deps.correlationCandidates,
  );

  return {
    status: 'classified',
    familyId: envelope.familyId,
    messageId: envelope.messageId,
    extraction: {
      kind: extracted.kind,
      // Teen-redacted (rule #1): the title/quote generalize, the same shape
      // week_plans.ts uses ("keeps the id(s) for de-dup but carries a generic
      // title + no name"). childRef stays on the event for de-dup, not shown raw.
      event: teenContent
        ? { ...extracted.event, title: GENERIC_TITLE[extracted.kind] }
        : extracted.event,
      sourceConfidence: extracted.sourceConfidence,
      quoteEvidence: teenContent ? null : extracted.quoteEvidence,
      teenContent,
      matchedEventRef,
    },
    usage: { triage: triage.usage, extract: extracted.usage },
  };
}
