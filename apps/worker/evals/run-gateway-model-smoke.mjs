#!/usr/bin/env node

const ENDPOINT = 'https://ai-gateway.vercel.sh/v1/chat/completions';
const MODELS = [
  'google/gemini-3.5-flash-lite',
  'google/gemini-3.8-flash',
  'deepseek/deepseek-v4.1-flash',
  'zai/glm-5.3-flash',
  'openai/gpt-5.4-nano',
  'openai/gpt-5.6-luna',
  'openai/gpt-6-luna',
  'openai/gpt-6-sol',
  'openai/gpt-6.1-sol',
  'anthropic/claude-sonnet-5.5',
  'anthropic/claude-opus-5.5',
];

function argument(name) {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

function credential() {
  for (const name of ['AI_GATEWAY_API_KEY', 'VERCEL_KEY', 'JEV_KEY']) {
    const value = process.env[name];
    if (value) return { name, value };
  }
  return null;
}

function numberOrNull(value) {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function probe(model, auth) {
  const startedAt = performance.now();
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${auth.value}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: 'Reply with exactly READY and nothing else.' }],
      max_tokens: 32,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const latencyMs = Math.round(performance.now() - startedAt);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = body?.error?.message ?? body?.message ?? 'request failed';
    throw new Error(`${response.status} ${message}`);
  }

  const text = body?.choices?.[0]?.message?.content?.trim() ?? '';
  const gateway = body?.provider_metadata?.gateway ?? body?.providerMetadata?.gateway;
  return {
    ok: text === 'READY',
    text,
    latencyMs,
    inputTokens: body?.usage?.prompt_tokens ?? body?.usage?.input_tokens ?? null,
    outputTokens: body?.usage?.completion_tokens ?? body?.usage?.output_tokens ?? null,
    costUsd: numberOrNull(gateway?.cost),
  };
}

async function main() {
  const selected = argument('model');
  const cachedOnly = process.argv.includes('--cached-only');
  if (process.argv.includes('--list')) {
    console.info(MODELS.join('\n'));
    return;
  }
  if (selected && !MODELS.includes(selected)) {
    throw new Error(`Unknown model '${selected}'. Use --list to see candidates.`);
  }

  const auth = credential();
  // The Monday sweep runs every runner with --cached-only and no secrets. A throw
  // here fails that job. Live probing stays the path when a credential is present
  // and this is not a cache replay.
  if (cachedOnly || !auth) {
    const why = [
      cachedOnly ? '--cached-only' : null,
      auth ? null : 'no AI_GATEWAY_API_KEY, VERCEL_KEY, or JEV_KEY',
    ]
      .filter(Boolean)
      .join('; ');
    console.info(`gateway-model-smoke: skipped (${why}); no live probe`);
    return;
  }

  const models = selected ? [selected] : MODELS;
  console.info(`Gateway smoke | credential=${auth.name} | models=${models.length}`);
  let failed = 0;
  for (const model of models) {
    try {
      const result = await probe(model, auth);
      if (!result.ok) failed += 1;
      console.info(
        `${result.ok ? 'PASS' : 'FAIL'} ${model} latency=${result.latencyMs}ms tokens=${result.inputTokens ?? '?'}/${result.outputTokens ?? '?'} cost=${result.costUsd === null ? 'unknown' : `$${result.costUsd.toFixed(6)}`} answer=${JSON.stringify(result.text)}`,
      );
    } catch (error) {
      failed += 1;
      console.info(`FAIL ${model} ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
