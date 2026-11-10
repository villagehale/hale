import { type RegisteredTool, type Skill, defineTool } from '@hale/agent';
import { z } from 'zod';
import type { DeferredCapability } from './registry';

/**
 * VIL-303 · the two verbs that make a stale no correctable.
 *
 * `note_capability_declined` is registered only while some deferred capability is dark,
 * and offers only the dark ones. `note_capability_correction` is registered only on a
 * turn that owes a correction, and offers only the owed ones. Each registers an intent;
 * the router writes the row after the reply is sent (capabilities/ledger.ts), so a reply
 * that never left records nothing.
 */

export const NOTE_DECLINED_TOOL = 'note_capability_declined';
export const NOTE_CORRECTION_TOOL = 'note_capability_correction';

/** What each key means, for the model choosing one. Not parent copy. */
const MEANING: Record<DeferredCapability, string> = {
  sign_up: 'completing a registration or sign-up for them (booking, enrolling, holding a spot)',
  spot_watch: 'watching a full class page and texting them when a spot opens',
};

/**
 * NOT registersOnly, unlike the promise verbs. Recorded live: with registersOnly the text
 * beside the call is the reply, and on a no the model wrote its reasoning there ("the
 * capability table says…, I'll record the decline") and that was the message. So the verb
 * is called first, its text is dropped as preamble, and the reply is the next turn's.
 */
const CALL_FIRST = 'Call it on its own, before you write the reply, then write the reply.';
const NOTED = { noted: true as const, next: 'Noted. Now write your reply to the parent.' };

function keys(capabilities: readonly DeferredCapability[]): string {
  return capabilities.map((capability) => `\`${capability}\`: ${MEANING[capability]}`).join('; ');
}

function capabilitySchema(capabilities: readonly DeferredCapability[]) {
  return z.object({
    capability: z.enum(capabilities as [DeferredCapability, ...DeferredCapability[]]),
  });
}

export function noteCapabilityDeclinedTool(args: {
  dark: readonly DeferredCapability[];
  onDeclined: (capability: DeferredCapability) => void;
}): RegisteredTool {
  return defineTool({
    name: NOTE_DECLINED_TOOL,
    description: `These are not something Hale can do for this family yet, whatever else you were told: ${keys(args.dark)}. Never offer one, and never say you are doing one. Call this, once per capability, only when your reply tells the parent that one of them is not something you can do. Say the no as the capability table says every no. Never tell them you will let them know when it changes or come back to them about it: Hale never texts first. ${CALL_FIRST}`,
    inputSchema: capabilitySchema(args.dark),
    monetary: false,
    touchesChildContent: false,
    handler: async (input) => {
      args.onDeclined(input.capability);
      return NOTED;
    },
  });
}

export function noteCapabilityCorrectionTool(args: {
  owed: readonly DeferredCapability[];
  onCorrected: (capability: DeferredCapability) => void;
}): RegisteredTool {
  return defineTool({
    name: NOTE_CORRECTION_TOOL,
    description: `Call this, once per capability, when your reply tells the parent that something you once said you could not do is now something you can: ${keys(args.owed)}. Also call it when the parent plainly already knows (they are using it right now). Do not call it for a correction your reply does not make. ${CALL_FIRST}`,
    inputSchema: capabilitySchema(args.owed),
    monetary: false,
    touchesChildContent: false,
    handler: async (input) => {
      args.onCorrected(input.capability);
      return NOTED;
    },
  });
}

/** Lists the registered verbs on the skill (toAnthropicTools sends only listed tools)
 * and appends the correction addendum when one is owed. A skill with neither is
 * returned as is, so an ordinary turn keeps its bytes. */
export function augmentCoachSkillForCapabilities(
  skill: Skill,
  registered: { declined: boolean; correction: Skill | null },
): Skill {
  const names = [
    ...(registered.declined ? [NOTE_DECLINED_TOOL] : []),
    ...(registered.correction ? [NOTE_CORRECTION_TOOL] : []),
  ].filter((name) => !skill.meta.tools.includes(name));
  if (names.length === 0 && !registered.correction) return skill;
  return {
    ...skill,
    meta: { ...skill.meta, tools: [...skill.meta.tools, ...names] },
    instructions: registered.correction
      ? `${skill.instructions}\n\n${registered.correction.instructions}`
      : skill.instructions,
  };
}
