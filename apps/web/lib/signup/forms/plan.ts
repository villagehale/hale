import type {
  FieldSlot,
  PageControl,
  PageSnapshot,
  SignupIdentity,
  SignupStopReason,
} from '../types';
import { classifyField } from './adapters';
import { noteStops, pageStops, waitlistControl } from './safety';

export interface FillInstruction {
  name: string;
  slot: FieldSlot;
  value: string;
  control: 'fill' | 'select';
}

export type Inspection =
  | { action: 'submit' | 'continue'; fills: FillInstruction[]; sessionControl: string | null }
  | { action: 'stop'; reason: SignupStopReason; prefilled: string[] };

export interface BookingStepInput {
  snapshot: PageSnapshot;
  identity: SignupIdentity;
  sessionId: string;
  sessionStartsAt: string | null;
  partySize: number | null;
  seatingNote: string | null;
  approvedPriceCents: number | null;
  expectedOrigin: string;
  /** True after an earlier step in this run selected the time slot. */
  sessionSelected: boolean;
}

const UNAVAILABLE = /\b(full|waitlist|sold out)\b/i;

/**
 * One step of a generic family booking.
 *
 * Adapters classify the controls. This plans the step: continue when the page
 * is only the date of a ticket cart, submit when the authorized slot is on the
 * page or a later page is the cart review. Rush signals (queue, captcha,
 * resident or identity verification, a timed open-at), payment, login, a
 * waiver, medical or allergy content, a waitlist, a price change, and a
 * required field Hale does not know are stops. Optional unknown fields are
 * left blank.
 */
export function planBookingStep(input: BookingStepInput): Inspection {
  const stopped = pageStops(input.snapshot, input.expectedOrigin, input.approvedPriceCents);
  if (stopped) return stop(stopped);

  const controls = input.snapshot.controls.filter((control) => !ignored(control));
  if (
    controls.some((control) => control.type === 'password' || classifyField(control) === 'login')
  ) {
    return stop('login_wall');
  }
  if (controls.some((control) => classifyField(control) === 'payment')) return stop('payment');
  if (controls.some((control) => waitlistControl(control))) return stop('session_full');

  const sessionControls = controls.filter((control) => classifyField(control) === 'session');
  const dateControls = controls.filter((control) => classifyField(control) === 'visit_date');
  if (sessionControls.length > 1 || dateControls.length > 1) return stop('unexpected_field');

  const fills: FillInstruction[] = [];
  let mode: 'submit' | 'continue' = 'submit';
  const sessionControl = sessionControls[0] ?? null;
  const dateControl = dateControls[0] ?? null;

  if (sessionControl) {
    const chosen = sessionControl.options.find((item) => item.value === input.sessionId);
    if (!chosen) return stop('session_not_offered');
    if (chosen.disabled || UNAVAILABLE.test(chosen.label)) return stop('session_full');
    fills.push({
      name: sessionControl.name,
      slot: 'session',
      value: input.sessionId,
      control: 'select',
    });
    if (dateControl) {
      const dated = dateFill(dateControl, input.sessionStartsAt);
      if (dated.action === 'stop') return dated;
      fills.push(dated.fill);
    }
  } else if (dateControl) {
    const dated = dateFill(dateControl, input.sessionStartsAt);
    if (dated.action === 'stop') return dated;
    fills.push(dated.fill);
    mode = 'continue';
  } else if (!input.sessionSelected) {
    return stop('unexpected_field');
  }

  for (const control of controls) {
    if (control === sessionControl || control === dateControl) continue;
    const kind = classifyField(control);
    if (kind === 'unknown') {
      if (control.required) return stop('unexpected_field');
      continue;
    }
    if (kind === 'session' || kind === 'payment' || kind === 'login' || kind === 'visit_date') {
      continue;
    }
    if (!control.required) continue;
    const resolved = valueFor(kind, control, input);
    if (typeof resolved !== 'string') return resolved;
    fills.push({
      name: control.name,
      slot: kind,
      value: resolved,
      control: control.type === 'select' ? 'select' : 'fill',
    });
  }

  if (sessionControl && continues(input.snapshot.submitLabel)) mode = 'continue';
  return { action: mode, fills, sessionControl: sessionControl?.name ?? null };
}

function continues(label: string | null | undefined): boolean {
  return /^\s*(continue|next|proceed)\s*$/i.test(label ?? '');
}

function dateFill(
  control: PageControl,
  startsAt: string | null,
): { action: 'fill'; fill: FillInstruction } | Inspection {
  const date = /^(\d{4}-\d{2}-\d{2})/.exec(startsAt ?? '')?.[1] ?? null;
  if (!date) return stop('missing_detail');
  if (control.type === 'select' || control.options.length > 0) {
    const option = control.options.find((item) => item.value === date);
    if (!option) return stop('session_not_offered');
    if (option.disabled || UNAVAILABLE.test(option.label)) return stop('session_full');
  }
  return {
    action: 'fill',
    fill: {
      name: control.name,
      slot: 'visit_date',
      value: date,
      control: control.type === 'select' || control.options.length > 0 ? 'select' : 'fill',
    },
  };
}

function valueFor(
  slot: FieldSlot,
  control: PageControl,
  input: BookingStepInput,
): string | Inspection {
  switch (slot) {
    case 'child_first_name':
      return requiredText(input.identity.childFirstName);
    case 'child_last_name':
      return requiredText(input.identity.childLastName);
    case 'child_dob':
      return requiredText(input.identity.childDob);
    case 'parent_first_name':
      return requiredText(input.identity.parentFirstName);
    case 'parent_email':
      return requiredText(input.identity.parentEmail);
    case 'postal_code':
      return requiredText(input.identity.postalCode);
    case 'visit_date':
    case 'session':
      return stop('unexpected_field');
    case 'party_size':
      return partyValue(control, input.partySize);
    case 'seating_note':
      return noteValue(input.seatingNote);
  }
}

function partyValue(control: PageControl, partySize: number | null): string | Inspection {
  if (partySize === null) return stop('missing_detail');
  const value = String(partySize);
  if (
    control.options.length > 0 &&
    !control.options.some((item) => item.value === value && !item.disabled)
  ) {
    return stop('missing_detail');
  }
  return value;
}

function noteValue(seatingNote: string | null): string | Inspection {
  const note = seatingNote?.trim() ?? '';
  if (note.length === 0 || note.length > 80) return stop('missing_detail');
  const sensitive = noteStops(note);
  if (sensitive) return stop(sensitive);
  return note;
}

function requiredText(value: string | null): string | Inspection {
  const trimmed = value?.trim() ?? '';
  if (trimmed.length === 0) return stop('missing_detail');
  return trimmed;
}

function ignored(control: PageControl): boolean {
  return control.type === 'hidden' || control.type === 'submit' || control.type === 'button';
}

function stop(reason: SignupStopReason): Inspection {
  return { action: 'stop', reason, prefilled: [] };
}
