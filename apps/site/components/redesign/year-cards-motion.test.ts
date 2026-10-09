import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import LandingPage from '../../app/[locale]/page.js';

/**
 * The four #the-year cards play through HomeMotion, the gallery's engine.
 * Hale lines type first. Reminds' calendar row and Asks' Remembered chip
 * are the last step, and they sit outside the thread so the settled frame
 * is the static Messages layout.
 */

const home = readFileSync(fileURLToPath(new URL('./home.tsx', import.meta.url)), 'utf8');
const motion = readFileSync(fileURLToPath(new URL('./home-motion.tsx', import.meta.url)), 'utf8');
const css = readFileSync(fileURLToPath(new URL('../../app/redesign.css', import.meta.url)), 'utf8');

afterEach(() => {
  vi.unstubAllEnvs();
});

async function year(): Promise<string> {
  vi.stubEnv('NEXT_PUBLIC_HALE_SMS_NUMBER', '+16475551234');
  const html = renderToStaticMarkup(await LandingPage({ params: Promise.resolve({ locale: 'en' }) }));
  const start = html.indexOf('id="the-year"');
  const end = html.indexOf('id="logistics"');
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return html.slice(start, end);
}

function beats(section: string): string[] {
  return section.split('class="hs-beat ').slice(1);
}

function steps(beat: string): string[] {
  return [...beat.matchAll(/data-motion-step="([^"]+)"/g)].map((match) => match[1] ?? '');
}

it('gives each year card one gallery chat scene and types Hale before the line', async () => {
  const cards = beats(await year());
  expect(cards).toHaveLength(4);
  for (const card of cards) {
    expect(card.match(/data-motion-scene="chat"/g)).toHaveLength(1);
  }

  const [finds, watches, reminds, asks] = cards;
  if (!finds || !watches || !reminds || !asks) throw new Error('four cards');

  expect(steps(finds)).toEqual(['0.4']);
  expect(finds.match(/data-motion-typing/g)).toHaveLength(1);
  expect(finds).toContain('class="im-screen" data-motion-scene="chat"');
  expect(finds).not.toContain('im-run out');

  expect(steps(watches)).toEqual(['0.4']);
  expect(watches.match(/data-motion-typing/g)).toHaveLength(1);
  expect(watches).toContain('class="im-screen" data-motion-scene="chat"');
  expect(watches).toContain('class="im-link"');
  expect(watches).toContain('sign-up page');

  expect(steps(reminds)).toEqual(['0.4', '1.4']);
  expect(reminds.match(/data-motion-typing/g)).toHaveLength(1);
  expect(reminds).toContain('data-motion-scene="chat"');
  expect(reminds).toContain('</div></div><div class="im-event" data-motion-step="1.4">');
  expect(reminds).not.toContain('hs-did');

  expect(steps(asks)).toEqual(['0.4', '1.4', '2.4', '3.2']);
  expect(asks.match(/data-motion-typing/g)).toHaveLength(2);
  expect(asks).toContain(
    '<div class="im-run out" data-motion-step="1.4"><div class="im-b out tail">',
  );
  expect(asks).toContain('class="hs-did" data-motion-step="3.2"');
  expect(asks).toContain('</div></div><div class="im-chips">');
});

it('keeps the year-card sentences and leaves HomeMotion as the only player', () => {
  expect(home).toContain(
    'Here’s what’s on near you this week:\\n1. Parent & tot swim (ages 2–4), Sat 9:15 a.m.\\n2. Library storytime (ages 2–5), Tue 10:30 a.m.\\n3. Little movers (ages 2–5), winter times not posted yet',
  );
  expect(home).toContain('A spot just opened');
  expect(home).toContain('Tomorrow: fall programs at the rec centre open 7:00 a.m. for Mia. Sign in tonight and have the page open.');
  expect(home).toContain('Remembered: Mia loves swim');
  expect(motion.match(/new IntersectionObserver/g)).toHaveLength(1);
  expect(motion).toContain('isChat(scene) ? chatStep : step');
  expect(motion).not.toContain('--oct-year');

  const typing = css.match(/\.rd \.im-run > \.im-typing \{[^}]*\}/)?.[0] ?? '';
  expect(typing).toContain('position: absolute');
  expect(css).toContain('@media (prefers-reduced-motion: reduce) {\n  .rd .im-typing { display: none; }\n}');
});
