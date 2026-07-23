import type { DetectionResult } from '../../detect/types.js';
import { detectionSummary, truncate, type PromptPair } from './fill.js';

const MAX_README_CHARS = 6000;

const INFER_ENV_SYSTEM = `You are ORCA, a tool that containerizes small student/hackathon repos for local development with docker-compose. Infer the environment variables the app needs to run, so ORCA can generate a working .env file.

Respond with ONLY a JSON object of this exact shape — no markdown fences, no commentary:
{"variables": [{"key": "<NAME>", "value": "<dev default>", "required": true, "reason": "<one sentence: where this came from>"}]}

Rules:
- Ground every variable in the detection facts or README; do not invent framework-generic variables the app never reads.
- Values are LOCAL DEV defaults that work inside docker-compose: database hosts are compose service names (e.g. "db"), never "localhost".
- Database URLs must match the detected engine (postgres://... or mongodb://...) and its default port.
- Secrets (API keys, JWT secrets) get obvious placeholder values like "change-me"; mark them required only if the app fails to boot without them.
- "required": true means the app cannot start without it; false means optional tuning.`;

export function buildInferEnvPrompt(detection: DetectionResult, readme: string): PromptPair {
  const user = [
    '## Detection facts',
    detectionSummary(detection),
    '',
    '## Repo README',
    readme.trim() === '' ? '(no README found)' : truncate(readme, MAX_README_CHARS),
  ].join('\n');

  return { system: INFER_ENV_SYSTEM, user };
}
