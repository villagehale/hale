import type Anthropic from '@anthropic-ai/sdk';
import type { z } from 'zod';
import type { AgentClient } from './agent.js';
import type { JsonSchemaNode } from './json-schema.js';
import {
  type LaneConfig,
  type LaneRequestFields,
  laneRequestFields,
  structuredToolChoice,
} from './model.js';

/**
 * Single-shot structured output: ONE output tool whose input is validated against the
 * caller's Zod schema. The one seam every structured call in both processes goes
 * through, because the request shape is now model-specific and two copies of it
 * disagreed (the worker's forced every call, which Sonnet 5.5 and Opus 5.5 reject).
 *
 * Three things make the answer reliable on the 5.5 generation:
 *
 *  - `tool_choice` is forced only where the model accepts it (Haiku 5.5); elsewhere it
 *    is `auto` with at most one call, and a reply that answered in prose is asked again
 *    ONCE, because `auto` does not guarantee a call.
 *  - The tool is sent with `strict: true`, so the API constrains the arguments to the
 *    schema with a grammar. Without it, Haiku 5.5 returned a list field as a JSON
 *    STRING and added keys the schema seals, in 4 of 6 live calls on the kid-relevance
 *    batch (2026-10-11); with it, 6 of 6 parsed. Zod stays the gate for everything the
 *    grammar cannot express (see strictToolSchema).
 *  - Truncation, refusal and a missing call are each a named {@link StructuredOutputError}
 *    rather than a ZodError over an empty object.
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

export type StructuredOutcome = 'truncated' | 'refusal' | 'no_tool_call';

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
 * `output_config`, `strict` nor `disable_parallel_tool_use` with `auto`; all are plain
 * body fields it serialises as given, so the body is widened rather than cast field by
 * field.
 */
export type StructuredRequest = LaneRequestFields & {
  max_tokens: number;
  system: Anthropic.TextBlockParam[];
  tools: (Anthropic.Tool & { strict?: true })[];
  tool_choice: ReturnType<typeof structuredToolChoice>;
  messages: Anthropic.MessageParam[];
};

export function structuredRequest(args: StructuredRequestArgs): StructuredRequest {
  const strict = strictToolSchema(args.inputJsonSchema as JsonSchemaNode);
  const fields = laneRequestFields(args.lane);
  return {
    ...fields,
    max_tokens: args.maxTokens,
    system: cachedSystem(args.system),
    tools: [
      {
        name: args.toolName,
        description: args.toolDescription,
        ...(strict
          ? { input_schema: strict as Anthropic.Tool.InputSchema, strict: true as const }
          : { input_schema: args.inputJsonSchema }),
      },
    ],
    tool_choice: structuredToolChoice(fields.model, args.toolName),
    messages: [{ role: 'user', content: args.userMessage }],
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

/**
 * The tool input of a finished structured call, or the named reason there is none.
 * Shared with the eval harness so a recorded answer passes the same guards.
 */
export function readToolInput(
  response: Anthropic.Message,
  toolName: string,
  maxTokens: number,
): unknown {
  const stopReason = response.stop_reason as string | null;
  // A cut-off call usually arrives as `input: {}`, which would parse to an
  // every-field-Required ZodError indistinguishable from a bad-shape answer.
  if (stopReason === 'max_tokens') {
    throw new StructuredOutputError(
      toolName,
      'truncated',
      stopReason,
      null,
      `${toolName}: tool call truncated at max_tokens (${maxTokens})`,
    );
  }
  if (stopReason === 'refusal') {
    const category = stopDetailsCategory(response);
    throw new StructuredOutputError(
      toolName,
      'refusal',
      stopReason,
      category,
      `${toolName}: the model declined (${category ?? 'no category'})`,
    );
  }
  const toolUse = findToolUse(response, toolName);
  if (!toolUse) {
    throw new StructuredOutputError(
      toolName,
      'no_tool_call',
      stopReason,
      null,
      `${toolName}: model returned no ${toolName} tool call`,
    );
  }
  return toolUse.input;
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

  // `auto` may answer in prose. One identical re-ask, logged so a lane that needs it
  // often shows up; a second miss is the named no_tool_call below.
  if (
    request.tool_choice.type === 'auto' &&
    response.stop_reason !== 'max_tokens' &&
    (response.stop_reason as string) !== 'refusal' &&
    !findToolUse(response, args.toolName)
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

  return {
    value: args.schema.parse(readToolInput(response, args.toolName, args.maxTokens)),
    usage,
  };
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

/** Compiler limits across one request's strict schemas (structured-outputs docs). */
const MAX_OPTIONAL_PARAMS = 24;
const MAX_UNION_PARAMS = 16;

interface ProjectionState {
  optional: number;
  unions: number;
  expressible: boolean;
}

function projectNode(node: JsonSchemaNode, state: ProjectionState): JsonSchemaNode {
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

  if (out.type === 'object') {
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
