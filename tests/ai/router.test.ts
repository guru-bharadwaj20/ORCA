/**
 * STAGE 3 tests — provider router: Qwen primary, Claude fallback. Qwen's HTTP
 * transport is stubbed at the global-fetch boundary and the Anthropic SDK at the
 * module boundary, so retry/fallback/validation/cost logic all runs for real.
 */
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
  resolveRouterConfig,
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

/** Queue one OpenAI-compatible Qwen HTTP reply. */
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

/** Queue one Anthropic SDK reply. */
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
    // The request is a real OpenAI-compatible call: auth header + model + both roles.
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toContain('/chat/completions');
    expect(init.headers.authorization).toBe('Bearer sk-qwen-test-key');
    const body = JSON.parse(init.body);
    expect(body.model).toBe('qwen3-coder-plus');
    expect(body.messages).toEqual([
      { role: 'system', content: 'test system' },
      { role: 'user', content: 'test user' },
    ]);
    // Qwen usage lands on the totals and on the per-provider slice, at Qwen pricing.
    expect(ledger.inputTokens).toBe(800);
    expect(ledger.outputTokens).toBe(200);
    expect(ledger.byProvider?.['qwen']?.estimatedUsd).toBeCloseTo(
      (800 / 1e6) * 1 + (200 / 1e6) * 5,
      8
    );
    expect(ledger.byProvider?.['anthropic']).toBeUndefined();
  });

  it('retries Qwen once on invalid JSON, then succeeds without fallback', async () => {
    qwenReplies('I think the answer is 42.'); // not JSON → retry
    qwenReplies(JSON.stringify({ answer: '42' }));

    const result = await new AIRouter(config).completeValidated(prompt, schema, freshLedger());

    expect(result).toEqual({ answer: '42' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(createMock).not.toHaveBeenCalled();
  });

  it('falls back to Claude after Qwen exhausts its attempts, accounting costs per provider', async () => {
    qwenReplies('not json'); // attempt 1
    qwenReplies(JSON.stringify({ wrong: 'shape' })); // attempt 2 — fails schema
    claudeReplies(JSON.stringify({ answer: 'from claude' }));
    const ledger = freshLedger();

    const result = await new AIRouter(config).completeValidated(prompt, schema, ledger);

    expect(result).toEqual({ answer: 'from claude' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(createMock).toHaveBeenCalledTimes(1);
    // Both providers' spend is tracked independently and sums to the total.
    const qwen = ledger.byProvider?.['qwen'];
    const anthropic = ledger.byProvider?.['anthropic'];
    expect(qwen?.inputTokens).toBe(1600); // two attempts × 800
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
    expect(fetchMock).not.toHaveBeenCalled(); // config error → no retry, straight to fallback
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
    expect(fetchMock).toHaveBeenCalledTimes(2); // both primary attempts were made
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

  it('builds a run-scoped config: cost cap applied, model routed to its provider family', () => {
    const claude = routerConfigForRun({ costCapUsd: 0.4, model: 'claude-sonnet-5' }, {});
    expect(claude.costCapUsd).toBe(0.4);
    expect(claude.modelOverrides).toEqual({ anthropic: 'claude-sonnet-5' });

    const qwen = routerConfigForRun({ model: 'qwen3-coder-flash' }, {});
    expect(qwen.modelOverrides).toEqual({ qwen: 'qwen3-coder-flash' });

    // Unknown model families are ignored so a typo can't hit the wrong API.
    expect(routerConfigForRun({ model: 'gpt-fantastic' }, {}).modelOverrides).toBeUndefined();
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
