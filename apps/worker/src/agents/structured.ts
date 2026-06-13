import type Anthropic from '@anthropic-ai/sdk';
import type { z } from 'zod';

/**
 * Single-shot structured output via tool-forced JSON.
 *
 * The pinned @anthropic-ai/sdk (0.41.0) has no `messages.parse` /
 * `output_config` helper, but it does support forcing a specific tool. We
 * define one output tool, force it with `tool_choice`, then validate the
 * returned `tool_use.input` against the caller's Zod schema — so the
 * structured-output guarantee Mastra gave us is preserved, while the raw
 * tool_use block stays visible (the reason for ratified reversal R5).
 */
interface ForceToolJsonArgs<TSchema extends z.ZodTypeAny> {
  client: Pick<Anthropic, 'messages'>;
  model: string;
  system: string;
  userMessage: string;
  toolName: string;
  toolDescription: string;
  inputJsonSchema: Anthropic.Tool.InputSchema;
  schema: TSchema;
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
    max_tokens: 4096,
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
