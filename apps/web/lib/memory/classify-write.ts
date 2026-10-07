import { type Database, schema } from '@hale/db';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import {
  type FactWrite,
  type FactWriteResult,
  closeFacts,
  resolveValidFrom,
  writeFact,
} from './facts';
import { temporaryExpiry } from './kinds';
import type { MemorySource } from './kinds';

/**
 * VIL-419 — the model classifies a fact when it is saved.
 *
 * The distiller, the nightly inferencer, and the coach each pass `memoryClass`
 * and `disposition`. This module does not look at the fact key. A key named
 * "age" or "district" is not evidence of identity; the model's class is.
 * What the code enforces is structural:
 *
 * - a declined fact is never stored as confirmed, and its event time stays the
 *   instant the model named (a rejected Oct 1 activity is not a confirmed Oct 4)
 * - a passing question (`curiosity` or `asked`) is not a preference; only a
 *   later write the model classifies as enduring identity replaces it
 * - a temporary obligation always carries an expiry, so a one-off decays
 * - a correction names the live key it replaces, and that row is superseded
 */

export const MODEL_MEMORY_CLASSES = ['enduring', 'obligation', 'curiosity'] as const;
export type ModelMemoryClass = (typeof MODEL_MEMORY_CLASSES)[number];

export const MODEL_DISPOSITIONS = ['confirmed', 'declined', 'asked'] as const;
export type ModelDisposition = (typeof MODEL_DISPOSITIONS)[number];

/** Prompt vocabulary. Maps onto the stored `memory_kind` column. */
export type PromptMemoryKind = ModelMemoryClass;

export const modelClassificationShape = {
  memoryClass: z
    .enum(MODEL_MEMORY_CLASSES)
    .describe(
      'enduring (who the family is, names, ages, home, a settled routine), obligation (a one-off event or a declined activity), or curiosity (a passing question).',
    ),
  disposition: z
    .enum(MODEL_DISPOSITIONS)
    .describe(
      'confirmed, declined, or asked. A declined or rejected activity is declined, never confirmed.',
    ),
  expiresAt: z
    .string()
    .optional()
    .describe(
      'ISO-8601 when a temporary obligation should stop steering. Omit to use a short window.',
    ),
  correctsKey: z
    .string()
    .min(1)
    .optional()
    .describe('Live fact key this correction replaces, when it differs from factKey.'),
};

type MemoryFactType = FactWrite['factType'];

export interface ModelClassificationInput {
  memoryClass: ModelMemoryClass;
  disposition: ModelDisposition;
  observedAt?: string | null;
  expiresAt?: string | null;
}

interface ValuePatch {
  disposition: ModelDisposition;
  memoryClass: ModelMemoryClass;
  observedAt?: string;
}

export interface AcceptedClassification {
  memoryKind: 'lasting' | 'temporary' | 'one_off';
  kind: PromptMemoryKind;
  disposition: ModelDisposition;
  expiresAt: Date | null;
  validFrom: Date;
  signalCount: number;
  /** Merged into an object value. Null leaves a confirmed identity value untouched. */
  valuePatch: ValuePatch | null;
}

function parseInstant(value: string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Place one model write. Declined wins over whatever class the model also
 * sent. A question wins over an enduring class. Neither path consults the key.
 */
export function acceptModelMemoryClass(
  input: ModelClassificationInput,
  now: Date,
): AcceptedClassification {
  const { memoryClass, disposition } = input;
  const eventAt = parseInstant(input.observedAt);
  const validFrom = resolveValidFrom(input.observedAt ?? undefined, now);

  if (disposition === 'declined') {
    const expiresAt =
      eventAt ??
      // No event time: the decline is already over. Do not leave it live as a plan.
      now;
    return {
      memoryKind: 'temporary',
      kind: 'obligation',
      disposition: 'declined',
      expiresAt,
      validFrom,
      signalCount: 0,
      valuePatch: {
        disposition: 'declined',
        memoryClass: 'obligation',
        ...(eventAt ? { observedAt: eventAt.toISOString() } : {}),
      },
    };
  }

  if (memoryClass === 'curiosity' || disposition === 'asked') {
    return {
      memoryKind: 'one_off',
      kind: 'curiosity',
      disposition: 'asked',
      expiresAt: null,
      validFrom,
      signalCount: 0,
      valuePatch: {
        disposition: 'asked',
        memoryClass: 'curiosity',
        ...(eventAt ? { observedAt: eventAt.toISOString() } : {}),
      },
    };
  }

  if (memoryClass === 'obligation') {
    return {
      memoryKind: 'temporary',
      kind: 'obligation',
      disposition: 'confirmed',
      expiresAt: obligationExpiry(input.expiresAt, eventAt, now),
      validFrom,
      signalCount: 0,
      valuePatch: {
        disposition: 'confirmed',
        memoryClass: 'obligation',
        ...(eventAt ? { observedAt: eventAt.toISOString() } : {}),
      },
    };
  }

  return {
    memoryKind: 'lasting',
    kind: 'enduring',
    disposition: 'confirmed',
    expiresAt: null,
    validFrom,
    signalCount: 0,
    valuePatch: null,
  };
}

function obligationExpiry(
  expiresAt: string | null | undefined,
  eventAt: Date | null,
  now: Date,
): Date {
  const explicit = parseInstant(expiresAt);
  if (explicit && explicit.getTime() > now.getTime()) return explicit;
  // A named event, past or future, decays at that instant. No date: one week.
  if (eventAt) return eventAt;
  return temporaryExpiry(now, 'week');
}

export function applyValuePatch(value: unknown, patch: ValuePatch | null): unknown {
  if (!patch) return value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return { ...(value as Record<string, unknown>), ...patch };
  }
  return { text: value, ...patch };
}

export function readDisposition(value: unknown): ModelDisposition {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'confirmed';
  const disposition = (value as { disposition?: unknown }).disposition;
  if (disposition === 'declined' || disposition === 'asked' || disposition === 'confirmed') {
    return disposition;
  }
  return 'confirmed';
}

export function promptKind(
  memoryKind: string | null | undefined,
  factValue?: unknown,
): PromptMemoryKind {
  if (factValue && typeof factValue === 'object' && !Array.isArray(factValue)) {
    const memoryClass = (factValue as { memoryClass?: unknown }).memoryClass;
    if (memoryClass === 'enduring' || memoryClass === 'obligation' || memoryClass === 'curiosity') {
      return memoryClass;
    }
  }
  if (memoryKind === 'temporary') return 'obligation';
  if (memoryKind === 'one_off') return 'curiosity';
  return 'enduring';
}

export function readObservedAt(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const observedAt = (value as { observedAt?: unknown }).observedAt;
  return typeof observedAt === 'string' ? observedAt : null;
}

export interface ClassifiedCommit {
  familyId: string;
  childId: string | null;
  factType: MemoryFactType;
  factKey: string;
  factValue: unknown;
  confidence: number;
  inferredBy: string;
  source: MemorySource;
  now: Date;
  memoryClass: ModelMemoryClass;
  disposition: ModelDisposition;
  observedAt?: string | null;
  expiresAt?: string | null;
  correctsKey?: string | null;
  sourceEventId?: string;
}

/**
 * Writes the classified fact and, when the correction names a different key,
 * supersedes that live row. Same-key replacement is `writeFact`'s own chain.
 */
export async function commitClassifiedMemory(
  database: Database,
  input: ClassifiedCommit,
): Promise<FactWriteResult> {
  const accepted = acceptModelMemoryClass(input, input.now);
  const written = await writeFact(database, {
    familyId: input.familyId,
    childId: input.childId,
    factType: input.factType,
    factKey: input.factKey,
    factValue: applyValuePatch(input.factValue, accepted.valuePatch),
    confidence: input.confidence,
    inferredBy: input.inferredBy,
    sourceEventId: input.sourceEventId,
    validFrom: accepted.validFrom,
    memoryKind: accepted.memoryKind,
    memorySource: input.source,
    sourcedAt: input.now,
    expiresAt: accepted.expiresAt,
    signalCount: accepted.signalCount,
  });

  const correctsKey = input.correctsKey?.trim();
  if (correctsKey && correctsKey !== input.factKey) {
    const prior = await database
      .select({ id: schema.familyMemoryFacts.id })
      .from(schema.familyMemoryFacts)
      .where(
        and(
          eq(schema.familyMemoryFacts.familyId, input.familyId),
          input.childId === null
            ? isNull(schema.familyMemoryFacts.childId)
            : eq(schema.familyMemoryFacts.childId, input.childId),
          eq(schema.familyMemoryFacts.factKey, correctsKey),
          isNull(schema.familyMemoryFacts.validUntil),
        ),
      );
    if (prior.length > 0) {
      await closeFacts(database, {
        factIds: prior.map((row) => row.id),
        closedAt: input.now,
        supersededBy: written.factId,
      });
    }
  }

  return written;
}
