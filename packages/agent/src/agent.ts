import type Anthropic from '@anthropic-ai/sdk';
import { pickModel } from './model.js';
import type { Skill } from './skill.js';
import {
  type GuardDeps,
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

    messages.push({ role: 'assistant', content: response.content });

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of toolUses) {
      const tool = toolByName.get(block.name);
      if (!tool) {
        throw new Error(`runAgent: model called unknown tool '${block.name}'`);
      }
      if (!args.skill.meta.tools.includes(block.name)) {
        throw new Error(
          `runAgent: model called tool '${block.name}' not in skill '${args.skill.meta.name}' allowlist`,
        );
      }
      const result = await invokeTool(tool, block.input, args.toolContext, args.guardDeps);
      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: JSON.stringify(result),
      });
    }
    messages.push({ role: 'user', content: toolResults });
  }

  return {
    answer: null,
    steps,
    hitMaxSteps: true,
    usage: { promptTokens, completionTokens },
  };
}
