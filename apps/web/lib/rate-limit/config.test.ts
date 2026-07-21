import { describe, expect, it } from 'vitest';
import { RATE_LIMITS } from './config';

/**
 * The caps are a SILENT guard — invisible to real users, tripped only by bots and
 * runaway loops. This pins them above the realistic-peak envelope documented in
 * config.ts so an edit can't quietly drop a cap to a level a real family would hit.
 * The floors are the envelope reasoning, not the current values, so a future
 * tightening toward a human's peak fails here on purpose.
 */
describe('RATE_LIMITS — generous enough to stay invisible', () => {
  it('keeps the coach caps far above a human burst (~5-10/min)', () => {
    expect(RATE_LIMITS.coach.limit).toBeGreaterThanOrEqual(40);
    expect(RATE_LIMITS['coach-action'].limit).toBeGreaterThanOrEqual(40);
  });

  it('keeps the ingest cap above a real forwarder yet under a flood', () => {
    expect(RATE_LIMITS.ingest.limit).toBeGreaterThanOrEqual(100);
  });

  it('caps village-search as a paid run: a small per-hour cooldown, not a per-minute burst', () => {
    // Unlike the other routes (silent bot guards on a 1-minute window), a village
    // search triggers a billable LLM discovery, so its cap is a genuine COOLDOWN a
    // curious parent could reach — a handful per hour. Pinned to an hour window and
    // a single-digit cap so an edit can't quietly turn it into a per-minute floodgate.
    expect(RATE_LIMITS['village-search'].windowSec).toBe(3600);
    expect(RATE_LIMITS['village-search'].limit).toBeGreaterThanOrEqual(3);
    expect(RATE_LIMITS['village-search'].limit).toBeLessThanOrEqual(10);
  });

  it('caps avatar-upload on an hour window — a photo is set once and rarely replaced, so a script, not a parent, trips it', () => {
    // Not a per-minute burst guard: uploading child photos is infrequent, so the
    // storage-abuse cap sits on an HOUR window, generous for a parent tidying a few
    // kids' photos yet well under a scripted flood.
    expect(RATE_LIMITS['avatar-upload'].windowSec).toBe(3600);
    expect(RATE_LIMITS['avatar-upload'].limit).toBeGreaterThanOrEqual(10);
  });

  it('guards the AI-search intent parse as a generous per-minute bot guard, not the paid cooldown', () => {
    // The natural-language search's per-submit intent parse is a CHEAP model call;
    // the expensive discovery it may trigger is separately bounded by village-search
    // (5/hour). So this stays a per-minute guard on a burst, generous enough that a
    // parent exploring phrasings never hits it — only a scripted loop does.
    expect(RATE_LIMITS['village-ai-search'].windowSec).toBe(60);
    expect(RATE_LIMITS['village-ai-search'].limit).toBeGreaterThanOrEqual(15);
  });

  it('uses a one-minute window for every route except the hour-window cooldowns (village-search, avatar-upload)', () => {
    const hourWindow = new Set(['village-search', 'avatar-upload']);
    for (const [route, opts] of Object.entries(RATE_LIMITS)) {
      if (hourWindow.has(route)) continue;
      expect(opts.windowSec).toBe(60);
    }
  });
});
