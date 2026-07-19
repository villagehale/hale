import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
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
  /**
   * Native content blocks (images/PDFs) to ride on the FIRST user turn alongside the
   * serialized context — the caller has already fetched the bytes and byte-sniffed
   * the mime. Present only for the turn that carries a fresh attachment; past-turn
   * attachments are replayed as plain-text markers inside the context transcript, so
   * bytes are never re-sent. Omitted/empty → the first turn is the context string alone.
   */
  attachments?: Anthropic.ContentBlockParam[];
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
 * A tool call, as surfaced to the streaming caller BEFORE the guarded invoker runs.
 * Rule #1: the NAME is the only field — never the arguments. Tool arguments can
 * carry a childId or free-text that quotes teen content, so they never leave the
 * loop. The name alone is enough to render "Ran X" in the activity trail.
 */
export interface ToolCallEvent {
  name: string;
}

/**
 * A whitelisted display card a tool may attach to its result for the CLIENT. It is
 * the ONE exception to the "name+ok+preview only" firewall — and it is a closed,
 * additive union carrying ONLY fields the tool explicitly declared safe to show
 * (rule #1). Raw tool output still never rides this channel: a tool opts in by
 * returning a `card` shaped exactly like one of these variants (the connector read
 * tools do), and the union has no field a raw payload / token could flow into.
 *
 * - `drive`: Google Drive file rows — name/type/modified/open-link, NEVER content.
 * - `calendar`: agenda rows — title/start/end (+location), NEVER attendees/notes.
 * - `not_connected`: the honest empty state — the connector isn't linked.
 */
export type ToolCard =
  | {
      kind: 'drive';
      files: Array<{
        name: string;
        mimeType: string;
        modifiedTime: string;
        webViewLink: string;
      }>;
    }
  | {
      kind: 'calendar';
      events: Array<{ title: string; start: string; end: string; location?: string }>;
    }
  | { kind: 'not_connected'; provider: 'gdrive' | 'gcal' };

/**
 * The firewall itself: a STRICT, per-variant schema for {@link ToolCard}. Every
 * object level strips unknown keys (Zod's default `.strip()`), so a field a tool
 * never declared — a raw file body, a `smuggled` sibling, a token nested inside a
 * file row — cannot ride the card to the client, no matter what a (future) tool
 * returns under `card` (rule #1). This enforces the union BY CONSTRUCTION at the
 * boundary rather than trusting each tool to map fields strictly.
 */
const toolCardSchema: z.ZodType<ToolCard> = z.union([
  z.object({
    kind: z.literal('drive'),
    files: z.array(
      z.object({
        name: z.string(),
        mimeType: z.string(),
        modifiedTime: z.string(),
        webViewLink: z.string(),
      }),
    ),
  }),
  z.object({
    kind: z.literal('calendar'),
    events: z.array(
      z.object({
        title: z.string(),
        start: z.string(),
        end: z.string(),
        location: z.string().optional(),
      }),
    ),
  }),
  z.object({ kind: z.literal('not_connected'), provider: z.enum(['gdrive', 'gcal']) }),
]);

/**
 * A tool result, as surfaced AFTER the guarded invoker returns (post-cap / post-
 * teen-redaction / post-audit). Rule #1: `ok` (did it succeed) plus a `preview`
 * that is derived from the tool NAME and outcome ONLY — never from the tool's raw
 * output, which can contain a child's profile, memory facts, or teen-quoting
 * episodes. Carrying only name+ok makes a content leak structurally impossible:
 * there is no field the raw result could flow into — EXCEPT the optional `card`, a
 * closed whitelist a tool opts into (see ToolCard), populated only from the fields
 * that tool declared display-safe.
 */
export interface ToolResultEvent {
  name: string;
  ok: boolean;
  /** A safe, content-free label ("Ran X" / "X was blocked") — never raw output. */
  preview: string;
  /** A whitelisted display card, present only when the tool attached one (rule #1). */
  card?: ToolCard;
}

/**
 * The streaming loop's extra hooks. `onTextDelta` is fed each text delta as it
 * arrives. A turn can emit text BEFORE deciding to call a tool, so that text is
 * not the answer — when a turn ends in tool calls the loop fires `onTurnReset`,
 * telling the caller to discard whatever it streamed for that turn. The answer is
 * the text of the final turn, the one that ends WITHOUT tool calls.
 *
 * The step/tool hooks make the guarded tool loop's work observable so the chat can
 * show it live: `onStep` fires once per loop iteration (a model round-trip),
 * `onToolCall` fires per tool_use BEFORE the guarded invoker runs (name only —
 * rule #1), and `onToolResult` fires AFTER it returns (name + ok + a content-free
 * preview — rule #1). All three are optional so a caller that only wants text can
 * omit them.
 */
export interface RunAgentStreamingArgs extends RunAgentArgs {
  onTextDelta: (delta: string) => void;
  /** Fired when a streamed turn turns out to be a tool turn — discard its text. */
  onTurnReset: () => void;
  /** Fired at the top of each loop iteration with the 1-based step number. */
  onStep?: (step: number) => void;
  /** Fired per tool_use BEFORE the guarded invoker — NAME ONLY, never args (rule #1). */
  onToolCall?: (event: ToolCallEvent) => void;
  /** Fired AFTER the guarded invoker — ok + a content-free preview, never raw output (rule #1). */
  onToolResult?: (event: ToolResultEvent) => void;
}

/** The step/tool hooks, split out so `handleToolUses` can take just these. */
type StreamingToolHooks = Pick<RunAgentStreamingArgs, 'onToolCall' | 'onToolResult'>;

/** A content-free result label in Cursor grammar — derived from name+outcome ONLY (rule #1). */
function toolResultPreview(name: string, ok: boolean): string {
  return ok ? `Ran ${name}` : `${name} was blocked`;
}

/**
 * A tool opts into a client display card by returning `{ card: ToolCard, ... }`.
 * The card is PARSED against {@link toolCardSchema} — a strict per-variant schema
 * that strips any field the union doesn't declare, at every depth. An unknown
 * `kind`, a wrong-typed field, or a deep extra key (e.g. a raw file body or a
 * `smuggled` sibling) never reaches the client: a parse failure drops the card
 * entirely, a parse success returns ONLY the whitelisted fields (rule #1). The raw
 * result still goes to the model regardless; this only decides what, if anything,
 * the CLIENT is shown.
 */
function cardFromResult(result: unknown): ToolCard | undefined {
  if (!result || typeof result !== 'object' || !('card' in result)) return undefined;
  const parsed = toolCardSchema.safeParse((result as { card: unknown }).card);
  return parsed.success ? parsed.data : undefined;
}

const DEFAULT_MAX_TOKENS = 2048;

function buildSystemPrompt(skill: Skill, context: unknown): string {
  return `${skill.instructions}\n\n## Context\n\n${JSON.stringify(context)}`;
}

/**
 * The first user turn: the serialized context, plus any native attachment blocks the
 * caller supplied for THIS turn. When attachments are present the content becomes a
 * block array (text context first, then the image/document blocks) so the model
 * receives the real bytes; otherwise it stays the plain context string (byte-identical
 * to the pre-attachment behavior).
 */
function initialUserContent(args: RunAgentArgs): Anthropic.MessageParam['content'] {
  const contextText = JSON.stringify(args.context);
  if (!args.attachments || args.attachments.length === 0) {
    return contextText;
  }
  return [{ type: 'text', text: contextText }, ...args.attachments];
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
  hooks?: StreamingToolHooks,
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
    // Surface the call by NAME only, BEFORE the guarded invoker runs — never the
    // args, which can carry a childId or teen-quoting free text (rule #1).
    hooks?.onToolCall?.({ name: block.name });
    // But a bad tool ARGUMENT (e.g. an out-of-enum value the model invented) or a
    // guardrail rejection must NOT crash the turn — feed the error back so the
    // model self-corrects (retries with valid args) or adapts (answers without
    // the blocked tool). The rails still enforce: a GuardrailError means the
    // handler never ran (rule #1/#7), and only authorized calls were audited.
    try {
      const result = await invokeTool(tool, block.input, args.toolContext, args.guardDeps);
      // POST-guard: the result may contain a child's profile / memory / teen
      // episodes, so ONLY the outcome + a content-free preview leaves the loop —
      // the raw result goes back to the model, never to the client (rule #1). The
      // sole exception is a whitelisted `card` the tool explicitly attached, drawn
      // only from fields it declared display-safe (see cardFromResult / ToolCard).
      const card = cardFromResult(result);
      hooks?.onToolResult?.({
        name: block.name,
        ok: true,
        preview: toolResultPreview(block.name, true),
        ...(card ? { card } : {}),
      });
      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: JSON.stringify(result),
      });
    } catch (err) {
      hooks?.onToolResult?.({
        name: block.name,
        ok: false,
        preview: toolResultPreview(block.name, false),
      });
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
    { role: 'user', content: initialUserContent(args) },
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
    { role: 'user', content: initialUserContent(args) },
  ];

  let promptTokens = 0;
  let completionTokens = 0;
  let steps = 0;

  while (steps < args.maxSteps) {
    steps += 1;
    args.onStep?.(steps);
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
    await handleToolUses(args, toolByName, messages, response.content, toolUses, {
      onToolCall: args.onToolCall,
      onToolResult: args.onToolResult,
    });
  }

  return {
    answer: null,
    steps,
    hitMaxSteps: true,
    usage: { promptTokens, completionTokens },
  };
}
