/**
 * STAGE 3 tests — AI template-filling / env-inference with the LLM client MOCKED.
 * The Anthropic SDK module is replaced wholesale: no real API calls are ever made,
 * but everything on our side of the boundary (prompts, cost cap, ledger, zod
 * validation) runs for real.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const createMock = vi.hoisted(() => vi.fn());

vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    messages = { create: createMock };
  },
}));

import { complete } from '../../src/ai/client.js';
import { fillTemplate } from '../../src/ai/fillTemplate.js';
import { inferEnv } from '../../src/ai/inferEnv.js';
import { validateAgainst, InferredEnvSchema } from '../../src/ai/schema.js';
import type { CostLedger } from '../../src/core/context.js';
import type { DetectedComponent, DetectionResult } from '../../src/detect/types.js';
import { describeComponent } from '../../src/templates/registry.js';
import { CostCapExceededError } from '../../src/utils/errors.js';

const backend: DetectedComponent = {
  role: 'backend',
  rootDir: 'server',
  language: 'javascript',
  packageManager: 'npm',
  framework: 'express',
  dependencies: ['express', 'mongoose'],
  ports: [{ port: 3000, protocol: 'tcp', source: 'code' }],
  entrypoint: {
    role: 'backend',
    command: 'npm run dev',
    workingDir: 'server',
    source: 'package-json-script',
  },
};

const detection: DetectionResult = {
  repoPath: '/tmp/fake-repo',
  languages: ['javascript'],
  packageManagers: ['npm'],
  frontend: null,
  backend,
  databases: [{ engine: 'mongodb', defaultPort: 27017, detectedFrom: 'mongoose' }],
  isSupported: true,
  confidence: 0.7,
  reasoning: [],
  insights: {
    frameworks: [],
    runtimes: [],
    monorepoTools: [],
    ciCommands: [],
    ciRuntimeVersions: [],
    taskCommands: [],
    ecosystemComponents: [],
  },
  warnings: [],
};

const template = describeComponent(backend);
const freshLedger = (): CostLedger => ({ inputTokens: 0, outputTokens: 0, estimatedUsd: 0 });

function mockModelReply(text: string, usage = { input_tokens: 1200, output_tokens: 250 }): void {
  createMock.mockResolvedValueOnce({
    content: [{ type: 'text', text }],
    usage,
  });
}

beforeEach(() => {
  createMock.mockReset();
  process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test-key';
  // Keep the suite hermetic: with no Qwen key, the router's primary attempt fails
  // fast and escalates to the (mocked) Anthropic fallback — never the network.
  delete process.env['QWEN_API_KEY'];
});

describe('ai stage (mocked LLM)', () => {
  it('fills template variables and validates them against the zod schema', async () => {
    const payload = {
      variables: {
        baseImage: 'node:20-slim',
        startCommand: 'npm run dev',
        port: 3000,
      },
      notes: ['README pins Node 20.'],
    };
    mockModelReply(JSON.stringify(payload));

    const ledger = freshLedger();
    const filled = await fillTemplate(detection, template, '# My App\nRuns on Node 20.', ledger);

    expect(filled).toEqual(payload);
    // The ledger accrued this call's usage and cost.
    expect(ledger.inputTokens).toBe(1200);
    expect(ledger.outputTokens).toBe(250);
    expect(ledger.estimatedUsd).toBeCloseTo((1200 / 1e6) * 5 + (250 / 1e6) * 25, 6);
    // One real-shaped SDK call, grounded on the template defaults.
    expect(createMock).toHaveBeenCalledTimes(1);
    const request = createMock.mock.calls[0]?.[0];
    expect(request.model).toBe('claude-opus-4-8');
    expect(request.messages[0].content).toContain('node.Dockerfile.hbs');
    expect(request.system).toContain('JSON');
  });

  it('rejects a response that fails schema validation', async () => {
    // An unsupported package manager must be refused, not propagated into a Dockerfile.
    mockModelReply(JSON.stringify({ variables: { packageManager: 'cargo' } }));

    await expect(fillTemplate(detection, template, '', freshLedger())).rejects.toMatchObject({
      code: 'AI_INVALID_RESPONSE',
    });
  });

  it('rejects a response that is not JSON at all', async () => {
    mockModelReply('Sure! Here is what I would do: use node:20-slim.');

    await expect(inferEnv(detection, '', freshLedger())).rejects.toMatchObject({
      code: 'AI_INVALID_RESPONSE',
    });
  });

  it('stops when the cost cap is exceeded', async () => {
    const ledger: CostLedger = { inputTokens: 900_000, outputTokens: 90_000, estimatedUsd: 1.0 };

    await expect(fillTemplate(detection, template, '', ledger)).rejects.toBeInstanceOf(
      CostCapExceededError
    );
    // The cap is enforced *before* any call is made.
    expect(createMock).not.toHaveBeenCalled();
  });

  it('throws a clear error when the API key is missing', async () => {
    delete process.env['ANTHROPIC_API_KEY'];

    await expect(complete({ system: 's', user: 'u' }, freshLedger())).rejects.toMatchObject({
      code: 'MISSING_API_KEY',
    });
    expect(createMock).not.toHaveBeenCalled();
  });

  it('accepts model JSON wrapped in a markdown code fence', async () => {
    const payload = {
      variables: [
        {
          key: 'MONGO_URL',
          value: 'mongodb://db:27017/app',
          required: true,
          reason: 'mongoose connects via MONGO_URL in server/index.js.',
        },
      ],
    };
    mockModelReply('```json\n' + JSON.stringify(payload, null, 2) + '\n```');

    const env = await inferEnv(detection, '', freshLedger());
    expect(env).toEqual(payload);
  });

  it('validateAgainst applies schema defaults', () => {
    const parsed = validateAgainst(InferredEnvSchema, {
      variables: [{ key: 'PORT', value: '3000', reason: 'Express reads process.env.PORT.' }],
    });
    expect(parsed.variables[0]?.required).toBe(true);
  });
});
