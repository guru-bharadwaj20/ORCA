import type { PromptPair } from './fill.js';

const MAX_ERROR_CHARS = 5000;
const MAX_FILE_CHARS = 4000;

const HEAL_SYSTEM = `You are ORCA's self-heal assistant. A docker build/run of a small student/hackathon repo just failed. Diagnose the failure and propose ONE minimal fix by patching the files ORCA generated (Dockerfiles, docker-compose.yml, .env). Never patch the repo's own application source code.

Respond with ONLY a JSON object of this exact shape — no markdown fences, no commentary:
{"explanation": "<plain English: what broke and why, 1-2 sentences a student can understand>", "fix": "<plain English: what you are changing, 1 sentence>", "patches": [{"file": "<path relative to repo root>", "contents": "<the COMPLETE new file contents>"}]}

Rules:
- "patches" must contain the FULL new contents of each changed file, not a diff.
- Change as little as possible — one root cause per attempt.
- Only patch files from the provided list; do not introduce new files unless strictly required to fix the error.
- If the error is unfixable by config changes (e.g. broken application code), say so in "explanation" and return an empty "patches" array.`;

export function buildHealPrompt(
  errorOutput: string,
  currentFiles: { path: string; contents: string }[],
  attempt: number
): PromptPair {
  const errorTail =
    errorOutput.length > MAX_ERROR_CHARS
      ? `[...truncated by ORCA...]\n${errorOutput.slice(-MAX_ERROR_CHARS)}`
      : errorOutput;

  const fileSections = currentFiles.map((file) => {
    const contents =
      file.contents.length > MAX_FILE_CHARS
        ? `${file.contents.slice(0, MAX_FILE_CHARS)}\n[...truncated by ORCA...]`
        : file.contents;
    return `### ${file.path}\n${contents}`;
  });

  const user = [
    `## Heal attempt ${attempt}`,
    '',
    '## Failing command output (tail)',
    errorTail.trim() === '' ? '(no output captured)' : errorTail,
    '',
    '## Current generated files',
    ...(fileSections.length > 0 ? fileSections : ['(none)']),
  ].join('\n');

  return { system: HEAL_SYSTEM, user };
}
