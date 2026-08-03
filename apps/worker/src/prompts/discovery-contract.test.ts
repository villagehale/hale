import { describe, expect, it } from 'vitest';
import { loadPrompt } from './loader';

// VIL-266 prompt contract: the discovery caller sends `age_months` alongside
// `stage`, and `preschool` is a real stage. The prompt is authored in Langfuse
// (rule #2), so nothing at compile time ties its text to the caller's payload —
// a future Langfuse edit could silently drop either half of the contract and
// every gate would stay green. This pins the contract to the pulled disk copy.
describe('discovery prompt contract', () => {
  it('declares the age_months input the caller sends', async () => {
    const prompt = await loadPrompt('discovery');
    expect(prompt).toContain('`age_months`');
  });

  it('carries preschool in all three stage vocabularies', async () => {
    const prompt = await loadPrompt('discovery');
    const stageEnumLines = prompt.split('\n').filter((l) => l.includes('`preschool`') || l.includes('"preschool"'));
    // inputs bullet + stage_fit enum + stage echo enum
    expect(stageEnumLines.length).toBeGreaterThanOrEqual(3);
  });
});
