import type { ChannelKind, LoopMessage, RenderedContent, TemplateRenderer } from './types';

/**
 * A placeholder renderer for the seam until per-template renderers land (B2/D1/E3
 * own templates/<key>/{sms,push,email}.ts). Real content — and any child name,
 * routed through loopChildName — is the template's job; this only lets the seam be
 * wired end-to-end today. It reads pre-rendered fields a caller may set on payload,
 * with a static generic fallback (it never interpolates content into HTML — rule #1
 * + injection safety; a real template owns its markup).
 */
export const defaultLoopRenderer: TemplateRenderer = {
  render(message: LoopMessage, channel: ChannelKind): RenderedContent {
    const p = message.payload as Record<string, unknown>;
    const text = typeof p.text === 'string' ? p.text : 'You have a new update from Hale.';
    if (channel === 'email') {
      return {
        kind: 'email',
        subject: typeof p.subject === 'string' ? p.subject : 'Hale',
        html: typeof p.html === 'string' ? p.html : '<p>You have a new update from Hale.</p>',
        text,
      };
    }
    if (channel === 'sms') {
      return { kind: 'sms', text };
    }
    return { kind: 'push', title: typeof p.title === 'string' ? p.title : 'Hale', body: text };
  },
};
