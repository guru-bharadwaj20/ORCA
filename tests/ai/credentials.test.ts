import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createAnthropicClient } from '../../src/ai/providers/anthropic.js';
import { QwenProvider } from '../../src/ai/providers/qwen.js';
import type {
  AIProvider,
  CompletionOptions,
  ProviderCompletion,
} from '../../src/ai/providers/types.js';
import {
  AIRouter,
  routerConfigForRun,
  type ProviderFactories,
  type RouterConfig,
} from '../../src/ai/router.js';
import type { CostLedger } from '../../src/core/context.js';

const ledger = (): CostLedger => ({ inputTokens: 0, outputTokens: 0, estimatedUsd: 0 });
const schema = z.object({ answer: z.string() });
const prompt = { system: 's', user: 'u' };

afterEach(() => {
  delete process.env['QWEN_API_KEY'];
  delete process.env['ANTHROPIC_API_KEY'];
});

describe('providers resolve keys through the injected resolver', () => {
  it('QwenProvider reads the resolver, ignoring process.env', async () => {
    process.env['QWEN_API_KEY'] = 'sk-env-should-be-ignored';
    const provider = new QwenProvider(() => undefined);
    await expect(provider.complete('hi')).rejects.toMatchObject({ code: 'MISSING_API_KEY' });
  });

  it('createAnthropicClient reads the resolver, ignoring process.env', () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-env-should-be-ignored';
    expect(() => createAnthropicClient(() => undefined)).toThrow(/MISSING_API_KEY|not set/);
    const client = createAnthropicClient((name) =>
      name === 'ANTHROPIC_API_KEY' ? 'sk-ok' : undefined
    );
    expect(client).toBeTruthy();
  });
});

describe('router forwards the cancel signal to the provider', () => {
  it('passes config.signal into provider.complete options', async () => {
    let seen: CompletionOptions | undefined;
    const fake: AIProvider = {
      name: 'qwen',
      complete: (_p: string, opts?: CompletionOptions): Promise<ProviderCompletion> => {
        seen = opts;
        return Promise.resolve({
          text: JSON.stringify({ answer: 'ok' }),
          inputTokens: 1,
          outputTokens: 1,
          estimatedUsd: 0,
        });
      },
    };
    const factories: ProviderFactories = { qwen: () => fake, anthropic: () => fake };
    const controller = new AbortController();
    const config: RouterConfig = {
      primary: 'qwen',
      fallback: null,
      maxPrimaryAttempts: 1,
      minConfidence: 0.5,
      costCapUsd: 1,
      signal: controller.signal,
    };

    const result = await new AIRouter(config, factories).completeValidated(
      prompt,
      schema,
      ledger()
    );

    expect(result).toEqual({ answer: 'ok' });
    expect(seen?.signal).toBe(controller.signal);
  });

  it('routerConfigForRun threads the signal onto the config', () => {
    const controller = new AbortController();
    const config = routerConfigForRun({ signal: controller.signal }, {});
    expect(config.signal).toBe(controller.signal);
  });
});
