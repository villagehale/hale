import type { RawPageSnapshot } from '../snapshot-in-page';
import type { PageControl } from '../types';

/**
 * The only bytes a signup hands runtime accepts.
 *
 * One command, one result. No identity object, no tokens, no family row.
 * `ping` is the daemon health check and carries nothing.
 */
export type SignupHandsCommand =
  | { op: 'ping' }
  | { op: 'open'; url: string }
  | { op: 'snapshot' }
  | { op: 'fill'; name: string; value: string }
  | { op: 'select'; name: string; value: string }
  | { op: 'continue' }
  | { op: 'submit' }
  | { op: 'close' };

export type HandsFailure = 'url_refused' | 'command_failed';

export type HandsResponse =
  | { ok: true; snapshot?: RawPageSnapshot }
  | { ok: false; error: HandsFailure };

/** A running hands process. `stop` ends the runtime even if a command failed. */
export interface SignupHandsSession {
  exec(command: SignupHandsCommand): Promise<HandsResponse>;
  stop(): Promise<void>;
}

/** JSON written into the runtime. Extra fields on the command object are dropped. */
export function encodeHandsCommand(command: SignupHandsCommand): string {
  switch (command.op) {
    case 'ping':
    case 'snapshot':
    case 'continue':
    case 'submit':
    case 'close':
      return JSON.stringify({ op: command.op });
    case 'open':
      return JSON.stringify({ op: 'open', url: command.url });
    case 'fill':
      return JSON.stringify({ op: 'fill', name: command.name, value: command.value });
    case 'select':
      return JSON.stringify({ op: 'select', name: command.name, value: command.value });
  }
}

export function parseHandsResponse(text: string): HandsResponse | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const row = parsed as Record<string, unknown>;
  if (row.ok === false) {
    if (row.error === 'url_refused' || row.error === 'command_failed') {
      return { ok: false, error: row.error };
    }
    return { ok: false, error: 'command_failed' };
  }
  if (row.ok !== true) return null;
  if (row.snapshot === undefined) return { ok: true };
  const snapshot = parseRawSnapshot(row.snapshot);
  if (!snapshot) return null;
  return { ok: true, snapshot };
}

function parseRawSnapshot(value: unknown): RawPageSnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  if (typeof row.href !== 'string') return null;
  if (typeof row.captcha !== 'boolean') return null;
  if (typeof row.confirmed !== 'boolean') return null;
  if (typeof row.formText !== 'string') return null;
  if (typeof row.waitingRoom !== 'boolean') return null;
  if (typeof row.submitLabel !== 'string') return null;
  if (typeof row.bodyText !== 'string') return null;
  if (!Array.isArray(row.priceCents) || row.priceCents.some((item) => typeof item !== 'number')) {
    return null;
  }
  if (!Array.isArray(row.controls)) return null;
  const controls: PageControl[] = [];
  for (const item of row.controls) {
    const control = parseControl(item);
    if (!control) return null;
    controls.push(control);
  }
  return {
    href: row.href,
    controls,
    priceCents: row.priceCents as number[],
    captcha: row.captcha,
    confirmed: row.confirmed,
    formText: row.formText,
    waitingRoom: row.waitingRoom,
    submitLabel: row.submitLabel,
    bodyText: row.bodyText,
  };
}

function parseControl(value: unknown): PageControl | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  if (typeof row.name !== 'string' || typeof row.type !== 'string') return null;
  if (typeof row.required !== 'boolean' || typeof row.label !== 'string') return null;
  if (row.autocomplete !== null && typeof row.autocomplete !== 'string') return null;
  if (!Array.isArray(row.options)) return null;
  const options = [];
  for (const item of row.options) {
    if (!item || typeof item !== 'object') return null;
    const option = item as Record<string, unknown>;
    if (typeof option.value !== 'string' || typeof option.label !== 'string') return null;
    if (typeof option.disabled !== 'boolean') return null;
    options.push({ value: option.value, label: option.label, disabled: option.disabled });
  }
  return {
    name: row.name,
    type: row.type,
    required: row.required,
    label: row.label,
    autocomplete: row.autocomplete,
    options,
  };
}
