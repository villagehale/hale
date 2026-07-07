import type { AgentClient } from '@hale/agent';
import { type Database, schema } from '@hale/db';
import type { DraftedAction, ReviewerVerdict } from '@hale/types';
import { invokeReviewerTool, runReviewer } from '@hale/worker/reviewer';
import { eq } from 'drizzle-orm';

/**
 * Review stage — the structural enforcement of hard rule #3 (the reviewer MUST
 * invoke verification tools; never approve on prose). DELEGATED to the single
 * worker reviewer (`runReviewer`) so the web and worker paths can no longer
 * drift: one loop, one tool registry, one prompt. The Anthropic client and the
 * request-scoped database are injected — the worker's runReviewer owns the
 * verdict-tool terminal, the coverage downgrade, and the ISSUE-5b/5c idempotency
 * self-match exclusion.
 */

export interface ReviewResult {
  verdict: ReviewerVerdict;
  usage: { promptTokens: number; completionTokens: number };
}

export async function reviewAction(
  input: { familyId: string; draft: DraftedAction },
  database: Database,
  client: AgentClient,
): Promise<ReviewResult> {
  const { verdict, runMetrics } = await runReviewer(
    { familyId: input.familyId, draft: input.draft },
    {
      client,
      invokeTool: (name, toolInput) => invokeReviewerTool(name, toolInput, database),
      loadChildNames: async (familyId: string) => {
        const rows = await database
          .select({ name: schema.children.name })
          .from(schema.children)
          .where(eq(schema.children.familyId, familyId));
        return rows.map((r) => r.name);
      },
    },
  );
  return {
    verdict,
    usage: {
      promptTokens: runMetrics.promptTokens,
      completionTokens: runMetrics.completionTokens,
    },
  };
}
