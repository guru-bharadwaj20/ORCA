/**
 * PHASE 5 tests — tier-3 AI build inference. Uses a fake AIFacade (no network): the
 * router boundary is stubbed, but validation, the Claim wrapping, the AI confidence
 * cap, and the best-effort null path all run for real.
 */
import { describe, expect, it, vi } from 'vitest';

import type { AIFacade } from '../../src/ai/client.js';
import { buildInferencePrompt, inferBuild } from '../../src/detect/aiInference.js';
import { AI_CONFIDENCE_CEILING } from '../../src/model/claim.js';
import type { CostLedger } from '../../src/core/context.js';

const ledger = (): CostLedger => ({ inputTokens: 0, outputTokens: 0, estimatedUsd: 0 });

/** A fake facade that returns a fixed validated object (already schema-shaped). */
function fakeAi(reply: unknown): AIFacade {
  return {
    complete: vi.fn().mockResolvedValue(reply),
  };
}

const input = { tree: ['Cargo.toml', 'src/main.rs'], readme: '# app', snippets: {} };

describe('inferBuild', () => {
  it('wraps a validated inference as an ai-sourced Claim with reasoning', async () => {
    const ai = fakeAi({
      runtime: 'rust',
      installCommands: ['cargo fetch'],
      buildCommands: ['cargo build --release'],
      startCommand: './target/release/app',
      ports: [8080],
      reasoning: ['Cargo.toml present', 'binary crate in src/main.rs'],
    });

    const result = await inferBuild(input, ledger(), ai);
    expect(result?.source).toBe('ai');
    expect(result?.value.runtime).toBe('rust');
    expect(result?.value.startCommand).toBe('./target/release/app');
    expect(result?.evidence.map((e) => e.signal)).toContain('Cargo.toml present');
  });

  it('caps AI confidence below determinism even with strong reasoning', async () => {
    const ai = fakeAi({
      runtime: 'go',
      startCommand: './server',
      installCommands: [],
      buildCommands: ['go build'],
      ports: [],
      reasoning: ['go.mod', 'main package', 'CI builds it', 'Dockerfile present'],
    });

    const result = await inferBuild(input, ledger(), ai);
    expect(result?.confidence).toBeLessThanOrEqual(AI_CONFIDENCE_CEILING);
  });

  it('returns null when the model call/validation fails (best-effort)', async () => {
    const ai: AIFacade = { complete: vi.fn().mockRejectedValue(new Error('AI_INVALID_RESPONSE')) };
    expect(await inferBuild(input, ledger(), ai)).toBeNull();
  });

  it('builds a grounded prompt from the tree + README', () => {
    const prompt = buildInferencePrompt({
      tree: ['go.mod', 'main.go'],
      readme: 'Run with go run .',
      snippets: { 'go.mod': 'module x' },
    });
    expect(prompt.system).toContain('JSON');
    expect(prompt.user).toContain('go.mod');
    expect(prompt.user).toContain('Run with go run .');
    expect(prompt.user).toContain('module x');
  });
});
