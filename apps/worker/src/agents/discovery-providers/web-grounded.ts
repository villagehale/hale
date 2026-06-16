import type Anthropic from '@anthropic-ai/sdk';
import type { DiscoveryQuery } from '@hale/types';
import { z } from 'zod';
import { SONNET_MODEL, anthropicClient } from '../../anthropic/client.js';
import { loadPrompt } from '../../prompts/loader.js';
import { forceToolJson } from '../structured.js';
import type { DiscoveredCandidate, DiscoveryProvider } from './types.js';

/**
 * The real discovery provider: Claude with the web-search server tool.
 *
 * Web grounding is NEW to this repo. The flow is two-phase because the
 * structured-output path (`forceToolJson`) FORCES a custom tool, which would
 * suppress the server-side `web_search` tool. So we:
 *   1. Run a grounded research call (`web_search_20250305`, `tool_choice:auto`)
 *      and harvest the public listing URLs from its `web_search_tool_result`
 *      blocks — these are the grounding evidence.
 *   2. Feed the research text + the evidence URLs into `forceToolJson` to
 *      extract calibrated candidates.
 *
 * Honesty (brief + rule #1): a candidate whose `sourceUrl` is one of the
 * harvested grounding URLs is `web_grounded`; anything the model proposes
 * WITHOUT live grounding degrades to `llm_only` with capped confidence. The
 * query carries a COARSE area only, so no precise child location can reach the
 * web search.
 */

const LLM_ONLY_CONFIDENCE_CAP = 0.5;
const MAX_SEARCHES = 4;

const extractionSchema = z.object({
  candidates: z.array(
    z.object({
      title: z.string(),
      description: z.string(),
      sourceUrl: z.string().optional(),
      confidence: z.number().min(0).max(1),
      coverageNote: z.string(),
    }),
  ),
});

const extractionJsonSchema = {
  type: 'object',
  properties: {
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          description: { type: 'string' },
          sourceUrl: { type: 'string' },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          coverageNote: { type: 'string' },
        },
        required: ['title', 'description', 'confidence', 'coverageNote'],
      },
    },
  },
  required: ['candidates'],
} as const;

export type DiscoveryAnthropicClient = Pick<Anthropic, 'messages'>;

interface WebGroundedDeps {
  client: DiscoveryAnthropicClient;
}

function defaultDeps(): WebGroundedDeps {
  return { client: anthropicClient() };
}

/** Public listing URLs returned by the server-side web_search tool. */
function harvestGroundingUrls(content: Anthropic.ContentBlock[]): Set<string> {
  const urls = new Set<string>();
  for (const block of content) {
    if (block.type !== 'web_search_tool_result') continue;
    if (!Array.isArray(block.content)) continue;
    for (const result of block.content) {
      urls.add(result.url);
    }
  }
  return urls;
}

function researchText(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

export class WebGroundedDiscoveryProvider implements DiscoveryProvider {
  readonly name = 'web_grounded';
  private readonly deps: WebGroundedDeps;

  constructor(deps: WebGroundedDeps = defaultDeps()) {
    this.deps = deps;
  }

  async discover(query: DiscoveryQuery): Promise<DiscoveredCandidate[]> {
    const instructions = await loadPrompt('discovery');
    const userMessage = JSON.stringify({
      area_coarse: query.areaCoarse,
      stage: query.stage,
      interests: query.interests,
      limit: query.limit,
    });

    const research = await this.deps.client.messages.create({
      model: SONNET_MODEL,
      max_tokens: 4096,
      system: instructions,
      tools: [{ name: 'web_search', type: 'web_search_20250305', max_uses: MAX_SEARCHES }],
      messages: [{ role: 'user', content: userMessage }],
    });

    const groundingUrls = harvestGroundingUrls(research.content);

    const { value } = await forceToolJson({
      client: this.deps.client,
      model: SONNET_MODEL,
      system: instructions,
      userMessage: JSON.stringify({
        area_coarse: query.areaCoarse,
        stage: query.stage,
        interests: query.interests,
        limit: query.limit,
        research_notes: researchText(research.content),
      }),
      toolName: 'submit_candidates',
      toolDescription: 'Return the structured local activity candidates.',
      inputJsonSchema: extractionJsonSchema,
      schema: extractionSchema,
    });

    return value.candidates.slice(0, query.limit).map((c) => {
      const grounded = c.sourceUrl !== undefined && groundingUrls.has(c.sourceUrl);
      return {
        title: c.title,
        description: c.description,
        stage: query.stage,
        areaCoarse: query.areaCoarse,
        ...(c.sourceUrl !== undefined && { sourceUrl: c.sourceUrl }),
        source: grounded ? 'web_grounded' : 'llm_only',
        confidence: grounded ? c.confidence : Math.min(c.confidence, LLM_ONLY_CONFIDENCE_CAP),
        coverageNote: c.coverageNote,
      };
    });
  }
}
