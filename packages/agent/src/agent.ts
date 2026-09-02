import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { compileToolSchema } from './json-schema.js';
import { type AgentTask, laneRequestFields, pickLane } from './model.js';
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
  /**
   * Ship `strict: true` with every tool whose schema compiles to a grammar. Default TRUE
   * — the saving it buys (#415) is real and every caller but one wants it.
   *
   * The one that does not is a phone call, and the reason is that `strict` is not free at
   * REQUEST time. The API compiles a sampling grammar before it emits a token; the
   * compile is keyed on schema STRUCTURE, cached per credential, and it expires. A cold
   * compile of the six coach schemas measured 16-83 seconds, all of it BEFORE response
   * headers — which is exactly the window the SDK's `timeout` guards, streaming or not.
   * SMS survives that because a timed-out turn defers into the queue's backoff and the
   * retry lands warm; a call has no queue, so the caller hears dead air and hangs up
   * (voice v2 incident, #505).
   *
   * Declining the grammar costs correctness nothing: the schema still ships in full, and
   * `invokeTool` still `.parse()`s every argument against the same Zod schema before any
   * guard or handler sees it. What is lost is only the guess-and-retry round trip on a
   * malformed call — about a second, against thirty of silence.
   */
  strictTools?: boolean;
}

export interface AgentUsage {
  /** Every token billed at (or above) the full input rate: fresh prompt tokens
   * plus the cache writes below, which are the slice of it that bills at 1.25x. */
  promptTokens: number;
  completionTokens: number;
  /** Tokens served from the prompt cache across the loop — zero means every turn
   * paid full price, which is the signal the cache_control breakpoint is not
   * landing (MEM-9). */
  cacheReadTokens: number;
  /** Tokens written to the prompt cache across the loop. Carried separately from
   * `promptTokens` because they bill at a 1.25x premium (see cost.ts). */
  cacheCreationTokens: number;
}

export interface RunAgentResult {
  /** The model's final natural-language answer, or null if it stopped without text. */
  answer: string | null;
  /** Number of Anthropic round-trips actually taken. */
  steps: number;
  /** True iff the loop stopped because it hit maxSteps rather than finishing. */
  hitMaxSteps: boolean;
  /**
   * How many steps had to be re-asked because the completion was truncated before it
   * emitted any text. Zero on an ordinary turn. Named rather than absorbed into `steps`
   * (rule #11): a turn that bought its answer twice is a different, slower, dearer event
   * than one that did not, and a recovery nobody can see is one nobody can budget for.
   */
  truncatedRetries: number;
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

/**
 * The system prompt: the skill's instructions, behind an ephemeral cache breakpoint.
 *
 * The wire order is tools → system → messages, so a breakpoint on the last system
 * block covers the tool definitions AND the instructions — everything that is
 * byte-identical for every run of a skill, by every family. That prefix used to
 * also carry `JSON.stringify(context)`, which made it per-family and therefore
 * uncacheable; the same context was ALREADY being sent as the first user message
 * (see initialUserContent), so dropping it here removes a duplicate rather than
 * information. Per-run context must stay after the breakpoint — a cached
 * per-family prefix is a guaranteed miss, and it would put one family's routine
 * into a prefix keyed for the whole skill.
 *
 * A prefix shorter than the model's minimum cacheable length simply doesn't cache
 * (no error, `cache_creation_input_tokens: 0`), so the small Haiku-tier skills are
 * unaffected either way.
 */
function buildSystem(skill: Skill): Anthropic.TextBlockParam[] {
  return [
    { type: 'text', text: skill.instructions, cache_control: { type: 'ephemeral' } },
  ];
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

/**
 * The tool definition as the API accepts it. The pinned SDK (0.41.0) types
 * neither `strict` nor `input_examples` — both are plain top-level fields on the
 * wire and need no beta header, so this widens the SDK's `Tool` rather than
 * waiting on a version bump. Same blocker, same shape as the note at
 * apps/worker/src/agents/structured.ts.
 */
type WireTool = Anthropic.Tool & {
  strict?: boolean;
  input_examples?: ReadonlyArray<Record<string, unknown>>;
};

/**
 * Compile the skill's allowlisted tools into wire definitions.
 *
 * This used to send `{type:'object', additionalProperties:true}` for every tool:
 * the model was told a tool existed and told nothing about its arguments, so it
 * guessed argument names, `invokeTool`'s `.parse()` threw, and the loop fed
 * "correct the arguments and try again" back — a wasted round trip on a turn a
 * parent is waiting on. Now each tool ships the schema it already declares, plus
 * `strict: true` wherever a grammar can be compiled from it, so a malformed call
 * is unsamplable rather than merely rejected afterwards.
 *
 * `strictTools` is the run's answer to whether it can afford the grammar COMPILE
 * that buys — see {@link RunAgentArgs.strictTools}.
 */
function toAnthropicTools(
  skill: Skill,
  tools: RegisteredTool[],
  strictTools: boolean,
): Anthropic.Tool[] {
  const byName = new Map(tools.map((t) => [t.name, t]));
  return skill.meta.tools.map((name) => {
    const tool = byName.get(name);
    if (!tool) {
      throw new Error(
        `runAgent: skill '${skill.meta.name}' lists tool '${name}' not present in the provided tools`,
      );
    }
    const { schema, strictSafe } = compileToolSchema(tool.inputSchema);
    const wire: WireTool = {
      name: tool.name,
      description: tool.description,
      input_schema: schema as Anthropic.Tool.InputSchema,
      // Withheld — never defaulted on — when the run declined the compile, or when
      // the schema has a node the grammar compiler cannot express, because `strict`
      // over such a schema is a 400 rather than a weaker constraint (see
      // compileToolSchema).
      ...(strictTools && strictSafe ? { strict: true } : {}),
      ...(tool.inputExamples && tool.inputExamples.length > 0
        ? { input_examples: tool.inputExamples }
        : {}),
    };
    return wire;
  });
}

/**
 * The lane's model + reasoning knobs, spread into a `messages.create` call.
 *
 * The pinned SDK (0.41.0) types `thinking` only in its pre-adaptive
 * `{type:'enabled', budget_tokens}` shape and has no member for `output_config`
 * at all. Both are plain top-level body fields that need no beta header, and the
 * SDK serialises the body as given — so the return type is narrowed to the one
 * field the SDK does know while `thinking` and `output_config` ride along at
 * runtime. Same blocker, same tactic as {@link WireTool}.
 *
 * Narrowing here rather than casting the whole request object keeps every OTHER
 * field (max_tokens, system, tools, messages) type-checked.
 */
type WireLaneFields = Pick<Anthropic.MessageCreateParams, 'model'>;

function wireLane(task: AgentTask): WireLaneFields {
  return laneRequestFields(pickLane(task)) as WireLaneFields;
}

/**
 * How much bigger the one re-ask gets. Three times, because the step that triggers this
 * spent 100% of its budget thinking: it needs room to finish the thought AND say
 * something, and a factor that merely nudges buys a second empty completion.
 */
const TRUNCATED_RETRY_FACTOR = 3;

/**
 * Did this completion hit the token ceiling before producing anything usable?
 *
 * Text OR a tool call means the budget went where it was supposed to — a clipped
 * sentence is still an answer the post-processor can trim, and re-asking there would pay
 * twice for something already in hand. Only a `max_tokens` stop with neither is the case
 * worth buying again.
 */
function isTruncatedBeforeSpeaking(response: Anthropic.Message): boolean {
  return (
    response.stop_reason === 'max_tokens' &&
    textFrom(response.content) === null &&
    !response.content.some((b) => b.type === 'tool_use')
  );
}

function textFrom(content: Anthropic.ContentBlock[]): string | null {
  const parts = content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text);
  return parts.length > 0 ? parts.join('\n') : null;
}

/**
 * How much of one tool's output may re-enter the context, in characters
 * (~2k tokens at 4 chars/token).
 *
 * A tool result is model-authored context the caller never sized: a wide week, a
 * long memory slice, or a chatty connector response used to ride back whole, on
 * every step, at full input price. The ceiling is per-call rather than
 * per-conversation because the failure it prevents is one fat result crowding
 * out the turn, not slow accumulation — maxSteps already bounds that.
 */
export const TOOL_RESULT_MAX_CHARS = 8_000;

/**
 * Serialize a tool result for the model, bounded.
 *
 * Truncation is NAMED in the payload, never silent (rule #11). A cut-off JSON
 * object is indistinguishable from a complete one to a model reading it, and the
 * failure that produces — answering confidently from half a week's calendar — is
 * exactly the fabrication the SMS surface cannot afford. So the notice says what
 * was cut, that the JSON is no longer well-formed, and what to do instead.
 */
function boundedToolResult(name: string, result: unknown): string {
  const serialized = JSON.stringify(result) ?? 'null';
  if (serialized.length <= TOOL_RESULT_MAX_CHARS) {
    return serialized;
  }
  return `${serialized.slice(0, TOOL_RESULT_MAX_CHARS)}\n\n[TRUNCATED: ${name} returned ${serialized.length} characters and only the first ${TOOL_RESULT_MAX_CHARS} are above, so the JSON is cut mid-structure. Narrow your arguments and call ${name} again if you need the rest. Do not guess at the omitted content, and do not describe it as complete.]`;
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
 *
 * Reports whether every call SUCCEEDED. A refusal fed back as a tool_result is a turn
 * the model still owes an answer to, so `runAgent`'s registering-tool exit reads this
 * and never ends a run on a tool that refused.
 */
async function handleToolUses(
  args: RunAgentArgs,
  toolByName: Map<string, RegisteredTool>,
  messages: Anthropic.MessageParam[],
  content: Anthropic.ContentBlock[],
  toolUses: Anthropic.ToolUseBlock[],
  hooks?: StreamingToolHooks,
): Promise<{ allOk: boolean }> {
  messages.push({ role: 'assistant', content });

  let allOk = true;
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
        content: boundedToolResult(block.name, result),
      });
    } catch (err) {
      allOk = false;
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
  return { allOk };
}

export async function runAgent(args: RunAgentArgs): Promise<RunAgentResult> {
  const lane = wireLane(args.skill.meta.task);
  const system = buildSystem(args.skill);
  const tools = toAnthropicTools(args.skill, args.tools, args.strictTools ?? true);
  const toolByName = new Map(args.tools.map((t) => [t.name, t]));

  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: initialUserContent(args) },
  ];

  let promptTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  let completionTokens = 0;
  let steps = 0;
  let truncatedRetries = 0;

  const maxTokens = args.maxTokens ?? DEFAULT_MAX_TOKENS;
  const meter = (usage: Anthropic.Usage) => {
    promptTokens += usage.input_tokens + (usage.cache_creation_input_tokens ?? 0);
    completionTokens += usage.output_tokens;
    cacheReadTokens += usage.cache_read_input_tokens ?? 0;
    cacheCreationTokens += usage.cache_creation_input_tokens ?? 0;
  };

  while (steps < args.maxSteps) {
    steps += 1;
    let response = await args.client.messages.create({
      ...lane,
      max_tokens: maxTokens,
      system,
      ...(tools.length > 0 && { tools }),
      messages,
    });
    meter(response.usage);

    // THE STEP THAT SAID NOTHING, ASKED AGAIN WITH ROOM.
    //
    // `max_tokens` is the ceiling on thinking PLUS text, and on a thinking lane the model
    // spends it in that order. So a hard turn can hit the ceiling having produced one
    // empty thinking block and no text and no tool call — a completion that cost a full
    // budget and carries nothing. Until now that fell through as `answer: null`, which is
    // the same value the loop returns for "ran out of steps": two different failures in
    // one bucket, and downstream the SMS router turned both into "nothing was changed"
    // (rule #11). It is prod's only failed coach-channel-sms run, 2026-08-22 17:41,
    // 399 thinking tokens of 400 on a follow-up whose answer was sitting in the thread.
    //
    // RE-ASKED, not continued: the messages are byte-identical, so this is the same step
    // with a bigger allowance rather than a new turn — the model has nothing to continue
    // FROM, since it never said anything. Bounded to ONE escalation per step, because a
    // parent is waiting and a budget that keeps doubling is a turn that never ends.
    //
    // Raising the LANE budget instead was the obvious alternative and it is the wrong
    // trade: measured on the coach corpus, more room for every turn makes the model
    // reason its way past its second tool (see the note on MAX_TOKENS in
    // apps/web/lib/channel/coach/runtime.ts). The room belongs to the turn that proved
    // it needed it.
    if (isTruncatedBeforeSpeaking(response)) {
      truncatedRetries += 1;
      response = await args.client.messages.create({
        ...lane,
        max_tokens: maxTokens * TRUNCATED_RETRY_FACTOR,
        system,
        ...(tools.length > 0 && { tools }),
        messages,
      });
      meter(response.usage);
    }

    const toolUses = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
    );

    if (toolUses.length === 0) {
      return {
        answer: textFrom(response.content),
        steps,
        hitMaxSteps: false,
        truncatedRetries,
        usage: { promptTokens, completionTokens, cacheReadTokens, cacheCreationTokens },
      };
    }

    const said = textFrom(response.content);
    const { allOk } = await handleToolUses(args, toolByName, messages, response.content, toolUses);

    // THE FINISHED ANSWER, KEPT. A turn whose every call was a `registersOnly` tool has
    // nothing left to read: the results are `{promised:true}`-shaped acknowledgements,
    // so the text beside them is not a preamble, it is the reply. Ending here keeps it.
    //
    // The alternative — feed the acknowledgements back and take another turn — is what
    // ran until 2026-08-21, and it lost the answer twice in one probe. The model treats
    // its own text as already said and writes a CONTINUATION: once a bare "I'll text you
    // when the dates are up" with the finds it had just described deleted, once two
    // tokens of whitespace that `toSmsReply` rejected into the apology template. Neither
    // is a shape prose can fix, because from the model's side nothing went wrong.
    //
    // Not on a refused call. A tool that threw handed back a sentence to correct, so the
    // model owes another turn — a run that stopped there would send an answer composed
    // around a promise that was never registered.
    if (said !== null && allOk && toolUses.every((b) => toolByName.get(b.name)?.registersOnly)) {
      return {
        answer: said,
        steps,
        hitMaxSteps: false,
        truncatedRetries,
        usage: { promptTokens, completionTokens, cacheReadTokens, cacheCreationTokens },
      };
    }
  }

  return {
    answer: null,
    steps,
    hitMaxSteps: true,
    truncatedRetries,
    usage: { promptTokens, completionTokens, cacheReadTokens, cacheCreationTokens },
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
  const lane = wireLane(args.skill.meta.task);
  const system = buildSystem(args.skill);
  const tools = toAnthropicTools(args.skill, args.tools, args.strictTools ?? true);
  const toolByName = new Map(args.tools.map((t) => [t.name, t]));

  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: initialUserContent(args) },
  ];

  let promptTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  let completionTokens = 0;
  let steps = 0;

  while (steps < args.maxSteps) {
    steps += 1;
    args.onStep?.(steps);
    const stream = args.client.messages.stream({
      ...lane,
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
    cacheReadTokens += response.usage.cache_read_input_tokens ?? 0;
    cacheCreationTokens += response.usage.cache_creation_input_tokens ?? 0;

    const toolUses = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
    );

    if (toolUses.length === 0) {
      return {
        answer: textFrom(response.content),
        steps,
        hitMaxSteps: false,
        // Streaming has no re-ask: a truncated stream has already put partial text on the
        // wire, so asking again would show the parent two answers to one question.
        truncatedRetries: 0,
        usage: { promptTokens, completionTokens, cacheReadTokens, cacheCreationTokens },
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
    // Streaming has no re-ask: a truncated stream has already put partial text on the
    // wire, so asking again would show the parent two answers to one question.
    truncatedRetries: 0,
    usage: { promptTokens, completionTokens, cacheReadTokens, cacheCreationTokens },
  };
}
