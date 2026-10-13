// SPEND CAP — a hard USD ceiling checked BEFORE every live model call of a recording round.
//
// Used at the call sites themselves (apps/worker/evals/lib/harness.mjs and the runners'
// direct calls, apps/web/lib/testing/recorded-model.ts), never as a wrapper around the
// SDK: the SDK call, its response body and any stream are untouched. The site hands over
// the request and a thunk that makes the call; this module
//   1. counts the request's input tokens with the free `messages.countTokens` endpoint,
//   2. projects input (at the cache-write rate when the request carries cache_control)
//      plus max_tokens of output, at list price,
//   3. refuses the call if spent + in-flight + projected would cross the cap,
//   4. after the call, books the REAL `usage` from the returned message.
//
// Env (all off unless HALE_MAX_USD is set):
//   HALE_MAX_USD=2.00            the cap for the whole round, across suites
//   HALE_SPEND_LEDGER=/tmp/x.json  shared ledger, so suites run one after another share it
//   HALE_ESTIMATE=1              never call the model: count tokens, book the projection,
//                                return a schema-shaped stand-in so the suite keeps going.
//                                Nothing is cached in this mode (see isEstimate()).
// Run processes one after another; the ledger has no cross-process lock.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const CACHE_WRITE = 1.25;
const CACHE_READ = 0.1;

export function isEstimate() {
  return process.env.HALE_ESTIMATE === '1';
}

export function capEnabled() {
  return Boolean(process.env.HALE_MAX_USD) || isEstimate();
}

function ledgerPath() {
  const p = process.env.HALE_SPEND_LEDGER;
  if (!p)
    throw new Error('spend-cap: HALE_SPEND_LEDGER is required with HALE_MAX_USD/HALE_ESTIMATE');
  return p;
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

/** Real USD from a returned message's `usage`. */
export function usageUsd(rates, model, usage) {
  const r = rates(model);
  return (
    ((usage?.input_tokens ?? 0) * r.input +
      (usage?.cache_creation_input_tokens ?? 0) * r.input * CACHE_WRITE +
      (usage?.cache_read_input_tokens ?? 0) * r.input * CACHE_READ +
      (usage?.output_tokens ?? 0) * r.output) /
    1e6
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
  const type = Array.isArray(schema.type) ? schema.type.find((t) => t !== 'null') : schema.type;
  if (schema.anyOf || schema.oneOf) return standIn((schema.anyOf ?? schema.oneOf)[0]);
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
  const forced = request.tool_choice?.type === 'tool' ? request.tool_choice.name : null;
  const tool = forced && (request.tools ?? []).find((t) => t.name === forced);
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
 * The one entry point. `client` is used only for the free countTokens; `call` is the
 * site's own unchanged SDK call (create, or stream(...).finalMessage()), returning a Message.
 * With the cap off this is exactly `call()`.
 */
export async function cappedCall({ client, request, call, rates, tag = '' }) {
  if (!capEnabled()) return call();
  const cap = Number(process.env.HALE_MAX_USD ?? Number.POSITIVE_INFINITY);
  const before = readLedger();
  if (before.halted) throw new Error(`spend-cap: round halted (${before.halted}); refusing ${tag}`);

  let inputTokens;
  try {
    const { model, messages, system, tools, tool_choice, thinking } = request;
    const res = await client.messages.countTokens({
      model,
      messages,
      ...(system !== undefined ? { system } : {}),
      ...(tools !== undefined ? { tools } : {}),
      ...(tool_choice !== undefined ? { tool_choice } : {}),
      ...(thinking !== undefined ? { thinking } : {}),
    });
    inputTokens = res.input_tokens;
  } catch (err) {
    if (isAuth(err)) {
      const l = readLedger();
      l.halted = `auth error ${err.status} counting tokens for ${request.model}`;
      save(l);
      throw new Error(`spend-cap: ${l.halted} — stopping the round`);
    }
    // No count, no call: a count that cannot reach the API says the call would not either
    // (2026-10-13: SDK 0.41's node-fetch died with "Premature close" on both endpoints
    // while global fetch worked; run live rounds with --import @anthropic-ai/sdk/shims/web).
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
  const projected = projectUsd(rates, request, inputTokens);

  if (isEstimate()) {
    const l = readLedger();
    l.estimated += 1;
    l.estimateUsd = (l.estimateUsd ?? 0) + projected;
    l.log.push({
      estimate: true,
      tag,
      model: request.model,
      inputTokens,
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
      `spend-cap: refusing ${tag} — spent $${l.spentUsd.toFixed(4)} + in-flight $${l.reservedUsd.toFixed(4)} + projected $${projected.toFixed(4)} > cap $${cap}`,
    );
  }
  l.reservedUsd += projected;
  save(l);

  let message;
  try {
    message = await call();
  } catch (err) {
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
  const m = readLedger();
  m.reservedUsd = Math.max(0, m.reservedUsd - projected);
  const actual = message?.usage ? usageUsd(rates, request.model, message.usage) : projected;
  m.spentUsd += actual;
  m.calls += 1;
  m.log.push({ tag, model: request.model, projected, actual, usage: message?.usage ?? null });
  save(m);
  return message;
}
