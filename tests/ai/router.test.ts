import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const createMock = vi.hoisted(() => vi.fn());

vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    messages = { create: createMock };
  },
}));

import {
  AIRouter,
  defaultProviderFactories,
  resolveRouterConfig,
  unroutableModelWarning,
  routerConfigForRun,
  type RouterConfig,
} from '../../src/ai/router.js';
import type { CostLedger } from '../../src/core/context.js';
import { CostCapExceededError } from '../../src/utils/errors.js';

const fetchMock = vi.fn();

const schema = z.object({ answer: z.string() });
const prompt = { system: 'test system', user: 'test user' };
const freshLedger = (): CostLedger => ({ inputTokens: 0, outputTokens: 0, estimatedUsd: 0 });

const config: RouterConfig = {
  primary: 'qwen',
  fallback: 'anthropic',
  maxPrimaryAttempts: 2,
  minConfidence: 0.5,
  costCapUsd: 1.0,
};

function qwenReplies(
  content: string,
  usage = { prompt_tokens: 800, completion_tokens: 200 }
): void {
  fetchMock.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content } }], usage }),
    text: async () => '',
  });
}

function claudeReplies(text: string, usage = { input_tokens: 1200, output_tokens: 250 }): void {
  createMock.mockResolvedValueOnce({ content: [{ type: 'text', text }], usage });
}

beforeEach(() => {
  fetchMock.mockReset();
  createMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  process.env['QWEN_API_KEY'] = 'sk-qwen-test-key';
  process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test-key';
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AI provider router', () => {
  it('returns a validated Qwen result without ever touching Claude', async () => {
    qwenReplies(JSON.stringify({ answer: '42' }));
    const ledger = freshLedger();

    const result = await new AIRouter(config).completeValidated(prompt, schema, ledger);

    expect(result).toEqual({ answer: '42' });
    expect(createMock).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toContain('/chat/completions');
    expect(init.headers.authorization).toBe('Bearer sk-qwen-test-key');
    const body = JSON.parse(init.body);
    expect(body.model).toBe('qwen3-coder-plus');
    expect(body.messages).toEqual([
      { role: 'system', content: 'test system' },
      { role: 'user', content: 'test user' },
    ]);
    expect(ledger.inputTokens).toBe(800);
    expect(ledger.outputTokens).toBe(200);
    expect(ledger.byProvider?.['qwen']?.estimatedUsd).toBeCloseTo(
      (800 / 1e6) * 1 + (200 / 1e6) * 5,
      8
    );
    expect(ledger.byProvider?.['anthropic']).toBeUndefined();
  });

  it('retries Qwen once on invalid JSON, then succeeds without fallback', async () => {
    qwenReplies('I think the answer is 42.');
    qwenReplies(JSON.stringify({ answer: '42' }));

    const result = await new AIRouter(config).completeValidated(prompt, schema, freshLedger());

    expect(result).toEqual({ answer: '42' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(createMock).not.toHaveBeenCalled();
  });

  it('falls back to Claude after Qwen exhausts its attempts, accounting costs per provider', async () => {
    qwenReplies('not json');
    qwenReplies(JSON.stringify({ wrong: 'shape' }));
    claudeReplies(JSON.stringify({ answer: 'from claude' }));
    const ledger = freshLedger();

    const result = await new AIRouter(config).completeValidated(prompt, schema, ledger);

    expect(result).toEqual({ answer: 'from claude' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(createMock).toHaveBeenCalledTimes(1);
    const qwen = ledger.byProvider?.['qwen'];
    const anthropic = ledger.byProvider?.['anthropic'];
    expect(qwen?.inputTokens).toBe(1600);
    expect(anthropic?.inputTokens).toBe(1200);
    expect(anthropic?.estimatedUsd).toBeCloseTo((1200 / 1e6) * 5 + (250 / 1e6) * 25, 8);
    expect(ledger.inputTokens).toBe(2800);
    expect(ledger.estimatedUsd).toBeCloseTo(
      (qwen?.estimatedUsd ?? 0) + (anthropic?.estimatedUsd ?? 0),
      8
    );
  });

  it('escalates immediately (no retry) when the Qwen key is missing', async () => {
    delete process.env['QWEN_API_KEY'];
    claudeReplies(JSON.stringify({ answer: 'from claude' }));

    const result = await new AIRouter(config).completeValidated(prompt, schema, freshLedger());

    expect(result).toEqual({ answer: 'from claude' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it('escalates when Qwen explicitly reports low confidence', async () => {
    qwenReplies(JSON.stringify({ answer: 'maybe?', confidence: 0.2 }));
    qwenReplies(JSON.stringify({ answer: 'maybe?', confidence: 0.1 }));
    claudeReplies(JSON.stringify({ answer: 'confident' }));

    const result = await new AIRouter(config).completeValidated(prompt, schema, freshLedger());

    expect(result).toEqual({ answer: 'confident' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it('surfaces the last provider error when everything fails and no fallback is configured', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'internal error',
      json: async () => ({}),
    });

    const router = new AIRouter({ ...config, fallback: null });
    await expect(router.completeValidated(prompt, schema, freshLedger())).rejects.toMatchObject({
      code: 'AI_PROVIDER_HTTP',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(createMock).not.toHaveBeenCalled();
  });

  it('enforces the global cost cap before calling any provider', async () => {
    const ledger: CostLedger = { inputTokens: 0, outputTokens: 0, estimatedUsd: 1.0 };

    await expect(
      new AIRouter(config).completeValidated(prompt, schema, ledger)
    ).rejects.toBeInstanceOf(CostCapExceededError);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(createMock).not.toHaveBeenCalled();
  });

  it('resolves provider/retry configuration from environment overrides', () => {
    const resolved = resolveRouterConfig({
      ORCA_PRIMARY_PROVIDER: 'anthropic',
      ORCA_FALLBACK_PROVIDER: 'none',
      ORCA_MAX_PRIMARY_ATTEMPTS: '3',
    } as NodeJS.ProcessEnv);

    expect(resolved.primary).toBe('anthropic');
    expect(resolved.fallback).toBeNull();
    expect(resolved.maxPrimaryAttempts).toBe(3);

    const defaults = resolveRouterConfig({} as NodeJS.ProcessEnv);
    expect(defaults.primary).toBe('qwen');
    expect(defaults.fallback).toBe('anthropic');
    expect(defaults.maxPrimaryAttempts).toBe(2);
  });

  it('warns about a model id it cannot route, and stays quiet about ones it can', () => {
    expect(unroutableModelWarning('gpt-4')).toMatch(/Ignoring --model 'gpt-4'/);
    expect(unroutableModelWarning('claude-sonnet-5')).toBeNull();
    expect(unroutableModelWarning('qwen3-coder-plus')).toBeNull();
    expect(unroutableModelWarning('')).toBeNull();
    expect(unroutableModelWarning(undefined)).toBeNull();
  });

  it('treats a zero cost cap as "spend nothing" rather than discarding it', () => {
    expect(routerConfigForRun({ costCapUsd: 0 }, {}).costCapUsd).toBe(0);
    expect(routerConfigForRun({ costCapUsd: -3 }, {}).costCapUsd).toBe(0);
    expect(routerConfigForRun({}, {}).costCapUsd).toBe(1);
  });

  it('builds a run-scoped config: cost cap applied, model routed to its provider family', () => {
    const claude = routerConfigForRun({ costCapUsd: 0.4, model: 'claude-sonnet-5' }, {});
    expect(claude.costCapUsd).toBe(0.4);
    expect(claude.modelOverrides).toEqual({ anthropic: 'claude-sonnet-5' });

    const qwen = routerConfigForRun({ model: 'qwen3-coder-flash' }, {});
    expect(qwen.modelOverrides).toEqual({ qwen: 'qwen3-coder-flash' });

    expect(routerConfigForRun({ model: 'gpt-fantastic' }, {}).modelOverrides).toBeUndefined();
  });

  it('resolves provider keys through an injected ResolveKey (SecretStorage seam)', async () => {
    delete process.env['QWEN_API_KEY'];
    delete process.env['ANTHROPIC_API_KEY'];
    qwenReplies(JSON.stringify({ answer: 'from the vault' }));
    const vault: Record<string, string> = { QWEN_API_KEY: 'sk-vault-qwen' };

    const router = new AIRouter(
      config,
      defaultProviderFactories((name) => vault[name])
    );
    const result = await router.completeValidated(prompt, schema, freshLedger());

    expect(result).toEqual({ answer: 'from the vault' });
    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(init.headers.authorization).toBe('Bearer sk-vault-qwen');
  });

  it('passes the per-provider model override through to the actual request', async () => {
    qwenReplies(JSON.stringify({ answer: '42' }));

    await new AIRouter({
      ...config,
      modelOverrides: { qwen: 'qwen3-coder-flash' },
    }).completeValidated(prompt, schema, freshLedger());

    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(JSON.parse(init.body).model).toBe('qwen3-coder-flash');
  });
});
