import { describe, expect, it, vi } from 'vitest';
import type { DiscoveryAnthropicClient } from './discover.js';
import { type PreviewDeps, discoverPreview } from './preview.js';

/** A fake Anthropic client returning a forced submit_candidates tool_use. */
function fakeClient(candidates: unknown[]) {
  const create = vi.fn().mockResolvedValue({
    content: [{ type: 'tool_use', name: 'submit_candidates', input: { candidates } }],
    usage: { input_tokens: 10, output_tokens: 20 },
  });
  const client = { messages: { create } } as unknown as DiscoveryAnthropicClient;
  return { client, create };
}

function deps(client: DiscoveryAnthropicClient): PreviewDeps {
  return {
    client,
    loadPrompt: async () => 'DISCOVERY SYSTEM PROMPT',
    loadModel: async () => 'claude-test-model',
  };
}

const SAMPLE = [
  {
    title: 'Parent-and-tot swim',
    description: 'A water-comfort class for toddlers at a municipal pool.',
    confidence: 0.65,
    coverageNote: 'municipal pools commonly offer this; sessions are seasonal.',
  },
  {
    title: 'Neighbourhood park and playground',
    description: 'Unstructured outdoor play at a local park.',
    sourceUrl: 'https://example.org/park',
    confidence: 0.8,
    coverageNote: 'public parks exist in essentially every area.',
  },
];

describe('discoverPreview — pre-auth, no-DB value sample (rule #1)', () => {
  it('sends the model ONLY the coarse area + stage + interests — no name, DOB, address, or familyId', async () => {
    const c = fakeClient(SAMPLE);

    await discoverPreview(
      { stage: 'toddler', areaCoarse: 'M5V', interests: ['water', 'music'] },
      deps(c.client),
    );

    expect(c.create).toHaveBeenCalledTimes(1);
    const sentUser = c.create.mock.calls[0]?.[0]?.messages?.[0]?.content as string;
    expect(JSON.parse(sentUser)).toEqual({
      area_coarse: 'M5V',
      stage: 'toddler',
      interests: ['water', 'music'],
      limit: 8,
    });
  });

  it('projects candidates onto the closed preview shape — no ids, childId, or familyId leak', async () => {
    const c = fakeClient(SAMPLE);

    const activities = await discoverPreview(
      { stage: 'toddler', areaCoarse: 'M5V', interests: [] },
      deps(c.client),
    );

    expect(activities).toEqual([
      {
        title: 'Parent-and-tot swim',
        summary: 'A water-comfort class for toddlers at a municipal pool.',
        coverageNote: 'municipal pools commonly offer this; sessions are seasonal.',
        sourceUrl: null,
      },
      {
        title: 'Neighbourhood park and playground',
        summary: 'Unstructured outdoor play at a local park.',
        coverageNote: 'public parks exist in essentially every area.',
        sourceUrl: 'https://example.org/park',
      },
    ]);
    // The closed shape: a candidate can only ever carry these four keys.
    for (const a of activities) {
      expect(Object.keys(a).sort()).toEqual(['coverageNote', 'sourceUrl', 'summary', 'title']);
    }
  });

  it('drops a non-http(s) sourceUrl (fails closed on javascript:/relative schemes)', async () => {
    const c = fakeClient([
      {
        title: 'Story-time',
        description: 'a library story hour',
        sourceUrl: 'javascript:alert(1)',
        confidence: 0.6,
        coverageNote: 'libraries run these',
      },
    ]);

    const [activity] = await discoverPreview(
      { stage: 'newborn', areaCoarse: 'Plateau-Mont-Royal', interests: [] },
      deps(c.client),
    );

    expect(activity?.sourceUrl).toBeNull();
  });

  it('caps untrusted (model-sourced) text before returning it', async () => {
    const c = fakeClient([
      {
        title: 'x'.repeat(500),
        description: 'y'.repeat(900),
        confidence: 0.6,
        coverageNote: 'z'.repeat(500),
      },
    ]);

    const [activity] = await discoverPreview(
      { stage: 'child', areaCoarse: 'Burnaby', interests: [] },
      deps(c.client),
    );

    expect(activity?.title.length).toBe(200);
    expect(activity?.summary.length).toBe(600);
    expect(activity?.coverageNote.length).toBe(300);
  });

  it('returns an empty list WITHOUT a model call for a teenager (real discovery excludes teens, rule #1)', async () => {
    const c = fakeClient(SAMPLE);

    const activities = await discoverPreview(
      { stage: 'teenager', areaCoarse: 'M5V', interests: ['driving'] },
      deps(c.client),
    );

    expect(activities).toEqual([]);
    expect(c.create).not.toHaveBeenCalled();
  });

  it('throws when the forced tool call is missing (rule #8: do not mask)', async () => {
    const create = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'no.' }],
      usage: { input_tokens: 10, output_tokens: 20 },
    });
    const client = { messages: { create } } as unknown as DiscoveryAnthropicClient;

    await expect(
      discoverPreview({ stage: 'toddler', areaCoarse: 'M5V', interests: [] }, deps(client)),
    ).rejects.toThrow('submit_candidates');
  });
});
