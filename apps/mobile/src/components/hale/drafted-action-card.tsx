import { useState } from 'react';
import { Pressable, View } from 'react-native';

import { AppText } from '@/components/ui/app-text';
import { Icon, type IconName } from '@/components/ui/icon';
import { LogoMark } from '@/components/ui/logo-mark';
import { useMeadowColor } from '@/constants/meadow';
import { API_BASE, ApiError, signalUnauthorized } from '@/lib/api-client';
import { approveResult, approvedPostState, declineResult } from '@/lib/approval-gate';
import type { ActionIntent } from '@/lib/coach-api';
import { TOKEN_KEY, tokenStorage } from '@/lib/token-storage';

/**
 * The in-thread DRAFTED-ACTION card (mockup screen 1, generalized) — what a gated
 * action chip becomes once it drafts. It shows the draft the parent is deciding on:
 * an eyebrow with the action category, the action's one-line summary, a quiet
 * provenance note (this came from the conversation), and inline Deny / Approve.
 *
 * Rules #3/#4/#6: Approve → POST /api/actions/:id/approve and Deny →
 * /api/actions/:id/decline go through the SAME shipping, audited, reviewer-gated
 * routes as the Approvals surface — this card adds no path that mutates action
 * state directly, and the reviewer-verdict guard stays server-side. Rule #1: it
 * renders only the already-safe intent label + the sourceAnswer that streamed to
 * this same thread — it never fetches the drafted payload, so no raw child/teen
 * content reaches here.
 *
 * Honest post-state (the whole point): on approve it settles to approvedPostState
 * for the action type — "Hale is on it" ONLY for a wired executor (email / digest /
 * routine); an unwired one (calendar et al.) reads "…as integrations come online".
 * Never a fake "Done"/"Scheduled" the executor would refuse. Errors are surfaced +
 * retryable (CLAUDE.md #8); only a 401 returns silently (bounces to sign-in).
 */

type Status = 'idle' | 'approving' | 'declining' | 'approved' | 'dismissed' | 'error';

/** POST to an action route with the Bearer token; returns the HTTP status. Mirrors
 * the status-inspecting fetch the approval contract turns on (bypasses api() to
 * read the exact code). A 401 throws (bounces to sign-in); a network failure
 * throws an ApiError(0). */
async function postAction(path: string): Promise<number> {
  if (!API_BASE) throw new ApiError(0, 'API base URL is not configured.');
  const token = await tokenStorage.get(TOKEN_KEY);
  const headers: Record<string, string> = { accept: 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new ApiError(0, 'Network error — check your connection and try again.');
  }
  if (res.status === 401) {
    await signalUnauthorized();
    throw new ApiError(401, 'Your session has expired. Please sign in again.');
  }
  return res.status;
}

/** The action's category for the eyebrow ("create_calendar_event" → "Calendar").
 * A small curated map keeps the eyebrow a category, not a full verb phrase (the
 * label below carries the verb). An unknown type degrades to neutral copy — never
 * the de-underscored token, which would surface an internal enum verbatim (the
 * label-layer hard rule; see apps/web/lib/format/labels.ts). */
const CATEGORY_LABEL: Record<string, string> = {
  create_calendar_event: 'Calendar',
  update_calendar_event: 'Calendar',
  send_email: 'Email',
  reply_to_email: 'Email',
  add_to_digest_only: 'Daily digest',
  add_to_routine: 'Routine',
  place_supply_order: 'Supplies',
};

const CATEGORY_FALLBACK = 'Action';

function categoryLabel(actionType: string): string {
  return CATEGORY_LABEL[actionType] ?? CATEGORY_FALLBACK;
}

/** The eyebrow glyph per action category — the prototype leads its "Adding to your
 * schedule" card with the same calendar mark. Unknown types fall back to a neutral
 * check-circle (never a raw enum). */
const CATEGORY_ICON: Record<string, IconName> = {
  create_calendar_event: 'calendar',
  update_calendar_event: 'calendar',
  send_email: 'mail',
  reply_to_email: 'mail',
  add_to_digest_only: 'file-text',
  add_to_routine: 'clock',
  place_supply_order: 'credit-card',
};

function categoryIcon(actionType: string): IconName {
  return CATEGORY_ICON[actionType] ?? 'circle-check';
}

/** The provenance note — a short, quiet slice of the answer that implied this
 * draft, so the parent sees WHY Hale suggested it. Trimmed to one legible line;
 * empty (no note rendered) when there's nothing meaningful to show. */
function provenanceNote(sourceAnswer: string): string | null {
  const trimmed = sourceAnswer.trim();
  if (!trimmed) return null;
  const oneLine = trimmed.replace(/\s+/g, ' ');
  return oneLine.length > 140 ? `${oneLine.slice(0, 139)}…` : oneLine;
}

interface DetailRow {
  icon: IconName;
  text: string;
}

/** A weekday/month or a clock time embedded in the label. Best-effort — the label
 * is the only rule-#1-safe source (the raw drafted payload is off-limits; see the
 * component doc), so a row only appears when the safe label itself carries it. */
const DATE_RE =
  /\b(?:mon|tue|wed|thu|fri|sat|sun|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?(?:\s+\d{1,2})?\b/i;
const TIME_RE = /\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/i;

/**
 * Split the teen-safe intent LABEL into icon-led detail rows. Rule #1: this reads
 * ONLY intent.label (already redacted and rendered) — it never reaches into the
 * drafted payload, so no raw child/teen content can leak here. Today's labels are
 * fixed verb phrases with no date/time (see action-intent.ts), so this returns a
 * single labelled FRAME row; the calendar/clock rows light up automatically only if
 * a future label carries that text. The frame is the fidelity win either way.
 */
function detailRows(label: string): DetailRow[] {
  const rows: DetailRow[] = [];
  const date = label.match(DATE_RE);
  const time = label.match(TIME_RE);
  if (date) rows.push({ icon: 'calendar', text: date[0] });
  if (time) rows.push({ icon: 'clock', text: time[0] });
  if (rows.length === 0) rows.push({ icon: 'calendar', text: label });
  return rows;
}

export function DraftedActionCard({
  actionId,
  intent,
  sourceAnswer,
}: {
  actionId: string;
  intent: ActionIntent;
  sourceAnswer: string;
}) {
  const [status, setStatus] = useState<Status>('idle');
  const busy = status === 'approving' || status === 'declining';
  const rowIconColor = useMeadowColor('ink3');
  const eyebrowColor = useMeadowColor('accentFill');
  const approveCheck = useMeadowColor('onAccent');

  const approve = async () => {
    if (busy) return;
    setStatus('approving');
    try {
      setStatus(approveResult(await postAction(`/api/actions/${actionId}/approve`)));
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return;
      setStatus('error');
    }
  };

  const reject = async () => {
    if (busy) return;
    setStatus('declining');
    try {
      setStatus(declineResult(await postAction(`/api/actions/${actionId}/decline`)));
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return;
      setStatus('error');
    }
  };

  if (status === 'dismissed') return null;

  if (status === 'approved') {
    return (
      <View className="mb-3 max-w-[92%] flex-row gap-2.5 self-start">
        <LogoMark size={24} />
        <View className="flex-1 rounded-[12px] bg-sage-tint px-3 py-2.5">
          <AppText variant="meta" className="text-sage">
            {approvedPostState(intent.actionType)}
          </AppText>
        </View>
      </View>
    );
  }

  const errored = status === 'error';
  const note = provenanceNote(sourceAnswer);
  const rows = detailRows(intent.label);

  return (
    <View className="mb-3 max-w-[92%] flex-row gap-2.5 self-start">
      <LogoMark size={24} />
      <View className="flex-1 rounded-[20px] border border-rule bg-card px-4 py-3.5">
        <View className="mb-2.5 flex-row items-center gap-2">
          <Icon name={categoryIcon(intent.actionType)} size={13} color={eyebrowColor} />
          <AppText variant="eyebrow" className="text-accent">
            {categoryLabel(intent.actionType)}
          </AppText>
        </View>
        <View className="gap-1.5">
          {rows.map((row) => (
            <View key={row.text} className="flex-row items-center gap-2">
              <Icon name={row.icon} size={14} color={rowIconColor} />
              <AppText variant="body" className="flex-1 text-ink">
                {row.text}
              </AppText>
            </View>
          ))}
        </View>
        {note ? (
          <View className="mt-3 rounded-[12px] bg-canvas px-3 py-2.5">
            <AppText variant="meta" className="text-ink-3">
              {note}
            </AppText>
          </View>
        ) : null}

        {errored ? (
          <AppText variant="meta" className="mt-2 text-berry" accessibilityLiveRegion="polite">
            Something went wrong. Try again.
          </AppText>
        ) : null}

        <View className="mt-3.5 flex-row gap-2">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Deny this action"
            accessibilityState={{ disabled: busy }}
            disabled={busy}
            onPress={reject}
            className={`flex-1 items-center justify-center rounded-[12px] border border-rule bg-card py-3 ${
              busy ? 'opacity-50' : 'active:opacity-80'
            }`}
          >
            <AppText variant="meta" className="text-ink">
              {status === 'declining' ? 'Denying…' : 'Deny'}
            </AppText>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Approve this action"
            accessibilityState={{ disabled: busy }}
            disabled={busy}
            onPress={approve}
            className={`flex-1 flex-row items-center justify-center gap-1.5 rounded-[12px] bg-brand py-3 ${
              busy ? 'opacity-50' : 'active:opacity-90'
            }`}
          >
            <AppText variant="meta" className="text-on-ink">
              {status === 'approving' ? 'Approving…' : errored ? 'Try again' : 'Approve'}
            </AppText>
            {status === 'idle' ? <Icon name="check" size={13} color={approveCheck} /> : null}
          </Pressable>
        </View>
      </View>
    </View>
  );
}
