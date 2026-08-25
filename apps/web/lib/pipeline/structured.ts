import type Anthropic from '@anthropic-ai/sdk';
import { type AgentClient, type LaneConfig, laneRequestFields } from '@hale/agent';
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
  /**
   * The LANE, not a bare model id. Effort and thinking mode belong to the lane
   * and are rendered into the prompt by the API, so a caller that could pass a
   * model without them would silently run at the API default (`high`, thinking
   * on) — the tax this re-tier exists to remove. Taking the whole lane makes the
   * knobs impossible to leave behind.
   */
  lane: LaneConfig;
  system: string;
  userMessage: string;
  toolName: string;
  toolDescription: string;
  inputJsonSchema: Anthropic.Tool.InputSchema;
  schema: TSchema;
  maxTokens: number;
  /**
   * How the request is carried. `create` (the default) is every existing caller and is
   * right for a turn that answers in seconds.
   *
   * `stream` exists for the one shape `create` cannot carry: a long-thinking lane over a
   * large prompt. The SDK clears its abort timer when the response HEADERS arrive, and a
   * non-streamed request produces headers only once the whole body is generated — so a
   * turn that thinks for two minutes is killed by a client timeout sized for a turn that
   * answers in ten seconds, and the deep lane's research leg already proved it (deep.ts:
   * `messages.create` died at 120s where the same request streamed returned in 88.8s).
   * The stream reaches headers in about a second, so the timeout bounds a stall rather
   * than the answer. Everything after the transport — the truncation guard, the tool
   * lookup, the zod parse — is one reader for both.
   */
  transport?: 'create' | 'stream';
}

export interface ForceToolJsonResult<TValue> {
  value: TValue;
  usage: Anthropic.Usage;
}

export async function forceToolJson<TSchema extends z.ZodTypeAny>(
  args: ForceToolJsonArgs<TSchema>,
): Promise<ForceToolJsonResult<z.infer<TSchema>>> {
  const params = {
    // The pinned SDK (0.41.0) types neither `thinking`'s adaptive shape nor
    // `output_config`; both are plain body fields the SDK serialises as given.
    // Narrowing to the one field it does know keeps the rest type-checked.
    ...(laneRequestFields(args.lane) as Pick<Anthropic.MessageCreateParams, 'model'>),
    max_tokens: args.maxTokens,
    system: args.system,
    tools: [
      {
        name: args.toolName,
        description: args.toolDescription,
        input_schema: args.inputJsonSchema,
      },
    ],
    tool_choice: { type: 'tool' as const, name: args.toolName },
    messages: [{ role: 'user' as const, content: args.userMessage }],
  };
  const response =
    args.transport === 'stream'
      ? await args.client.messages.stream(params).finalMessage()
      : await args.client.messages.create(params);

  // A response cut off at max_tokens leaves the forced tool call incomplete —
  // often `input: {}` — and parsing that empty object reports every required field
  // as missing, a ZodError indistinguishable from a genuine bad-shape answer.
  // Surface truncation as itself so a caller (and the founder-facing sweep) sees
  // the real cause instead of a false "the model returned nothing valid".
  if (response.stop_reason === 'max_tokens') {
    throw new Error(`${args.toolName}: tool call truncated at max_tokens (${args.maxTokens})`);
  }

  const toolUse = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === args.toolName,
  );
  if (!toolUse) {
    throw new Error(`${args.toolName}: model returned no ${args.toolName} tool call`);
  }

  return { value: args.schema.parse(toolUse.input), usage: response.usage };
}
