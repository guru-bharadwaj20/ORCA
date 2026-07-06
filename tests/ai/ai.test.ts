/**
 * STAGE 3 tests — AI template-filling / env-inference with the LLM client MOCKED.
 * Stubs only: no real API calls are ever made in tests.
 */
import { describe, it } from 'vitest';

describe('ai stage (mocked LLM)', () => {
  // TODO(stage-3): mock the Anthropic client and assert schema validation.
  it.todo('fills template variables and validates them against the zod schema');
  it.todo('rejects a response that fails schema validation');
  it.todo('stops when the cost cap is exceeded');
});
