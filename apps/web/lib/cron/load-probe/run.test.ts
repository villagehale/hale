import { describe, expect, it } from 'vitest';
import { ProbeTargetRefused, assertLocalProbeDatabase } from './run';

describe('assertLocalProbeDatabase', () => {
  it('accepts a local Postgres', () => {
    expect(() => assertLocalProbeDatabase('postgres://probe@localhost:54329/probe')).not.toThrow();
    expect(() => assertLocalProbeDatabase('postgres://probe@127.0.0.1:5432/probe')).not.toThrow();
  });

  it('refuses every remote host, the pooler included', () => {
    for (const url of [
      'postgres://u:p@pooler.example.com:5432/postgres',
      'postgres://u:p@db.example.supabase.co:5432/postgres',
      'postgres://u:p@localhost.example.com:5432/postgres',
      'not a url',
    ]) {
      expect(() => assertLocalProbeDatabase(url)).toThrow(ProbeTargetRefused);
    }
  });
});
