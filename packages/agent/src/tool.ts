import type { z } from 'zod';

/**
 * Guarded tool registry.
 *
 * Agents reason and compose skills; they do NOT get to choose whether the safety
 * rails run. A tool is `defineTool(...)` + handler, and EVERY invocation goes
 * through `invokeTool`, which enforces the Hale hard rules BEFORE the handler is
 * allowed to run:
 *
 *   - monetary tool            → spending-cap hook must pass        (rule #7)
 *   - touchesChildContent tool → teen-redaction / consent hook must pass (rule #1/#5)
 *   - ALWAYS                    → an audit_log row is written        (rule #6)
 *
 * The rails are rule-enforced, not agent-chosen: a tool whose guardrail rejects
 * THROWS — the handler never executes, and no side effect occurs. The hooks
 * themselves are injected, so this leaf package stays free of @hale/db; the real
 * cap-check / audit-write / consent-check implementations wire in at the worker
 * and web call sites (and tests inject fakes to assert the rail mechanics).
 */

/** A tool definition: metadata + zod-validated input + the side-effecting handler. */
export interface ToolDefinition<TInput, TOutput> {
  name: string;
  description: string;
  inputSchema: z.ZodType<TInput>;
  /**
   * Spends money → the spending-cap hook gates it (rule #7). REQUIRED, and `false`
   * must be written out: an unstated flag would read as "safe" and route around the
   * gate silently, so the classification that decides whether a rail runs is a
   * declaration every tool author makes, not a default they can forget (VIL-269).
   */
  monetary: boolean;
  /**
   * The tool's input can NAME a child, so the teen-redaction/consent hook must
   * resolve and gate it before the handler runs (rule #1/#5). REQUIRED for the same
   * reason as `monetary`. A tool that reads child data WITHOUT taking a childId
   * declares `false` and is teen-safe by construction instead — it redacts at the
   * source, because the guard has no child to resolve from its input.
   */
  touchesChildContent: boolean;
  /**
   * Sample INPUTS shown to the model alongside the schema (`input_examples` on
   * the wire). Worth declaring on multi-argument tools, where a schema says what
   * is well-typed but not what a well-formed call looks like — which optional
   * arguments to include, and where a value is supposed to come from.
   *
   * Rule #1: these ride in the tool definition, which is compiled to a grammar
   * and cached OUTSIDE the protections message content gets. An example is
   * therefore always invented — never a real child's name, address, school, or
   * identifier. Each one must also satisfy `inputSchema`; an invalid example is
   * a 400, so the sweep test parses every example against its own schema.
   */
  inputExamples?: ReadonlyArray<Record<string, unknown>>;
  /**
   * This tool hands back NOTHING the answer depends on — it registers an intent
   * (`{promised:true}`, `{offered:true}`) and the model has already finished
   * composing when it calls one.
   *
   * That distinction is what tells a finished answer apart from a preamble, and the
   * agent loop needs it because the model writes both in the same position. Before a
   * tool it is about to READ — `lookup_week`, `find_activities` — the text is "let me
   * check the schedule", scratch the parent must never see. Before a registering tool
   * there is nothing left to wait for, so the text is the whole reply, and on
   * 2026-08-21 the loop threw two of them away: a parent who asked about a named gym
   * got "I'll check back and text you when the dates are up" with the finds deleted,
   * and a second turn emitted whitespace and fell through to the apology template.
   *
   * Declaring it lets `runAgent` end on that turn — the answer is kept and a model
   * round trip a parent was waiting on is not spent re-saying it (see runAgent).
   *
   * OPTIONAL, unlike `monetary` and `touchesChildContent`, and the asymmetry is
   * deliberate: those two decide whether a safety rail runs, so an unstated flag would
   * route around it. Here an unstated flag means "keep looping", which is the old
   * behaviour and the conservative one — the cost of forgetting it is a wasted turn,
   * not a skipped guard.
   *
   * READ BY `runAgent` ONLY. The streaming loop drops a tool-calling turn's text through
   * `onTurnReset` by contract with its consumer, and no streaming skill lists a
   * registering tool today — adding one there means teaching that contract this flag
   * first, or the same answer goes missing from the app's Ask.
   */
  registersOnly?: boolean;
  handler: (input: TInput, ctx: ToolHandlerContext) => Promise<TOutput>;
}

/** Per-invocation context the handler receives (family scope + acting agent run). */
export interface ToolHandlerContext {
  familyId: string;
  /** 'system', an agent_run uuid, or a user uuid — written verbatim to audit_log.actor. */
  actor: string;
}

/** `defineTool` is identity with inference — it pins the input/output types from the schema/handler. */
export function defineTool<TInput, TOutput>(
  def: ToolDefinition<TInput, TOutput>,
): ToolDefinition<TInput, TOutput> {
  return def;
}

/**
 * What `monetaryCostHook` must return: the dollar amount + category of a monetary
 * tool call so the cap hook can decide. Derived from the (validated) tool input.
 */
export interface MonetaryCost {
  amountUsd: number;
  category: string;
}

/** Outcome of a guardrail hook. `ok:false` REFUSES the tool — the handler never runs. */
export interface GuardResult {
  ok: boolean;
  reason: string;
}

/** Injected dependencies that carry the real safety implementations. */
export interface GuardDeps {
  /**
   * Writes the immutable audit_log row for THIS invocation (rule #6). Called on
   * every tool call, before the handler, with the validated input. Non-optional:
   * there is no path to run a tool without an audit write.
   */
  writeAudit: (entry: AuditEntry) => Promise<void>;
  /**
   * Cap check (rule #7). REQUIRED whenever any monetary tool may run — invokeTool
   * throws if a monetary tool is invoked without it, so a missing wiring fails
   * closed rather than silently skipping the cap.
   */
  checkSpendingCap?: (familyId: string, cost: MonetaryCost) => Promise<GuardResult>;
  /**
   * For a monetary tool, derive {amountUsd, category} from its validated input.
   * REQUIRED alongside checkSpendingCap for monetary tools.
   */
  monetaryCostOf?: (toolName: string, input: unknown) => MonetaryCost;
  /**
   * Teen-redaction / consent check (rule #1/#5). REQUIRED whenever any
   * child-content-touching tool may run; missing wiring fails closed (throws).
   */
  checkChildContentAccess?: (
    familyId: string,
    toolName: string,
    input: unknown,
  ) => Promise<GuardResult>;
}

/**
 * The `audit_log.action_taken` prefix every guarded tool invocation is written
 * under (`tool:<name>`). These rows are internal agent SUB-STEPS of an Ask — the
 * source of truth for identifying them downstream (e.g. excluding them from the
 * parent-facing trail), so the marker lives here rather than as a magic string.
 */
export const AGENT_TOOL_ACTION_PREFIX = 'tool:';

/** The shape written to audit_log. Mirrors packages/db audit_log columns (rule #6). */
export interface AuditEntry {
  familyId: string;
  actor: string;
  actionTaken: string;
  /** The validated tool input, recorded as the "after" payload for right-to-access. */
  after: unknown;
}

/** Raised when a guardrail refuses a tool. The handler did NOT run and nothing changed. */
export class GuardrailError extends Error {
  constructor(
    readonly toolName: string,
    readonly rail: 'spending_cap' | 'child_content',
    reason: string,
  ) {
    super(`guardrail '${rail}' blocked tool '${toolName}': ${reason}`);
    this.name = 'GuardrailError';
  }
}

/**
 * Run a tool through the rails. Order is deliberate:
 *   1. validate input (reject hallucinated args at the boundary)
 *   2. spending-cap gate (if monetary) — throw on reject
 *   3. child-content gate (if touchesChildContent) — throw on reject
 *   4. ALWAYS write the audit row (rule #6) — even a permitted call is logged
 *   5. run the handler
 *
 * Audit is written AFTER the gates pass and BEFORE the handler runs: a refused
 * call produces a GuardrailError (and the refusal is itself observable from the
 * thrown error), while a permitted call is recorded the instant it is authorized,
 * so a handler crash can never leave an authorized action unlogged.
 */
export async function invokeTool<TInput, TOutput>(
  tool: ToolDefinition<TInput, TOutput>,
  rawInput: unknown,
  ctx: ToolHandlerContext,
  deps: GuardDeps,
): Promise<TOutput> {
  const input = tool.inputSchema.parse(rawInput);

  if (tool.monetary) {
    if (!deps.checkSpendingCap || !deps.monetaryCostOf) {
      throw new Error(
        `invokeTool: monetary tool '${tool.name}' requires checkSpendingCap + monetaryCostOf hooks (rule #7)`,
      );
    }
    const cost = deps.monetaryCostOf(tool.name, input);
    const verdict = await deps.checkSpendingCap(ctx.familyId, cost);
    if (!verdict.ok) {
      throw new GuardrailError(tool.name, 'spending_cap', verdict.reason);
    }
  }

  if (tool.touchesChildContent) {
    if (!deps.checkChildContentAccess) {
      throw new Error(
        `invokeTool: child-content tool '${tool.name}' requires checkChildContentAccess hook (rule #1/#5)`,
      );
    }
    const verdict = await deps.checkChildContentAccess(ctx.familyId, tool.name, input);
    if (!verdict.ok) {
      throw new GuardrailError(tool.name, 'child_content', verdict.reason);
    }
  }

  await deps.writeAudit({
    familyId: ctx.familyId,
    actor: ctx.actor,
    actionTaken: `${AGENT_TOOL_ACTION_PREFIX}${tool.name}`,
    after: input,
  });

  return tool.handler(input, ctx);
}
