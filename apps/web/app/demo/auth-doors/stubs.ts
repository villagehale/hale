'use server';

import type { ResetPasswordState, ResetRequestState } from '~/lib/auth/auth-actions';
import {
  MAGIC_LINK_INVALID,
  PASSWORD_RESET_INVALID,
  PASSWORD_RESET_UNAVAILABLE,
} from '~/lib/auth/door-messages';
import type { MagicLinkRedeemState } from '~/lib/auth/magic-link-actions';

/** Preview-only. Returns the sent state and never looks up an account or sends mail. */
export async function demoForgotAction(
  _prev: ResetRequestState,
  _formData: FormData,
): Promise<ResetRequestState> {
  return { status: 'sent' };
}

export async function demoForgotErrorAction(
  _prev: ResetRequestState,
  _formData: FormData,
): Promise<ResetRequestState> {
  return { status: 'error', message: PASSWORD_RESET_UNAVAILABLE };
}

/** Preview-only. Never consumes a reset token. */
export async function demoResetAction(
  _prev: ResetPasswordState,
  _formData: FormData,
): Promise<ResetPasswordState> {
  return { status: 'error', message: PASSWORD_RESET_INVALID };
}

/** Preview-only. Never redeems a magic link. */
export async function demoMagicAction(
  _prev: MagicLinkRedeemState,
  _formData: FormData,
): Promise<MagicLinkRedeemState> {
  return { status: 'error', message: MAGIC_LINK_INVALID };
}

/** Preview-only. Does not post the consent decision. */
export async function demoConsentAction(_formData: FormData): Promise<void> {
  return;
}
