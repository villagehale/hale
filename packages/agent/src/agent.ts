import type Anthropic from '@anthropic-ai/sdk';
import { pickModel } from './model.js';
import type { Skill } from './skill.js';
import {
  type GuardDeps,
  GuardrailError,
  type ToolDefinition,
  type ToolHandlerContext,
  invokeTool,
} from './tool.js';

/**
 * The agent loop.
 *
 * Mirrors the worker Reviewer's messages ↔ Anthropic ↔ tool-call ↔ tool-result
 * loop, generalized: the system prompt comes from a SKILL's instructions (loaded
 * from disk, never inline — rule #2), the model is chosen by pickModel(skill.task)
 * (single source of model ids), and every tool call is dispatched through the
 * GUARDED invoker so the safety rails (cap / audit / teen-redaction) run no matter
 * what the model decides to call. maxSteps is a hard stop — the loop cannot run
 * forever.
 *
 * The Anthropic client is INJECTED. Tests pass a fake to exercise the loop
 * MECHANICS (a tool call fed back, the maxSteps stop). The fake is for plumbing
 * only — agent QUALITY is evaluated against real cached Claude responses (rule
 * #8), not asserted against a mocked model.
 */

/** Just the slice of the SDK the loop uses, so a fake only needs `messages.create`. */
export type AgentClient = Pick<Anthropic, 'messages'>;

/** A tool the loop may call, paired with the guard metadata invokeTool needs. */
// biome-ignore lint/suspicious/noExplicitAny: the registry is heterogeneous — each tool has its own input/output types.
export type RegisteredTool = ToolDefinition<any, any>;

export interface RunAgentArgs {
  skill: Skill;
  /** Injected, skill-scoped context serialized into the first user message. */
  context: unknown;
  /** Tools the loop may dispatch. The skill's `tools` allowlist must be a subset of these names. */
  tools: RegisteredTool[];
  client: AgentClient;
  /** Hard cap on Anthropic round-trips. The loop returns hitMaxSteps:true if reached. */
  maxSteps: number;
  /** Family scope + acting actor, threaded into every guarded tool invocation. */
  toolContext: ToolHandlerContext;
  /** The injected safety hooks (cap / audit / teen-redaction) invokeTool enforces. */
  guardDeps: GuardDeps;
  /** Per-call token budget for messages.create. */
  maxTokens?: number;
}

export interface AgentUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface RunAgentResult {
  /** The model's final natural-language answer, or null if it stopped without text. */
  answer: string | null;
  /** Number of Anthropic round-trips actually taken. */
  steps: number;
  /** True iff the loop stopped because it hit maxSteps rather than finishing. */
  hitMaxSteps: boolean;
  usage: AgentUsage;
}

/**
 * The streaming loop's extra hooks. `onTextDelta` is fed each text delta as it
 * arrives. A turn can emit text BEFORE deciding to call a tool, so that text is
 * not the answer — when a turn ends in tool calls the loop fires `onTurnReset`,
 * telling the caller to discard whatever it streamed for that turn. The answer is
 * the text of the final turn, the one that ends WITHOUT tool calls.
 */
export interface RunAgentStreamingArgs extends RunAgentArgs {
  onTextDelta: (delta: string) => void;
  /** Fired when a streamed turn turns out to be a tool turn — discard its text. */
  onTurnReset: () => void;
}

const DEFAULT_MAX_TOKENS = 2048;

function buildSystemPrompt(skill: Skill, context: unknown): string {
  return `${skill.instructions}\n\n## Context\n\n${JSON.stringify(context)}`;
}

function toAnthropicTools(skill: Skill, tools: RegisteredTool[]): Anthropic.Tool[] {
  const byName = new Map(tools.map((t) => [t.name, t]));
  return skill.meta.tools.map((name) => {
    const tool = byName.get(name);
    if (!tool) {
      throw new Error(
        `runAgent: skill '${skill.meta.name}' lists tool '${name}' not present in the provided tools`,
      );
    }
    return {
      name: tool.name,
      description: tool.description,
      input_schema: { type: 'object', additionalProperties: true },
    };
  });
}

function textFrom(content: Anthropic.ContentBlock[]): string | null {
  const parts = content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text);
  return parts.length > 0 ? parts.join('\n') : null;
}

/** A tool failure fed back to the model so it self-corrects instead of crashing the turn. */
function toolErrorMessage(err: unknown): string {
  if (err instanceof GuardrailError) {
    return `This action was refused by a safety policy (${err.rail}). Do not retry it — continue without it.`;
  }
  return `Tool call failed: ${err instanceof Error ? err.message : String(err)}. Correct the arguments and try again, or proceed without this tool.`;
}

/**
 * Dispatch one assistant turn's tool calls through the GUARDED invoker and append
 * the assistant turn + its tool_results to `messages`. Shared by the non-streaming
 * and streaming loops so the safety rails, allowlist checks, and self-correction
 * feedback behave identically no matter the transport.
 */
async function handleToolUses(
  args: RunAgentArgs,
  toolByName: Map<string, RegisteredTool>,
  messages: Anthropic.MessageParam[],
  content: Anthropic.ContentBlock[],
  toolUses: Anthropic.ToolUseBlock[],
): Promise<void> {
  messages.push({ role: 'assistant', content });

  const toolResults: Anthropic.ToolResultBlockParam[] = [];
  for (const block of toolUses) {
    // Unknown / not-allowlisted tool = a skill-config bug that can't happen in
    // correct operation (the model is only offered allowlisted tools) — fail loud.
    const tool = toolByName.get(block.name);
    if (!tool) {
      throw new Error(`runAgent: model called unknown tool '${block.name}'`);
    }
    if (!args.skill.meta.tools.includes(block.name)) {
      throw new Error(
        `runAgent: model called tool '${block.name}' not in skill '${args.skill.meta.name}' allowlist`,
      );
    }
    // But a bad tool ARGUMENT (e.g. an out-of-enum value the model invented) or a
    // guardrail rejection must NOT crash the turn — feed the error back so the
    // model self-corrects (retries with valid args) or adapts (answers without
    // the blocked tool). The rails still enforce: a GuardrailError means the
    // handler never ran (rule #1/#7), and only authorized calls were audited.
    try {
      const result = await invokeTool(tool, block.input, args.toolContext, args.guardDeps);
      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: JSON.stringify(result),
      });
    } catch (err) {
      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        is_error: true,
        content: toolErrorMessage(err),
      });
    }
  }
  messages.push({ role: 'user', content: toolResults });
}

export async function runAgent(args: RunAgentArgs): Promise<RunAgentResult> {
  const model = pickModel(args.skill.meta.task);
  const system = buildSystemPrompt(args.skill, args.context);
  const tools = toAnthropicTools(args.skill, args.tools);
  const toolByName = new Map(args.tools.map((t) => [t.name, t]));

  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: JSON.stringify(args.context) },
  ];

  let promptTokens = 0;
  let completionTokens = 0;
  let steps = 0;

  while (steps < args.maxSteps) {
    steps += 1;
    const response = await args.client.messages.create({
      model,
      max_tokens: args.maxTokens ?? DEFAULT_MAX_TOKENS,
      system,
      ...(tools.length > 0 && { tools }),
      messages,
    });
    promptTokens += response.usage.input_tokens + (response.usage.cache_creation_input_tokens ?? 0);
    completionTokens += response.usage.output_tokens;

    const toolUses = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
    );

    if (toolUses.length === 0) {
      return {
        answer: textFrom(response.content),
        steps,
        hitMaxSteps: false,
        usage: { promptTokens, completionTokens },
      };
    }

    await handleToolUses(args, toolByName, messages, response.content, toolUses);
  }

  return {
    answer: null,
    steps,
    hitMaxSteps: true,
    usage: { promptTokens, completionTokens },
  };
}

/**
 * Identical to {@link runAgent} — same model, system prompt, tools, guarded
 * invoker, maxSteps, and usage accounting — but each turn is STREAMED. Text
 * deltas are forwarded through `onTextDelta` as they arrive; once a turn produces
 * no tool calls its accumulated text is the answer and the loop ends. The
 * client's per-turn handling reads the SDK's `finalMessage()`, so the post-turn
 * logic is the same shape as the non-streaming `messages.create` response.
 */
export async function runAgentStreaming(args: RunAgentStreamingArgs): Promise<RunAgentResult> {
  const model = pickModel(args.skill.meta.task);
  const system = buildSystemPrompt(args.skill, args.context);
  const tools = toAnthropicTools(args.skill, args.tools);
  const toolByName = new Map(args.tools.map((t) => [t.name, t]));

  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: JSON.stringify(args.context) },
  ];

  let promptTokens = 0;
  let completionTokens = 0;
  let steps = 0;

  while (steps < args.maxSteps) {
    steps += 1;
    const stream = args.client.messages.stream({
      model,
      max_tokens: args.maxTokens ?? DEFAULT_MAX_TOKENS,
      system,
      ...(tools.length > 0 && { tools }),
      messages,
    });

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        args.onTextDelta(event.delta.text);
      }
    }

    const response = await stream.finalMessage();
    promptTokens += response.usage.input_tokens + (response.usage.cache_creation_input_tokens ?? 0);
    completionTokens += response.usage.output_tokens;

    const toolUses = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
    );

    if (toolUses.length === 0) {
      return {
        answer: textFrom(response.content),
        steps,
        hitMaxSteps: false,
        usage: { promptTokens, completionTokens },
      };
    }

    // This turn called tools, so any text it streamed was reasoning, not the
    // answer — tell the caller to drop it before the next turn streams.
    args.onTurnReset();
    await handleToolUses(args, toolByName, messages, response.content, toolUses);
  }

  return {
    answer: null,
    steps,
    hitMaxSteps: true,
    usage: { promptTokens, completionTokens },
  };
}
