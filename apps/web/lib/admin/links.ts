/**
 * Every external console the portal links out to, in one place — no magic IDs
 * inline (CLAUDE.md: pull from config or the existing source-of-truth). All of
 * these render as plain <a href> targets in Server Components; nothing here is
 * a secret (project refs and console URLs are addresses, not credentials).
 */

/** `https://<ref>.supabase.co` → `<ref>`, or null when SUPABASE_URL is unset/odd. */
export function supabaseProjectRef(url: string | undefined = process.env.SUPABASE_URL): string | null {
  if (!url) return null;
  try {
    const host = new URL(url).hostname;
    const ref = host.split('.')[0];
    return ref || null;
  } catch {
    return null;
  }
}

/** Table editor deep link, or the dashboard root when the ref is unknown. */
export function supabaseTableUrl(table: string): string {
  const ref = supabaseProjectRef();
  if (!ref) return 'https://supabase.com/dashboard';
  return `https://supabase.com/dashboard/project/${ref}/editor?table=${encodeURIComponent(table)}`;
}

export function posthogProjectId(): string | null {
  return process.env.POSTHOG_PROJECT_ID || null;
}

function posthogProjectUrl(path: string): string {
  const id = posthogProjectId();
  return id ? `https://us.posthog.com/project/${id}${path}` : 'https://us.posthog.com';
}

export function posthogInsightsUrl(): string {
  return posthogProjectUrl('/insights');
}

export function posthogReplayHomeUrl(): string {
  return posthogProjectUrl('/replay/home');
}

export function posthogReplayUrl(recordingId: string): string {
  return posthogProjectUrl(`/replay/${encodeURIComponent(recordingId)}`);
}

export const TWILIO_ERROR_LOGS_URL = 'https://console.twilio.com/us1/monitor/logs/errors';

export function langfuseHomeUrl(): string {
  return process.env.LANGFUSE_HOST || 'https://cloud.langfuse.com';
}

export const ANTHROPIC_USAGE_URL = 'https://console.anthropic.com/settings/usage';

export const SKILLS_REPO_URL = 'https://github.com/villagehale/hale/tree/main/packages/agent/skills';
