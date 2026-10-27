// SPEND CAP — a hard USD ceiling checked BEFORE every live model call of a recording round.
//
// Used at the call sites themselves (the runners' Anthropic client, and the harness
// gateway), never as a wrapper around the SDK class: the request, the response body and
// any stream are untouched. The site hands over the request and a thunk that makes the
// call; this module
//   1. counts the request's input tokens with the free `messages.countTokens` endpoint,
//   2. projects that input (at the cache-write rate when the request carries cache_control)
//      plus max_tokens of output, at list price,
//   3. for a web_search turn, replaces the counted input with 250k tokens and adds
//      max_uses × $0.01, because the tool results are billed as input the request did
//      not yet contain,
//   4. refuses the call if spent + in-flight + that worst case would cross the cap,
//   5. after the call, books the REAL `usage`, including
//      server_tool_use.web_search_requests × $0.01.
//
// The ceiling is the lower of HALE_MAX_USD and --max-usd. Both unset means no cap, and
// this module is then exactly `call()`.
//
// Env:
//   HALE_MAX_USD=2.42              the cap for the whole round, across suites
//   HALE_SPEND_LEDGER=/tmp/x.json  shared ledger, so suites run one after another share it
//   HALE_ESTIMATE=1                never call the model: count tokens, book the projection,
//                                  return a schema-shaped stand-in. Nothing is cached.
// Run processes one after another; the ledger has no cross-process lock.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const CACHE_WRITE = 1.25;
const CACHE_READ = 0.1;

/** List price of one web search request, billed apart from tokens. */
export const USD_PER_WEB_SEARCH = 0.01;

/**
 * Input tokens a search turn is priced at BEFORE the call. The request itself is short;
 * each search result comes back as input, and max_uses of them is what can be billed.
 */
export const SEARCH_WORST_INPUT_TOKENS = 250_000;

const DEFAULT_LEDGER = '/tmp/hale-eval-spend.json';

export function isEstimate() {
  return process.env.HALE_ESTIMATE === '1';
}

function flagValue(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--max-usd') return argv[i + 1];
    if (arg.startsWith('--max-usd=')) return arg.slice('--max-usd='.length);
  }
  return undefined;
}

function parseUsd(raw, label) {
  if (raw === undefined || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`spend-cap: ${label} must be a non-negative number (got ${raw})`);
  }
  return n;
}

/**
 * The ceiling for this process. `--max-usd` and `HALE_MAX_USD` both count; the lower
 * one wins. Null means the cap is off.
 */
export function readCapUsd(argv = process.argv, env = process.env) {
  const fromFlag = parseUsd(flagValue(argv), '--max-usd');
  const fromEnv = parseUsd(env.HALE_MAX_USD, 'HALE_MAX_USD');
  const values = [fromFlag, fromEnv].filter((n) => n !== null);
  if (values.length === 0) return null;
  return Math.min(...values);
}

export function capEnabled() {
  return readCapUsd() !== null || isEstimate();
}

function ledgerPath() {
  if (!process.env.HALE_SPEND_LEDGER) process.env.HALE_SPEND_LEDGER = DEFAULT_LEDGER;
  return process.env.HALE_SPEND_LEDGER;
}

/**
 * Makes the env and the ledger agree with the flag before any call. Returns the
 * ceiling, or null when neither source set one.
 */
export function installSpendCap(argv = process.argv) {
  const cap = readCapUsd(argv, process.env);
  if (cap === null) return null;
  process.env.HALE_MAX_USD = String(cap);
  ledgerPath();
  return cap;
}

export function readLedger() {
  const p = ledgerPath();
  if (!existsSync(p)) {
    return {
      spentUsd: 0,
      reservedUsd: 0,
      calls: 0,
      refused: 0,
      estimated: 0,
      halted: null,
      log: [],
    };
  }
  return JSON.parse(readFileSync(p, 'utf8'));
}

function save(l) {
  writeFileSync(ledgerPath(), `${JSON.stringify(l, null, 2)}\n`);
}

export function webSearchTool(request) {
  const tools = request?.tools ?? [];
  return (
    tools.find(
      (tool) => tool?.name === 'web_search' || String(tool?.type ?? '').startsWith('web_search'),
    ) ?? null
  );
}

/** max_uses × $0.01, or null when this request is not a search turn. */
export function webSearchWorst(request) {
  const tool = webSearchTool(request);
  if (!tool) return null;
  const maxUses = tool.max_uses;
  if (!Number.isFinite(maxUses) || maxUses < 0) {
    throw new Error('spend-cap: web_search tool has no max_uses; refusing the call');
  }
  return { maxUses, feeUsd: maxUses * USD_PER_WEB_SEARCH };
}

/** Projected USD: counted input + max_tokens output. `rates(model)` -> {input, output} per MTok. */
export function projectUsd(rates, request, inputTokens) {
  const r = rates(request.model);
  const cached =
    JSON.stringify(request.system ?? '').includes('cache_control') ||
    JSON.stringify(request.messages ?? '').includes('cache_control') ||
    JSON.stringify(request.tools ?? '').includes('cache_control');
  const inRate = r.input * (cached ? CACHE_WRITE : 1);
  return (inputTokens * inRate + (request.max_tokens ?? 0) * r.output) / 1e6;
}

/**
 * Worst case charged BEFORE the call. A search turn is max_uses × $0.01 plus 250k
 * input tokens, and still the full max_tokens of output. Any other turn is the
 * counted input plus that same output ceiling.
 */
export function worstCaseUsd(rates, request, inputTokens) {
  const search = webSearchWorst(request);
  const tokens = search ? SEARCH_WORST_INPUT_TOKENS : inputTokens;
  return projectUsd(rates, request, tokens) + (search?.feeUsd ?? 0);
}

// --- cache-aware worst case ---------------------------------------------------
// A request whose system prompt carries cache_control pays the cache-WRITE rate on its
// prefix the first time, and the cache-READ rate (0.1x) while that prefix is warm. The
// guard only takes the read rate when THIS process saw proof the prefix was cached: the
// previous call with the same prefix (model + tools + system) reported
// cache_creation_input_tokens or cache_read_input_tokens, it STARTED within the cache TTL
// (5 min by default, 1h when the marker says so, minus a safety margin), and no other call
// is in flight (calls run one at a time, so a cache write cannot land twice unseen).
// Anything else, the whole input is priced as now. The ledger always books the real usage.

export const DEFAULT_CACHE_TTL_MS = 5 * 60_000;
export const CACHE_TTL_MARGIN_MS = 15_000;
const warmPrefixes = new Map();
let callsInFlight = 0;

/** The cache prefix of a request ({key, ttlMs}), or null when the system is not cached. */
export function cachePrefix(request) {
  const system = Array.isArray(request?.system) ? request.system : [];
  const marked = system.filter((b) => b?.cache_control);
  if (marked.length === 0) return null;
  const ttlMs = marked.some((b) => b.cache_control.ttl === '1h')
    ? 60 * 60_000
    : DEFAULT_CACHE_TTL_MS;
  const key = JSON.stringify({ model: request.model, tools: request.tools ?? null, system });
  return { key, ttlMs };
}

/** Prefix tokens the guard may price at the read rate now; 0 means no discount. */
export function warmPrefixTokens(request, now = Date.now()) {
  if (callsInFlight > 0) return 0;
  const prefix = cachePrefix(request);
  if (!prefix) return 0;
  const seen = warmPrefixes.get(prefix.key);
  if (!seen) return 0;
  if (now - seen.startedAt > seen.ttlMs - CACHE_TTL_MARGIN_MS) return 0;
  return seen.tokens;
}

/** Remember (or forget) a prefix from a call's REAL usage. */
export function notePrefixUsage(request, usage, startedAt) {
  const prefix = cachePrefix(request);
  if (!prefix) return;
  const tokens = (usage?.cache_creation_input_tokens ?? 0) + (usage?.cache_read_input_tokens ?? 0);
  if (tokens > 0) warmPrefixes.set(prefix.key, { tokens, startedAt, ttlMs: prefix.ttlMs });
  else warmPrefixes.delete(prefix.key);
}

/** Test hook: forget every warm prefix. */
export function resetPromptCacheState() {
  warmPrefixes.clear();
  callsInFlight = 0;
}

/**
 * Worst case with `prefixTokens` of the input at the cache-read rate. The rest of the
 * input stays at the rate worstCaseUsd uses (cache-write when marked), output at max_tokens.
 */
export function cacheAwareWorstUsd(rates, request, inputTokens, prefixTokens = 0) {
  if (!prefixTokens || webSearchTool(request)) return worstCaseUsd(rates, request, inputTokens);
  const r = rates(request.model);
  const read = Math.min(prefixTokens, inputTokens);
  return (
    (read * r.input * CACHE_READ +
      (inputTokens - read) * r.input * CACHE_WRITE +
      (request.max_tokens ?? 0) * r.output) /
    1e6
  );
}

export function searchFeeUsd(usage) {
  return (usage?.server_tool_use?.web_search_requests ?? 0) * USD_PER_WEB_SEARCH;
}

/** Real USD from a returned message's `usage`, including web search fees. */
export function usageUsd(rates, model, usage) {
  const r = rates(model);
  return (
    ((usage?.input_tokens ?? 0) * r.input +
      (usage?.cache_creation_input_tokens ?? 0) * r.input * CACHE_WRITE +
      (usage?.cache_read_input_tokens ?? 0) * r.input * CACHE_READ +
      (usage?.output_tokens ?? 0) * r.output) /
      1e6 +
    searchFeeUsd(usage)
  );
}

function isAuth(err) {
  return err?.status === 401 || err?.status === 403;
}

/** A value that satisfies a JSON schema's shape, for the estimate stand-in only. */
export function standIn(schema) {
  if (!schema || typeof schema !== 'object') return 'estimate';
  if (Array.isArray(schema.enum)) return schema.enum[0];
  if (schema.const !== undefined) return schema.const;
  if (schema.anyOf || schema.oneOf) return standIn((schema.anyOf ?? schema.oneOf)[0]);
  const type = Array.isArray(schema.type) ? schema.type.find((t) => t !== 'null') : schema.type;
  switch (type) {
    case 'object': {
      const out = {};
      for (const [k, v] of Object.entries(schema.properties ?? {})) out[k] = standIn(v);
      return out;
    }
    case 'array':
      return Array.from({ length: schema.minItems ?? 0 }, () => standIn(schema.items));
    case 'number':
    case 'integer':
      return schema.maximum ?? schema.minimum ?? 5;
    case 'boolean':
      return true;
    default:
      return 'estimate';
  }
}

function standInMessage(request) {
  const schema = request.output_config?.format?.schema;
  if (schema) {
    return {
      id: 'estimate',
      type: 'message',
      role: 'assistant',
      model: request.model,
      content: [{ type: 'text', text: JSON.stringify(standIn(schema)) }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    };
  }
  const forced = request.tool_choice?.type === 'tool' ? request.tool_choice.name : null;
  const sole =
    forced ??
    (request.tool_choice?.type === 'auto' && request.tools?.length === 1
      ? request.tools[0].name
      : null);
  const tool = sole && (request.tools ?? []).find((t) => t.name === sole);
  return {
    id: 'estimate',
    type: 'message',
    role: 'assistant',
    model: request.model,
    content: tool
      ? [{ type: 'tool_use', id: 'estimate', name: tool.name, input: standIn(tool.input_schema) }]
      : [{ type: 'text', text: 'estimate' }],
    stop_reason: tool ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}

/**
 * count_tokens rejects a forced tool_choice (`type: "tool"` or `"any"`) with a 400.
 * The count only needs the tools and the messages, so those two are relaxed to
 * `auto` here. The request the real call sends is left as it arrived.
 */
function toolChoiceForCount(toolChoice) {
  if (toolChoice?.type === 'tool' || toolChoice?.type === 'any') return { type: 'auto' };
  return toolChoice;
}

async function countInputTokens(client, request) {
  const { model, messages, system, tools, tool_choice, thinking } = request;
  const countedChoice = toolChoiceForCount(tool_choice);
  const res = await client.messages.countTokens({
    model,
    messages,
    ...(system !== undefined ? { system } : {}),
    ...(tools !== undefined ? { tools } : {}),
    ...(tool_choice !== undefined ? { tool_choice: countedChoice } : {}),
    ...(thinking !== undefined ? { thinking } : {}),
  });
  return res.input_tokens;
}

/**
 * The one entry point. `client` is used only for the free countTokens; `call` is the
 * site's own unchanged SDK call (create, or stream(...).finalMessage()), returning a Message.
 * With the cap off this is exactly `call()`.
 */
export async function cappedCall({ client, request, call, rates, tag = '' }) {
  if (!capEnabled()) return call();
  const cap = readCapUsd() ?? Number.POSITIVE_INFINITY;
  const before = readLedger();
  if (before.halted) throw new Error(`spend-cap: round halted (${before.halted}); refusing ${tag}`);

  const search = webSearchTool(request);
  let inputTokens = 0;
  if (!search) {
    try {
      inputTokens = await countInputTokens(client, request);
    } catch (err) {
      if (isAuth(err)) {
        const l = readLedger();
        l.halted = `auth error ${err.status} counting tokens for ${request.model}`;
        save(l);
        throw new Error(`spend-cap: ${l.halted}; stopping the round`);
      }
      // No count, no call: a count that cannot reach the API says the call would not either.
      const l = readLedger();
      l.refused += 1;
      l.log.push({
        refused: true,
        tag,
        model: request.model,
        countError: String(err?.message ?? err).slice(0, 200),
      });
      save(l);
      throw new Error(
        `spend-cap: could not count tokens for ${tag} (${String(err?.message ?? err).slice(0, 120)}); refusing the call`,
      );
    }
  }
  const warmTokens = search ? 0 : warmPrefixTokens(request);
  const projected = cacheAwareWorstUsd(rates, request, inputTokens, warmTokens);

  if (isEstimate()) {
    const l = readLedger();
    l.estimated += 1;
    l.estimateUsd = (l.estimateUsd ?? 0) + projected;
    l.log.push({
      estimate: true,
      tag,
      model: request.model,
      inputTokens: search ? SEARCH_WORST_INPUT_TOKENS : inputTokens,
      maxTokens: request.max_tokens,
      projected,
    });
    save(l);
    return standInMessage(request);
  }

  const l = readLedger();
  if (l.spentUsd + l.reservedUsd + projected > cap) {
    l.refused += 1;
    l.log.push({ refused: true, tag, model: request.model, projected });
    save(l);
    throw new Error(
      `spend-cap: refusing ${tag}; spent $${l.spentUsd.toFixed(4)} + in-flight $${l.reservedUsd.toFixed(4)} + worst case $${projected.toFixed(4)} > cap $${cap}`,
    );
  }
  l.reservedUsd += projected;
  save(l);

  let message;
  const startedAt = Date.now();
  callsInFlight += 1;
  try {
    message = await call();
  } catch (err) {
    callsInFlight -= 1;
    notePrefixUsage(request, null, startedAt);
    const m = readLedger();
    m.reservedUsd = Math.max(0, m.reservedUsd - projected);
    // The request may have been billed before the failure; book the projection so the
    // cap stays an upper bound.
    m.spentUsd += projected;
    m.calls += 1;
    if (isAuth(err)) m.halted = `auth error ${err.status} on ${request.model}`;
    m.log.push({
      tag,
      model: request.model,
      projected,
      error: String(err?.status ?? err?.message ?? err),
    });
    save(m);
    throw err;
  }
  callsInFlight -= 1;
  notePrefixUsage(request, message?.usage, startedAt);
  const m = readLedger();
  m.reservedUsd = Math.max(0, m.reservedUsd - projected);
  const actual = message?.usage ? usageUsd(rates, request.model, message.usage) : projected;
  m.spentUsd += actual;
  m.calls += 1;
  m.log.push({
    tag,
    model: request.model,
    projected,
    ...(warmTokens ? { cacheReadPricedTokens: warmTokens } : {}),
    actual,
    usage: message?.usage ?? null,
  });
  save(m);
  return message;
}

/**
 * The Anthropic client the eval suites hold. `messages.create` and `messages.stream`
 * check the cap, then perform the original call. With the cap off this is the client
 * itself, so a cached-only run never counts tokens.
 */
/** A spend-cap refusal, halt, or count failure. The runner prints what finished and exits. */
export function isSpendCapStop(err) {
  return err instanceof Error && err.message.startsWith('spend-cap:');
}

const CAPPED = Symbol.for('hale.spendCap');

export function capSdkClient(client, { rates, tag = 'eval' } = {}) {
  const raw = client?.[CAPPED]?.raw ?? client;
  if (!capEnabled()) return raw;
  // A suite that wraps the harness client again keeps one check and the outer tag.
  if (client?.[CAPPED]) return capSdkClient(raw, { rates, tag });
  if (!rates) throw new Error('spend-cap: rates are required when the cap is on');
  const messages = client.messages;
  const wrapped = {
    messages: {
      countTokens: (req) => messages.countTokens(req),
      create: (request) =>
        cappedCall({
          client,
          request,
          call: () => messages.create(request),
          rates,
          tag: webSearchTool(request) ? `${tag}:search` : tag,
        }),
      stream: (request) => ({
        finalMessage: () =>
          cappedCall({
            client,
            request,
            call: () => messages.stream(request).finalMessage(),
            rates,
            tag: webSearchTool(request) ? `${tag}:search` : tag,
          }),
      }),
    },
  };
  wrapped[CAPPED] = { raw: client };
  return wrapped;
}
