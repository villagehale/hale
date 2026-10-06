import { type Skill, defineTool } from '@hale/agent';
import type { AgentClient } from '@hale/agent';
import type { Database } from '@hale/db';
import { z } from 'zod';
import { loadCronSkill } from '~/lib/cron/skill';
import {
  type GmailDraftCommit,
  type GmailDraftGate,
  type GmailDraftOperation,
  type GmailDraftRequest,
  commitProductionGmailDraft,
  gateProductionGmailDraft,
} from '~/lib/integrations/gmail-draft-service';
import { googleWriteScopesEnabled } from '~/lib/integrations/google-write-flag';
import { composeGmailDraftNotice } from './gmail-draft-notice';

export type GmailDraftNoticeBox = { status: 'ready'; text: string } | { status: 'unsent' };

export interface GmailDraftToolPorts {
  gate: (request: GmailDraftRequest) => Promise<GmailDraftGate>;
  commit: (request: GmailDraftRequest) => Promise<GmailDraftCommit>;
  composeNotice: (operation: GmailDraftOperation) => Promise<string | null>;
}

/**
 * Prepare a Gmail draft the parent sends themselves.
 *
 * The notice is composed before the draft is written, so a sentence Hale cannot
 * send does not leave a draft nobody was told about. A failed notice is reported
 * on the box; the runtime then sends nothing. A skip (flag off, scope missing,
 * no thread) is handed back to the model, which still owes the parent an answer.
 */
export function prepareGmailDraftTool(
  ports: GmailDraftToolPorts,
  onNotice: (box: GmailDraftNoticeBox) => void,
) {
  return defineTool({
    name: 'prepare_gmail_draft',
    description:
      "Prepare, update, or delete a Gmail DRAFT in the parent's own mailbox. Hale never sends it. Call this when they ask you to reply to a coach, camp, or school email. `body` is the reply, in their voice. `about` is a hint that finds the thread (a name, a subject). `operation` is create, update, or delete. On update or delete, pass the draftId this tool returned earlier. If the result is drafted, `notice` is the ENTIRE text you send — do not add a question, do not ask them to reply YES, and do not say the email was sent. If drafted is false, say what the reason allows and do not claim a draft exists.",
    monetary: false,
    touchesChildContent: false,
    inputSchema: z.object({
      operation: z.enum(['create', 'update', 'delete']),
      body: z.string().min(1).max(4000).optional(),
      about: z.string().min(1).max(120).optional(),
      draftId: z.string().min(1).max(128).optional(),
      threadId: z.string().min(1).max(128).optional(),
    }),
    inputExamples: [
      {
        operation: 'create',
        about: 'Thursday swim',
        body: 'Thanks, Thursday at 4 still works for us.',
      },
    ],
    handler: async (input, ctx) => {
      const request: GmailDraftRequest = {
        familyId: ctx.familyId,
        actorUserId: ctx.actor,
        operation: input.operation,
        ...(input.body ? { body: input.body } : {}),
        ...(input.about ? { about: input.about } : {}),
        ...(input.draftId ? { draftId: input.draftId } : {}),
        ...(input.threadId ? { threadId: input.threadId } : {}),
      };
      const gated = await ports.gate(request);
      if (gated.status !== 'proceed') {
        return { drafted: false as const, reason: gated.reason };
      }
      const notice = await ports.composeNotice(input.operation);
      if (!notice) {
        onNotice({ status: 'unsent' });
        return { drafted: false as const, reason: 'notice_unsent' as const };
      }
      const written = await ports.commit(request);
      if (written.status !== 'drafted') {
        const reason = written.status === 'failed' ? written.reason : written.reason;
        return { drafted: false as const, reason };
      }
      onNotice({ status: 'ready', text: notice });
      return { drafted: true as const, draftId: written.draftId, notice };
    },
  });
}

/**
 * The coach skill on disk does not name this tool. That file is the cache key
 * for the channel eval, and production leaves the flag unset, so those bytes
 * stay put. Preview turns the flag on and this appends the loaded addendum
 * plus the allowlist entry. Both or neither: a listed tool nobody registered
 * throws mid-turn.
 */
export async function augmentCoachSkillForGoogleDrafts(skill: Skill): Promise<Skill> {
  if (!googleWriteScopesEnabled()) return skill;
  const extra = await loadCronSkill('gmail-draft-coach');
  const tools = skill.meta.tools.includes('prepare_gmail_draft')
    ? skill.meta.tools
    : [...skill.meta.tools, 'prepare_gmail_draft'];
  return {
    ...skill,
    meta: { ...skill.meta, tools },
    instructions: `${skill.instructions}\n\n${extra.instructions}`,
  };
}

export function productionGmailDraftPorts(
  database: Database,
  client: () => AgentClient,
): GmailDraftToolPorts {
  return {
    gate: (request) => gateProductionGmailDraft(database, request),
    commit: (request) => commitProductionGmailDraft(database, request),
    composeNotice: (operation) => composeGmailDraftNotice(client(), operation),
  };
}
