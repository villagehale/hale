import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  PARTNERSHIP_BOOKED_LINE_FR,
  PARTNERSHIP_BOOKED_LINE_TODO,
  PARTNERSHIP_FAILED_LINE_FR,
  PARTNERSHIP_FAILED_LINE_TODO,
  partnershipBookedLine,
  partnershipFailedLine,
} from './copy';

const SIGNUP_DIR = fileURLToPath(new URL('..', import.meta.url));
const SEND_PATH = ['run.ts', 'copy.ts', 'handoff.ts', 'report.ts', 'handler.ts'];

describe('partnership booking copy', () => {
  it('keeps each locked line byte for byte and ASCII', () => {
    expect(PARTNERSHIP_BOOKED_LINE_TODO).toBe(
      'You\'re signed up for {session} with {provider}. Their confirmation is {ref}. Say "details" if you want what to bring.',
    );
    expect(PARTNERSHIP_BOOKED_LINE_FR).toBe(
      'C\'est fait pour {session} avec {provider}. Leur confirmation: {ref}. Dis "details" pour savoir quoi apporter.',
    );
    expect(PARTNERSHIP_FAILED_LINE_TODO).toBe(
      "I couldn't finish {session} with {provider}, so nothing is signed up. Here's the page if you'd like to do it yourself: {link}",
    );
    expect(PARTNERSHIP_FAILED_LINE_FR).toBe(
      "Je n'ai pas pu terminer {session} avec {provider}, donc rien n'est fait. Voici la page si tu veux le faire toi-meme: {link}",
    );
    for (const line of [
      PARTNERSHIP_BOOKED_LINE_TODO,
      PARTNERSHIP_BOOKED_LINE_FR,
      PARTNERSHIP_FAILED_LINE_TODO,
      PARTNERSHIP_FAILED_LINE_FR,
    ]) {
      expect(line).toMatch(/^[\x20-\x7E]+$/);
      expect(line).not.toMatch(/\bSTOP\b/);
      expect(line).not.toContain('TODO-Design');
    }
    expect(
      partnershipBookedLine({
        language: 'en',
        session: 'Tue swim',
        provider: 'The Y',
        ref: 'A1',
        confirmed: true,
      }),
    ).toEqual({
      body: 'You\'re signed up for Tue swim with The Y. Their confirmation is A1. Say "details" if you want what to bring.',
      mayLeave: true,
    });
    expect(
      partnershipBookedLine({
        language: 'fr',
        session: 'natation',
        provider: 'Le Y',
        ref: 'A1',
        confirmed: false,
      }).mayLeave,
    ).toBe(false);
    expect(
      partnershipFailedLine({
        language: 'en',
        session: 'Tue swim',
        provider: 'The Y',
        link: 'https://example.com/swim',
      }).body,
    ).toBe(
      "I couldn't finish Tue swim with The Y, so nothing is signed up. Here's the page if you'd like to do it yourself: https://example.com/swim",
    );
    expect(
      partnershipFailedLine({
        language: 'fr',
        session: 'natation',
        provider: 'Le Y',
        link: 'https://example.com/swim',
      }).body,
    ).toBe(
      "Je n'ai pas pu terminer natation avec Le Y, donc rien n'est fait. Voici la page si tu veux le faire toi-meme: https://example.com/swim",
    );
  });

  it('is never placed on a send path', () => {
    const files = readdirSync(SIGNUP_DIR).filter((name) => name.endsWith('.ts'));
    for (const name of SEND_PATH) expect(files).toContain(name);
    for (const name of SEND_PATH) {
      const source = readFileSync(`${SIGNUP_DIR}${name}`, 'utf8');
      expect(source, name).not.toContain('TODO-Design');
      expect(source, name).not.toContain(PARTNERSHIP_BOOKED_LINE_TODO);
      expect(source, name).not.toContain(PARTNERSHIP_FAILED_LINE_TODO);
      expect(source, name).not.toContain('PARTNERSHIP_BOOKED_LINE_TODO');
      expect(source, name).not.toContain('PARTNERSHIP_FAILED_LINE_TODO');
    }
  });
});
