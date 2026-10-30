import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { applyAttachmentMarkers, attachmentContentBlock } from './attachment-blocks';

/**
 * The pure model-input helpers — no LLM, no DB, fully deterministic (rule #8: the
 * agent's QUALITY is an eval; THIS proves the byte→content-block mapping and the
 * past-turn marker mechanically). Load-bearing: an image must ride as a native image
 * block and a PDF as a native document block, or the model can't see the attachment;
 * a HEIC (which the Anthropic image block can't carry) must degrade to a text marker
 * rather than a rejected request.
 */

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x01, 0x02]);
const PDF = Buffer.from('%PDF-1.7 hello', 'ascii');

describe('attachmentContentBlock', () => {
  it('maps image bytes to a native base64 image block', () => {
    const block = attachmentContentBlock(JPEG, 'image/jpeg') as Anthropic.ImageBlockParam;
    expect(block.type).toBe('image');
    const source = block.source as Anthropic.Base64ImageSource;
    expect(source.type).toBe('base64');
    expect(source.media_type).toBe('image/jpeg');
    expect(source.data).toBe(JPEG.toString('base64'));
  });

  it('maps webp the same way (chat allows webp; docs did not)', () => {
    const block = attachmentContentBlock(Buffer.from('RIFF'), 'image/webp') as Anthropic.ImageBlockParam;
    expect(block.type).toBe('image');
    expect((block.source as Anthropic.Base64ImageSource).media_type).toBe('image/webp');
  });

  it('maps PDF bytes to a native base64 document block', () => {
    const block = attachmentContentBlock(PDF, 'application/pdf') as Anthropic.DocumentBlockParam;
    expect(block.type).toBe('document');
    const source = block.source as Anthropic.Base64PDFSource;
    expect(source.type).toBe('base64');
    expect(source.media_type).toBe('application/pdf');
    expect(source.data).toBe(PDF.toString('base64'));
  });

  it('degrades HEIC to a text marker — the Anthropic image block cannot carry heic, so bytes are NEVER sent', () => {
    const block = attachmentContentBlock(JPEG, 'image/heic') as Anthropic.TextBlockParam;
    expect(block.type).toBe('text');
    expect(block.text).toContain('image/heic');
    // The base64 bytes must not leak into the text marker.
    expect(block.text).not.toContain(JPEG.toString('base64'));
  });
});

describe('applyAttachmentMarkers', () => {
  const userRow = { id: 'm1', role: 'user' as const, content: 'look at this' };
  const rows = [
    userRow,
    { id: 'm2', role: 'assistant' as const, content: 'here is what I see' },
    { id: 'm3', role: 'user' as const, content: '' },
  ];

  it('appends a [attachment: <mime>] marker to past messages that carried attachments', () => {
    const mimes = new Map<string, string[]>([
      ['m1', ['image/jpeg']],
      ['m3', ['application/pdf', 'image/png']],
    ]);
    const out = applyAttachmentMarkers(rows, mimes);
    expect(out).toEqual([
      { role: 'user', content: 'look at this [attachment: image/jpeg]' },
      { role: 'assistant', content: 'here is what I see' },
      { role: 'user', content: '[attachment: application/pdf] [attachment: image/png]' },
    ]);
  });

  it('drops the message id and never re-sends bytes — a marker is text only', () => {
    const out = applyAttachmentMarkers([userRow], new Map([['m1', ['image/jpeg']]]));
    expect(out[0]).not.toHaveProperty('id');
    expect(JSON.stringify(out)).not.toContain('base64');
  });
});
