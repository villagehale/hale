import type { VoiceTurnStream } from './relay-session';

/**
 * M0 SPIKE ARTIFACT — delete when the real turn lands (M1).
 *
 * The one question M0 exists to answer is whether a Next.js App Router route on Vercel
 * Fluid can host a ConversationRelay socket at all, and the answer is not "it upgraded".
 * The real turn does its work AFTER the upgrade handler has already returned: tokens
 * arrive from Anthropic hundreds of milliseconds later, on a listener the platform is
 * keeping alive on our behalf. A synchronous echo would prove none of that and would
 * pass just as happily on a runtime where the instance freezes the moment the handler
 * resolves.
 *
 * So this echo AWAITS a real timer before it says anything. If the caller hears their
 * own words back, post-return async work survives on this runtime and the architecture
 * holds. If they hear silence, it does not, and no amount of building on top would have
 * changed that.
 */
const SPIKE_DELAY_MS = 400;

export function echoVoiceTurn(): VoiceTurnStream {
  return {
    async respond(input, emit) {
      await new Promise((resolve) => setTimeout(resolve, SPIKE_DELAY_MS));
      emit('You said: ');
      await new Promise((resolve) => setTimeout(resolve, SPIKE_DELAY_MS));
      emit(input.prompt);
    },
  };
}
