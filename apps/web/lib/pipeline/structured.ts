import type Anthropic from '@anthropic-ai/sdk';
import type { AgentClient } from '@hale/agent';
import type { z } from 'zod';

/**
 * Single-shot structured output via tool-forced JSON — the web-side mirror of the
 * worker's agents/structured.ts (we do not import worker src). The pinned SDK
 * (0.41.0) has no `messages.parse`; instead we define ONE output tool, force it
 * with `tool_choice`, then validate the returned `tool_use.input` against the
 * caller's Zod schema. The classify/draft stages are single LLM turns (no tool
 * loop), so this is the right shape for them; the reviewer (which DOES loop over
 * verification tools) uses its own hand-rolled loop in review.ts.
 *
 * The client is injected (AgentClient = the messages slice) so tests drive the
 * mechanics with a fake; agent QUALITY is an eval against real cached Claude
 * (rule #8), never asserted against a mocked model.
 */
interface ForceToolJsonArgs<TSchema extends z.ZodTypeAny> {
  client: AgentClient;
  model: string;
  system: string;
  userMessage: string;
  toolName: string;
  toolDescription: string;
  inputJsonSchema: Anthropic.Tool.InputSchema;
  schema: TSchema;
  maxTokens: number;
}

export interface ForceToolJsonResult<TValue> {
  value: TValue;
  usage: Anthropic.Usage;
}

export async function forceToolJson<TSchema extends z.ZodTypeAny>(
  args: ForceToolJsonArgs<TSchema>,
): Promise<ForceToolJsonResult<z.infer<TSchema>>> {
  const response = await args.client.messages.create({
    model: args.model,
    max_tokens: args.maxTokens,
    system: args.system,
    tools: [
      {
        name: args.toolName,
        description: args.toolDescription,
        input_schema: args.inputJsonSchema,
      },
    ],
    tool_choice: { type: 'tool', name: args.toolName },
    messages: [{ role: 'user', content: args.userMessage }],
  });

  const toolUse = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === args.toolName,
  );
  if (!toolUse) {
    throw new Error(`${args.toolName}: model returned no ${args.toolName} tool call`);
  }

  return { value: args.schema.parse(toolUse.input), usage: response.usage };
}
