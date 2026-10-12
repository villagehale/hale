import type Anthropic from '@anthropic-ai/sdk';
import type { z } from 'zod';
import type { AgentClient } from './agent.js';
import type { JsonSchemaNode } from './json-schema.js';
import {
  type Effort,
  type LaneConfig,
  type LaneRequestFields,
  laneRequestFields,
  structuredToolChoice,
  withoutThinking,
} from './model.js';

/**
 * Single-shot structured output, validated against the caller's Zod schema. The one
 * seam every structured call in both processes goes through, because the request shape
 * is now model-specific and two copies of it disagreed (the worker's forced every call,
 * which Sonnet 5.5 and Opus 5.5 reject with a 400).
 *
 * The answer is asked for as a JSON OUTPUT (`output_config.format`), not a tool call,
 * whenever the schema can be compiled to a grammar (see strictToolSchema) — the shape
 * the API documents for "the forced call only existed to get JSON back", and the same
 * on all three 5.5 tiers. Measured live 2026-10-11:
 *
 *  - a non-strict forced tool on Haiku 5.5 returned a list field as a JSON STRING, or
 *    added keys the schema seals, in 4 of 6 calls on the kid-relevance batch;
 *  - an `auto` tool on Sonnet 5.5 (the only tool_choice it accepts) answered the
 *    intro-voice ask in prose and never called the tool;
 *  - a JSON output parsed 6 of 6 on Haiku 5.5 and 3 of 3 on Sonnet 5.5.
 *
 * A schema the grammar cannot express (an object open to any key) goes out as a plain
 * tool: forced where the model accepts it (Haiku 5.5), otherwise `auto` with one call
 * and ONE identical re-ask when the reply came back in prose — the same one re-ask a JSON
 * output gets when it comes back with no text. Truncation, refusal, a
 * missing answer and unparseable JSON are each a named {@link StructuredOutputError};
 * Zod stays the gate for every bound the grammar does not carry.
 *
 * The client is injected so tests drive the mechanics with a fake; answer QUALITY is
 * the cached eval against real Claude (rule #8).
 */
export interface StructuredRequestArgs {
  /**
   * The LANE, not a bare model id: effort and thinking mode belong to it, and the
   * thinking-off shape differs per tier (see LaneConfig).
   */
  lane: LaneConfig;
  system: string;
  userMessage: string;
  toolName: string;
  toolDescription: string;
  inputJsonSchema: Anthropic.Tool.InputSchema;
  maxTokens: number;
}

export interface ForceToolJsonArgs<TSchema extends z.ZodTypeAny> extends StructuredRequestArgs {
  client: AgentClient;
  schema: TSchema;
  /**
   * How the request is carried. `create` (the default) suits a turn that answers in
   * seconds. `stream` is for a long-thinking lane over a large prompt: the SDK clears
   * its abort timer when the response HEADERS arrive, and a non-streamed request gets
   * headers only once the whole body is generated, so a two-minute turn dies on a
   * timeout sized for a ten-second one.
   */
  transport?: 'create' | 'stream';
}

export interface ForceToolJsonResult<TValue> {
  value: TValue;
  /** Summed over the re-ask when there was one: both calls are billed. */
  usage: Anthropic.Usage;
}

export type StructuredOutcome = 'truncated' | 'refusal' | 'no_answer' | 'unparseable';

/** A structured call that produced no answer to parse, named by why. */
export class StructuredOutputError extends Error {
  constructor(
    readonly stage: string,
    readonly outcome: StructuredOutcome,
    readonly stopReason: string | null,
    readonly category: string | null,
    message: string,
  ) {
    super(message);
    this.name = 'StructuredOutputError';
  }
}

/**
 * The stable system prompt behind one ephemeral cache breakpoint. Wire order is
 * tools → system → messages, so the breakpoint caches the tool definitions and the
 * instructions together; the per-turn payload goes in the user message, after it.
 */
export function cachedSystem(instructions: string): Anthropic.TextBlockParam[] {
  return [{ type: 'text', text: instructions, cache_control: { type: 'ephemeral' } }];
}

/**
 * The request body. The pinned SDK (0.41.0) types neither the current `thinking` shapes,
 * `output_config` nor `disable_parallel_tool_use` with `auto`; all are plain body fields
 * it serialises as given, so the body is widened rather than cast field by field.
 */
export type StructuredRequest = Omit<LaneRequestFields, 'output_config'> & {
  max_tokens: number;
  system: Anthropic.TextBlockParam[];
  output_config?: {
    effort?: Effort;
    format?: { type: 'json_schema'; schema: JsonSchemaNode };
  };
  tools?: Anthropic.Tool[];
  tool_choice?: ReturnType<typeof structuredToolChoice>;
  messages: Anthropic.MessageParam[];
};

export function structuredRequest(args: StructuredRequestArgs): StructuredRequest {
  const grammar = strictToolSchema(args.inputJsonSchema as JsonSchemaNode);
  const { output_config, ...fields } = laneRequestFields(args.lane);
  const common = {
    ...fields,
    max_tokens: args.maxTokens,
    system: cachedSystem(args.system),
    messages: [{ role: 'user' as const, content: args.userMessage }],
  };
  if (grammar) {
    return {
      ...common,
      output_config: { ...output_config, format: { type: 'json_schema', schema: grammar } },
    };
  }
  return {
    ...common,
    ...(output_config ? { output_config } : {}),
    tools: [
      {
        name: args.toolName,
        description: args.toolDescription,
        input_schema: args.inputJsonSchema,
      },
    ],
    tool_choice: structuredToolChoice(fields.model, args.toolName),
  };
}

type Send = (request: StructuredRequest) => Promise<Anthropic.Message>;

function sender(client: AgentClient, transport: 'create' | 'stream' | undefined): Send {
  // The widened body is the wire request; see StructuredRequest.
  const wire = (request: StructuredRequest) =>
    request as unknown as Anthropic.MessageCreateParamsNonStreaming;
  return transport === 'stream'
    ? (request) => client.messages.stream(wire(request)).finalMessage()
    : (request) => client.messages.create(wire(request));
}

function findToolUse(response: Anthropic.Message, toolName: string) {
  return response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === toolName,
  );
}

function stopDetailsCategory(response: Anthropic.Message): string | null {
  const details = (response as { stop_details?: { category?: unknown } }).stop_details;
  return typeof details?.category === 'string' ? details.category : null;
}

function fail(
  stage: string,
  outcome: StructuredOutcome,
  response: Anthropic.Message,
  detail: string,
  category: string | null = null,
): never {
  throw new StructuredOutputError(
    stage,
    outcome,
    response.stop_reason as string | null,
    category,
    `${stage}: ${detail}`,
  );
}

/**
 * The answer of a finished structured call — the JSON output, or the tool input when the
 * request went out as a tool — or the named reason there is none. Shared with the eval
 * harness so a recorded answer passes the same guards.
 */
export function readStructuredAnswer(
  request: StructuredRequest,
  response: Anthropic.Message,
  stage: string,
): unknown {
  const stopReason = response.stop_reason as string | null;
  // A cut-off answer is never an answer: a truncated tool call usually arrives as
  // `input: {}`, which would parse to an every-field-Required ZodError indistinguishable
  // from a bad-shape answer, and truncated JSON is half an object.
  if (stopReason === 'max_tokens') {
    fail(
      stage,
      'truncated',
      response,
      `tool call truncated at max_tokens (${request.max_tokens}); ${response.usage.output_tokens} output tokens over [${response.content.map((block) => block.type).join(', ')}]`,
    );
  }
  if (stopReason === 'refusal') {
    const category = stopDetailsCategory(response);
    fail(stage, 'refusal', response, `the model declined (${category ?? 'no category'})`, category);
  }
  if (request.tools) {
    const toolUse = findToolUse(response, stage);
    if (!toolUse) fail(stage, 'no_answer', response, `model returned no ${stage} tool call`);
    return toolUse.input;
  }
  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim();
  if (text === '') fail(stage, 'no_answer', response, 'model returned no JSON output');
  try {
    return JSON.parse(text);
  } catch {
    return fail(stage, 'unparseable', response, 'the JSON output did not parse');
  }
}

function sumUsage(a: Anthropic.Usage, b: Anthropic.Usage): Anthropic.Usage {
  const add = (x: number | null | undefined, y: number | null | undefined) =>
    x == null && y == null ? null : (x ?? 0) + (y ?? 0);
  return {
    ...b,
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cache_creation_input_tokens: add(a.cache_creation_input_tokens, b.cache_creation_input_tokens),
    cache_read_input_tokens: add(a.cache_read_input_tokens, b.cache_read_input_tokens),
  };
}

export async function forceToolJson<TSchema extends z.ZodTypeAny>(
  args: ForceToolJsonArgs<TSchema>,
): Promise<ForceToolJsonResult<z.infer<TSchema>>> {
  const request = structuredRequest(args);
  const send = sender(args.client, args.transport);
  let response = await send(request);
  let usage = response.usage;

  // No answer came back: an `auto` tool answered in prose, or a JSON output with no text.
  // One identical re-ask, logged so a lane that needs it often shows up; a second miss is
  // the named no_answer below. A forced tool is not re-asked: the model chose not to call it.
  if (
    response.stop_reason !== 'max_tokens' &&
    (response.stop_reason as string) !== 'refusal' &&
    cameBackEmpty(request, response, args.toolName)
  ) {
    console.warn(
      JSON.stringify({
        event: 'structured_reask',
        stage: args.toolName,
        model: request.model,
        stopReason: response.stop_reason,
      }),
    );
    response = await send(request);
    usage = sumUsage(usage, response.usage);
  }

  // THE TURN THAT SPENT ITS WHOLE BUDGET THINKING, ASKED AGAIN WITH THINKING OFF, AT THE
  // SAME BUDGET — runAgent's rule (agent.ts), for the same reason: `max_tokens` caps
  // thinking plus answer, the 5.5 tiers have no field that bounds the thinking half, and
  // Sonnet 5.5 at `high` thinks longer than Sonnet 5 did, so small-budget structured
  // stages that never truncated started to (the activity follow-up note, 400 tokens, all
  // of them thinking; the medical answer, 1,024, mostly thinking). The room belongs to the
  // turn that proved it needed it, so the lane keeps its budget. A turn that spent none of
  // it thinking is not re-asked: the same answer would be cut again.
  const lessThinking = withoutThinking(args.lane);
  if (lessThinking && spentBudgetThinking(response)) {
    console.warn(
      JSON.stringify({
        event: 'structured_reask_thinking_off',
        stage: args.toolName,
        model: request.model,
      }),
    );
    const retry = structuredRequest({ ...args, lane: lessThinking });
    response = await send(retry);
    usage = sumUsage(usage, response.usage);
    return {
      value: args.schema.parse(readStructuredAnswer(retry, response, args.toolName)),
      usage,
    };
  }

  return {
    value: args.schema.parse(readStructuredAnswer(request, response, args.toolName)),
    usage,
  };
}

function cameBackEmpty(
  request: StructuredRequest,
  response: Anthropic.Message,
  toolName: string,
): boolean {
  if (request.tools) {
    return request.tool_choice?.type === 'auto' && !findToolUse(response, toolName);
  }
  return !response.content.some((block) => block.type === 'text' && block.text.trim() !== '');
}

/** Cut off at the ceiling after spending part of it thinking. */
function spentBudgetThinking(response: Anthropic.Message): boolean {
  return (
    response.stop_reason === 'max_tokens' &&
    response.content.some(
      (block) => block.type === 'thinking' || block.type === 'redacted_thinking',
    )
  );
}

// --- the strict wire subset -------------------------------------------------

/** Keywords the grammar compiler rejects; restated in the description, enforced by Zod. */
const STRIPPED_KEYWORDS = [
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'maxItems',
  'uniqueItems',
  'minProperties',
  'maxProperties',
  'pattern',
] as const;

/** Keywords with no grammar under strict: a schema using one goes out as a plain tool. */
const UNSUPPORTED_KEYWORDS = [
  'oneOf',
  'not',
  'if',
  'then',
  'else',
  'patternProperties',
  'dependentSchemas',
  'prefixItems',
] as const;

/** Keywords that give a node a concrete shape; a node with none of them accepts anything. */
const SHAPE_KEYWORDS = ['type', 'enum', 'const', 'anyOf', 'allOf', '$ref'] as const;

/** Compiler limits across one request's strict schemas (structured-outputs docs). */
const MAX_OPTIONAL_PARAMS = 24;
const MAX_UNION_PARAMS = 16;

interface ProjectionState {
  optional: number;
  unions: number;
  expressible: boolean;
}

function projectNode(node: JsonSchemaNode, state: ProjectionState): JsonSchemaNode {
  if (
    UNSUPPORTED_KEYWORDS.some((key) => key in node) ||
    !SHAPE_KEYWORDS.some((key) => key in node)
  ) {
    state.expressible = false;
  }
  const out: JsonSchemaNode = {};
  const notes: string[] = [];
  for (const [key, value] of Object.entries(node)) {
    if ((STRIPPED_KEYWORDS as readonly string[]).includes(key)) {
      notes.push(`${key}: ${JSON.stringify(value)}`);
    } else if (key === 'minItems' && typeof value === 'number' && value > 1) {
      notes.push(`minItems: ${value}`);
    } else {
      out[key] = value;
    }
  }

  // `type: [T, 'null']` beside an enum that holds null is rejected by the compiler.
  if (Array.isArray(out.type) && Array.isArray(out.enum)) {
    const types = (out.type as unknown[]).filter((t) => t !== 'null');
    const values = (out.enum as unknown[]).filter((v) => v !== null);
    if (types.length === 1 && values.length < (out.enum as unknown[]).length) {
      const { type: _type, enum: _enum, ...rest } = out;
      for (const key of Object.keys(out)) delete out[key];
      Object.assign(out, rest, {
        anyOf: [{ type: types[0], enum: values }, { type: 'null' }],
      });
    }
  }
  if (Array.isArray(out.type) || Array.isArray(out.anyOf)) state.unions += 1;

  if (out.type === 'object' || (Array.isArray(out.type) && out.type.includes('object'))) {
    // An object with no properties, or one opened to any key, has no grammar; sealing
    // it would silently turn "anything" into "nothing".
    if (
      out.properties === undefined ||
      (out.additionalProperties !== undefined && out.additionalProperties !== false)
    ) {
      state.expressible = false;
    }
    const properties = (out.properties ?? {}) as Record<string, JsonSchemaNode>;
    const required = new Set((out.required ?? []) as string[]);
    state.optional += Object.keys(properties).filter((name) => !required.has(name)).length;
    out.properties = Object.fromEntries(
      Object.entries(properties).map(([name, child]) => [name, projectNode(child, state)]),
    );
    out.additionalProperties = false;
  }
  if (out.items && typeof out.items === 'object') {
    out.items = projectNode(out.items as JsonSchemaNode, state);
  }
  for (const key of ['anyOf', 'allOf'] as const) {
    if (Array.isArray(out[key])) {
      out[key] = (out[key] as JsonSchemaNode[]).map((child) => projectNode(child, state));
    }
  }
  if (out.$defs && typeof out.$defs === 'object') {
    out.$defs = Object.fromEntries(
      Object.entries(out.$defs as Record<string, JsonSchemaNode>).map(([name, child]) => [
        name,
        projectNode(child, state),
      ]),
    );
  }

  if (notes.length > 0) {
    const restated = `(${notes.join(', ')})`;
    out.description =
      typeof out.description === 'string' ? `${out.description} ${restated}` : restated;
  }
  return out;
}

/**
 * The tool schema as the grammar compiler accepts it under `strict: true`, or null when
 * it cannot be expressed — an object left open to arbitrary keys, or more optional or
 * union parameters than the compiler allows — in which case the tool goes out without
 * `strict`, because the alternative is a 400.
 *
 * Unsupported bounds (`maxLength`, `minimum`, …) are restated in the description, which
 * the model reads, while the caller's Zod schema keeps enforcing them on the answer —
 * the same split as compileToolSchema. Key ORDER is preserved, so `reason` before
 * `verdict` still holds; the compiler does put required properties before optional
 * ones, so a reason that must come first must be required.
 */
export function strictToolSchema(schema: JsonSchemaNode): JsonSchemaNode | null {
  const state: ProjectionState = { optional: 0, unions: 0, expressible: true };
  const projected = projectNode(structuredClone(schema), state);
  if (
    !state.expressible ||
    state.optional > MAX_OPTIONAL_PARAMS ||
    state.unions > MAX_UNION_PARAMS
  ) {
    return null;
  }
  return projected;
}
