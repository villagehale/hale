import { type AgentClient, pickLane } from '@hale/agent';
import type { Database } from '@hale/db';
import { z } from 'zod';
import { resolveReplyClient } from '~/lib/channel/reply-copy/client';
import { loadCronSkill } from '~/lib/cron/skill';
import { hasLinkShape, withoutLinks } from '~/lib/format/link-shape';
import {
  type GmailDraftDeps,
  commitGmailDraft,
  gmailComposeReadiness,
  productionGmailDraftDeps,
} from '~/lib/integrations/gmail-draft-service';
import { forceToolJson } from '~/lib/pipeline/structured';

/**
 * The email to a provider whose site did not offer the start the parent asked for. The model
 * writes it from the plan's facts; Hale only ever leaves it as a DRAFT in the parent's Gmail,
 * with the provider's address visible in To:, for the parent to read and send. The address
 * comes off the provider's page, so it is never shown to the model, and neither the address
 * nor the body is logged or stored.
 */

export const SIGNUP_PROVIDER_EMAIL_SKILL = 'signup-provider-email';
export const SIGNUP_PROVIDER_EMAIL_TOOL = 'signup_provider_email';
export const SIGNUP_PROVIDER_EMAIL_TOOL_DESCRIPTION =
  'Write the email draft to the provider that the parent will read and send.';
export const SIGNUP_PROVIDER_EMAIL_MAX_TOKENS = 1200;
export const PROVIDER_EMAIL_SUBJECT_MAX = 120;
export const PROVIDER_EMAIL_BODY_MAX = 4000;

export const signupProviderEmailSchema = z
  .object({ subject: z.string(), body: z.string() })
  .strict();
export const SIGNUP_PROVIDER_EMAIL_TOOL_SCHEMA = {
  type: 'object',
  properties: { subject: { type: 'string' }, body: { type: 'string' } },
  required: ['subject', 'body'],
  additionalProperties: false,
} as const;

export interface ProviderEmailFacts {
  childFirstName: string | null;
  activity: string | null;
  /** What the parent first asked for, as the plan named it. */
  askedStart: string | null;
  /** The site's real options, as the page showed them. */
  siteChoices: readonly { label: string; startsAt: string | null; waitlist: boolean }[];
}

export interface ProviderEmailDraft {
  subject: string;
  body: string;
}

export interface ProviderEmailWriter {
  write(facts: ProviderEmailFacts): Promise<ProviderEmailDraft | null>;
}

/** Why Hale could not leave the provider email in the parent's Gmail. */
export type ProviderEmailBlocked =
  | 'no_provider_email'
  | 'flag_off'
  | 'not_connected'
  | 'scope_missing'
  | 'token_unavailable'
  | 'unwritten'
  | 'google_error';

export interface ProviderEmailDrafter {
  readiness(input: {
    familyId: string;
    actorUserId: string;
    to: string | null;
  }): Promise<{ ok: true } | { ok: false; reason: ProviderEmailBlocked }>;
  write(facts: ProviderEmailFacts): Promise<ProviderEmailDraft | null>;
  commit(input: {
    familyId: string;
    actorUserId: string;
    to: string;
    subject: string;
    body: string;
  }): Promise<
    { status: 'drafted'; draftId: string } | { status: 'blocked'; reason: ProviderEmailBlocked }
  >;
}

/** Why a draft cannot be left in the parent's Gmail. Empty means it can. */
export function providerEmailViolations(draft: ProviderEmailDraft): string[] {
  const out: string[] = [];
  const subject = draft.subject.trim();
  const body = draft.body.trim();
  if (!subject) out.push('empty subject');
  if (!body) out.push('empty body');
  if (/[\r\n]/.test(draft.subject)) out.push('the subject is one line');
  if (subject.length > PROVIDER_EMAIL_SUBJECT_MAX) {
    out.push(`the subject is at most ${PROVIDER_EMAIL_SUBJECT_MAX} characters`);
  }
  if (body.length > PROVIDER_EMAIL_BODY_MAX) {
    out.push(`the body is at most ${PROVIDER_EMAIL_BODY_MAX} characters`);
  }
  if (hasLinkShape(subject) || hasLinkShape(body)) out.push('contains a link: write none');
  return out;
}

/** The user turn: the facts, page labels stripped of anything link-shaped, and the last violation. */
export function providerEmailUserMessage(
  facts: ProviderEmailFacts,
  violation: string | null,
): string {
  return JSON.stringify({
    facts: {
      ...facts,
      activity: facts.activity === null ? null : withoutLinks(facts.activity),
      siteChoices: facts.siteChoices.map((choice) => ({
        ...choice,
        label: withoutLinks(choice.label),
      })),
    },
    violation,
  });
}

function unwritten(reason: string, detail?: string): null {
  console.info({ reason, detail }, 'signup provider email: not written');
  return null;
}

/** `client` is a resolver: a missing key is unwritten, never a throw. Two attempts. */
export function createProviderEmailWriter(
  client: () => AgentClient | null | Promise<AgentClient | null>,
): ProviderEmailWriter {
  return {
    async write(facts) {
      let resolved: AgentClient | null;
      try {
        resolved = await client();
      } catch (err) {
        return unwritten('client_unavailable', err instanceof Error ? err.name : 'unknown');
      }
      if (!resolved) return unwritten('client_unavailable');
      let skill: Awaited<ReturnType<typeof loadCronSkill>>;
      try {
        skill = await loadCronSkill(SIGNUP_PROVIDER_EMAIL_SKILL);
      } catch (err) {
        return unwritten('skill_unavailable', err instanceof Error ? err.name : 'unknown');
      }
      let note: string | null = null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const { value } = await forceToolJson({
            client: resolved,
            lane: pickLane(skill.meta.task),
            system: skill.instructions,
            userMessage: providerEmailUserMessage(facts, note),
            toolName: SIGNUP_PROVIDER_EMAIL_TOOL,
            toolDescription: SIGNUP_PROVIDER_EMAIL_TOOL_DESCRIPTION,
            inputJsonSchema: SIGNUP_PROVIDER_EMAIL_TOOL_SCHEMA,
            schema: signupProviderEmailSchema,
            maxTokens: SIGNUP_PROVIDER_EMAIL_MAX_TOKENS,
          });
          const draft = { subject: value.subject.trim(), body: value.body.trim() };
          const violations = providerEmailViolations(draft);
          if (violations.length === 0) return draft;
          note = violations.join('; ');
        } catch (err) {
          return unwritten('model_failed', err instanceof Error ? err.name : 'unknown');
        }
      }
      return unwritten('violations', note ?? '');
    },
  };
}

export function createProviderEmailDrafter(deps: {
  gmail: GmailDraftDeps;
  writer: ProviderEmailWriter;
}): ProviderEmailDrafter {
  return {
    async readiness(input) {
      if (!input.to) return { ok: false, reason: 'no_provider_email' };
      return gmailComposeReadiness(input, deps.gmail);
    },
    write: (facts) => deps.writer.write(facts),
    async commit(input) {
      const committed = await commitGmailDraft(
        {
          familyId: input.familyId,
          actorUserId: input.actorUserId,
          operation: 'create',
          body: input.body,
          compose: { to: input.to, subject: input.subject },
        },
        deps.gmail,
      );
      if (committed.status === 'drafted') return { status: 'drafted', draftId: committed.draftId };
      if (committed.status === 'failed') return { status: 'blocked', reason: 'google_error' };
      switch (committed.reason) {
        case 'flag_off':
        case 'not_connected':
        case 'scope_missing':
        case 'token_unavailable':
          return { status: 'blocked', reason: committed.reason };
        case 'missing_body':
          return { status: 'blocked', reason: 'unwritten' };
        case 'thread_unresolved':
        case 'not_ours':
        case 'missing_draft':
          throw new Error(`a compose draft cannot be skipped as ${committed.reason}`);
      }
    },
  };
}

export function productionProviderEmailDrafter(database: Database): ProviderEmailDrafter {
  return createProviderEmailDrafter({
    gmail: productionGmailDraftDeps(database),
    writer: createProviderEmailWriter(() => resolveReplyClient(undefined)),
  });
}
