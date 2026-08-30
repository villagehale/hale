import { afterEach, describe, expect, it } from 'vitest';
import { supabaseProjectRef, supabaseTableUrl } from './links';

afterEach(() => {
  process.env.SUPABASE_URL = '';
});

describe('supabaseProjectRef', () => {
  it('derives the ref from the SUPABASE_URL host', () => {
    expect(supabaseProjectRef('https://abcdefghijkl.supabase.co')).toBe('abcdefghijkl');
  });

  it('is null when unset or unparseable — the link degrades, never throws', () => {
    expect(supabaseProjectRef(undefined)).toBeNull();
    expect(supabaseProjectRef('')).toBeNull();
    expect(supabaseProjectRef('not a url')).toBeNull();
  });
});

describe('supabaseTableUrl', () => {
  it('deep-links the table editor when the ref is known', () => {
    process.env.SUPABASE_URL = 'https://abcdefghijkl.supabase.co';
    expect(supabaseTableUrl('channel_messages')).toBe(
      'https://supabase.com/dashboard/project/abcdefghijkl/editor?table=channel_messages',
    );
  });

  it('falls back to the dashboard root when SUPABASE_URL is unset', () => {
    process.env.SUPABASE_URL = '';
    expect(supabaseTableUrl('families')).toBe('https://supabase.com/dashboard');
  });
});
