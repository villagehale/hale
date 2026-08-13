import type { ChannelKind, LoopMessage, RenderedContent, TemplateRenderer } from './types';

/**
 * A placeholder renderer for the seam until per-template renderers land (B2/D1/E3
 * own templates/<key>/{sms,push,email}.ts). Real content — and any child name,
 * routed through loopChildName — is the template's job; this only lets the seam be
 * wired end-to-end today. It reads pre-rendered fields a caller sets on payload; it
 * never interpolates content into HTML (rule #1 + injection safety), so a caller that
 * wants markup brings its own.
 *
 * It REFUSES a payload with no words in it (rule #11). The generic line it used to
 * send instead — "You have a new update from Hale." — turned a wiring bug into a
 * delivered message: the dispatch recorded a success, the ledger recorded a send, and
 * the parent got a sentence that says nothing. A payload without text is a caller bug,
 * and the same throw-don't-degrade contract the weekly-plan payload narrowing already
 * keeps (`asWeeklyPlanPayload`).
 */
export const defaultLoopRenderer: TemplateRenderer = {
  render(message: LoopMessage, channel: ChannelKind): RenderedContent {
    const p = message.payload as Record<string, unknown>;
    if (typeof p.text !== 'string' || p.text.length === 0) {
      throw new Error(`default renderer: payload has no text (templateKey ${message.templateKey})`);
    }
    const text = p.text;
    if (channel === 'email') {
      if (typeof p.html !== 'string' || p.html.length === 0) {
        throw new Error(
          `default renderer: payload has no html (templateKey ${message.templateKey})`,
        );
      }
      return {
        kind: 'email',
        subject: typeof p.subject === 'string' ? p.subject : 'Hale',
        html: p.html,
        text,
      };
    }
    if (channel === 'sms') {
      return { kind: 'sms', text };
    }
    return { kind: 'push', title: typeof p.title === 'string' ? p.title : 'Hale', body: text };
  },
};
