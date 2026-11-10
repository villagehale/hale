import { projectClient } from './posthog-node';

/**
 * Error tracking, privacy-first (hard rule #1).
 *
 * posthog-node's `captureException(err)` sends `err.message` as the exception value AND
 * attaches source context lines around every frame; in this codebase a message can carry
 * a provider's echo of a phone number or a body. So it is not used. {@link exceptionEvent}
 * builds the `$exception` payload from the error's CLASS and its parsed STACK FRAMES
 * (file, function, line, column — what source maps resolve) and nothing else: no
 * message, no context lines. Properties are a CLOSED allowlist:
 * `error_class`, `code`, `stage`, `route`, `method`, `hale_surface` — nothing else
 * can be passed, by type.
 *
 * Inert without POSTHOG_PROJECT_API_KEY: `projectClient()` is null and this returns
 * 'not_configured' without touching the network. Never throws.
 */

export type HaleSurface = 'api' | 'cron' | 'webhook' | 'worker' | 'agent';

export interface ExceptionContext {
  hale_surface: HaleSurface;
  route?: string;
  method?: string;
  stage?: string;
  code?: string;
}

export type ExceptionOutcome = 'sent' | 'not_configured' | 'provider_error';

/** Snake/kebab/path-ish tokens only; anything else ships as 'unclassified'. */
const SAFE_TOKEN = /^[A-Za-z0-9_\-/.[\]:]{1,120}$/;

function safeToken(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return SAFE_TOKEN.test(value) ? value : 'unclassified';
}

function errorClass(err: unknown): string {
  if (err instanceof Error) return safeToken(err.name || err.constructor?.name) ?? 'Error';
  return 'NonError';
}

function errorCode(err: unknown): string | undefined {
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as { code: unknown }).code;
    if (typeof code === 'string' || typeof code === 'number') return safeToken(String(code));
  }
  return undefined;
}

/** A copy of `err` that keeps its class and frames, and drops its message. Exported for tests. */
export function redactedError(err: unknown): Error {
  const name = errorClass(err);
  const safe = new Error('redacted');
  safe.name = name;
  const stack = err instanceof Error && typeof err.stack === 'string' ? err.stack : '';
  // Keep only "    at …" frame lines. The header line (and any continuation of a
  // multi-line message) is exactly where message text lives.
  const frames = stack.split('\n').filter((line) => /^\s+at\s/.test(line));
  safe.stack = [`${name}: redacted`, ...frames].join('\n');
  return safe;
}

interface Frame {
  filename: string;
  function: string;
  lineno?: number;
  colno?: number;
  in_app: boolean;
  platform: 'node:javascript';
}

/** V8 "    at fn (file:line:col)" / "    at file:line:col" → a frame. Nothing else survives. */
function parseFrame(line: string): Frame | null {
  const m = /^\s+at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?$/.exec(line);
  if (!m) return null;
  const filename = m[2] as string;
  return {
    filename,
    function: m[1] ?? '?',
    lineno: Number(m[3]),
    colno: Number(m[4]),
    in_app: !filename.includes('node_modules') && !filename.startsWith('node:'),
    platform: 'node:javascript',
  };
}

/** The `$exception_list` payload: class + frames, value always 'redacted'. Exported for tests. */
export function exceptionEvent(err: unknown): Record<string, unknown> {
  const safe = redactedError(err);
  const frames = (safe.stack ?? '')
    .split('\n')
    .map(parseFrame)
    .filter((f): f is Frame => f !== null)
    // PostHog expects oldest-first.
    .reverse();
  return {
    $exception_level: 'error',
    $exception_list: [
      {
        type: safe.name,
        value: 'redacted',
        mechanism: { type: 'generic', handled: true, synthetic: false },
        stacktrace: { type: 'raw', frames },
      },
    ],
  };
}

/** The allowlisted property bag. Exported so the redaction is asserted as a pure value. */
export function exceptionProperties(err: unknown, ctx: ExceptionContext): Record<string, string> {
  const props: Record<string, string> = {
    hale_surface: ctx.hale_surface,
    error_class: errorClass(err),
  };
  const code = safeToken(ctx.code) ?? errorCode(err);
  if (code) props.code = code;
  const route = safeToken(ctx.route);
  if (route) props.route = route;
  const method = safeToken(ctx.method);
  if (method) props.method = method;
  const stage = safeToken(ctx.stage);
  if (stage) props.stage = stage;
  return props;
}

export async function captureSafeException(
  err: unknown,
  distinctId: string,
  ctx: ExceptionContext,
): Promise<ExceptionOutcome> {
  const client = projectClient();
  if (!client) return 'not_configured';
  try {
    client.capture({
      distinctId,
      event: '$exception',
      properties: { ...exceptionEvent(err), ...exceptionProperties(err, ctx) },
    });
    await client.flush();
    return 'sent';
  } catch (flushErr) {
    console.warn('analytics: exception report failed to send', {
      err: flushErr instanceof Error ? flushErr.name : 'unknown',
    });
    return 'provider_error';
  }
}

/** Which surface a Next route pattern belongs to. */
export function surfaceForRoute(route: string): HaleSurface {
  if (route.startsWith('/api/cron/')) return 'cron';
  if (route.startsWith('/api/webhooks/')) return 'webhook';
  return 'api';
}

let handlersInstalled = false;

/**
 * Report process-level failures, then leave Node's behaviour exactly as it was:
 *  - uncaught exceptions via `uncaughtExceptionMonitor`, which observes without
 *    replacing the default crash;
 *  - unhandled rejections: capture, flush, then — only if nobody else (Next.js) was
 *    already handling them — RETHROW on the next tick, so the rejection still becomes
 *    the uncaught exception Node would have raised. If a handler already existed,
 *    behaviour was already "don't crash", and we only observe.
 * Only call this when a key is configured; it is a no-op on a second call.
 */
export function installProcessErrorHandlers(): void {
  if (handlersInstalled) return;
  handlersInstalled = true;
  process.on('uncaughtExceptionMonitor', (err) => {
    void captureSafeException(err, 'system', { hale_surface: 'worker', stage: 'uncaught' });
  });
  const nodeDefaultWouldCrash = process.listenerCount('unhandledRejection') === 0;
  process.on('unhandledRejection', (reason) => {
    void captureSafeException(reason, 'system', {
      hale_surface: 'worker',
      stage: 'unhandled_rejection',
    }).finally(() => {
      if (!nodeDefaultWouldCrash) return;
      // setImmediate, not a throw inside .finally: a throw there would be ANOTHER
      // unhandled rejection and loop back into this handler.
      setImmediate(() => {
        throw reason instanceof Error ? reason : new Error('unhandled rejection');
      });
    });
  });
}
