import { collectPageSnapshot } from '../snapshot-in-page';
import { registrationUrlAllowed } from '../url';

function byName(name: string): string {
  return `[name="${name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`;
}

/**
 * Hands script written into a remote browser runtime.
 *
 * It listens on loopback only, runs the same page reader as local Playwright,
 * and refuses a URL the backend would refuse. It does not read the environment,
 * and it does not decide the next signup step.
 *
 * The snapshot image must already contain `playwright` and Chromium. This
 * script is copied in at session start so the driver matches this deploy.
 */
export function signupHandsScriptSource(): string {
  const source = `'use strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const registrationUrlAllowed = ${registrationUrlAllowed.toString()};
const collectPageSnapshot = ${collectPageSnapshot.toString()};
const byName = ${byName.toString()};

const HOST = '127.0.0.1';
const PORT = 17391;
const MAX_COMMAND_BYTES = 16384;

let browser = null;
let page = null;

function failure(error) {
  return { ok: false, error };
}

async function dispatch(cmd) {
  if (!cmd || typeof cmd !== 'object' || typeof cmd.op !== 'string') return failure('command_failed');
  if (cmd.op === 'ping') return { ok: true };
  if (cmd.op === 'open') {
    if (typeof cmd.url !== 'string') return failure('command_failed');
    const allowed = registrationUrlAllowed(cmd.url);
    if (!allowed.ok) return failure('url_refused');
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    page = await (await browser.newContext()).newPage();
    await page.goto(allowed.href, { waitUntil: 'domcontentloaded', timeout: 15000 });
    return { ok: true };
  }
  if (!page) return failure('command_failed');
  if (cmd.op === 'snapshot') {
    const snapshot = await page.evaluate(collectPageSnapshot);
    return { ok: true, snapshot };
  }
  if (cmd.op === 'fill' || cmd.op === 'select') {
    if (typeof cmd.name !== 'string' || typeof cmd.value !== 'string') return failure('command_failed');
    const locator = page.locator(byName(cmd.name));
    if (cmd.op === 'fill') await locator.fill(cmd.value);
    else await locator.selectOption(cmd.value);
    return { ok: true };
  }
  if (cmd.op === 'continue') {
    await page.locator('button[type="submit"], input[type="submit"]').first().click();
    return { ok: true };
  }
  if (cmd.op === 'submit') {
    await page.locator('button[type="submit"], input[type="submit"]').first().click();
    await page.waitForSelector('[data-signup-status="confirmed"]', { timeout: 10000 }).catch(() => undefined);
    return { ok: true };
  }
  if (cmd.op === 'close') {
    if (browser) await browser.close();
    browser = null;
    page = null;
    return { ok: true };
  }
  return failure('command_failed');
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_COMMAND_BYTES) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

if (process.argv[2] === '--exec') {
  const raw = readFileSync(process.argv[3], 'utf8');
  const response = await fetch('http://' + HOST + ':' + PORT + '/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: raw,
  });
  process.stdout.write(await response.text());
  process.exit(response.ok ? 0 : 1);
}

if (process.argv[2] === '--daemon') {
  const server = http.createServer(async (req, res) => {
    const remote = req.socket.remoteAddress || '';
    if (remote !== '127.0.0.1' && remote !== '::1' && remote !== '::ffff:127.0.0.1') {
      res.writeHead(403);
      res.end();
      return;
    }
    try {
      const raw = await readBody(req);
      if (raw === null) {
        res.writeHead(413, { 'content-type': 'application/json' });
        res.end(JSON.stringify(failure('command_failed')));
        return;
      }
      const result = await dispatch(JSON.parse(raw));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify(failure('command_failed')));
    }
  });
  server.listen(PORT, HOST);
} else {
  process.stderr.write('signup hands: expected --daemon or --exec\\n');
  process.exit(1);
}
`;
  if (/process\.env|VERCEL_TOKEN|VERCEL_OIDC|ANTHROPIC|DATABASE_URL|AUTHORIZATION/i.test(source)) {
    throw new Error('signup hands script included a secret-shaped reference');
  }
  return source;
}
