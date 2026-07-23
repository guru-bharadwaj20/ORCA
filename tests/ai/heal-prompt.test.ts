/**
 * STAGE 3 tests — the self-heal prompt builder. Pure string assembly, so assertions
 * are on the emitted { system, user } text. Covers the optional recipe-context block
 * that grounds fixes to synthesized ecosystem/inferred Dockerfiles.
 */
import { describe, expect, it } from 'vitest';

import { buildHealPrompt, type HealRecipeContext } from '../../src/ai/prompts/heal.js';

const files = [{ path: 'Dockerfile', contents: 'FROM rust:1 AS builder\n' }];

describe('buildHealPrompt', () => {
  it('omits the recipe block for a pure seed-stack run (no recipes)', () => {
    const { user } = buildHealPrompt('error text', files, 1);
    expect(user).toContain('## Failing command output (tail)');
    expect(user).toContain('## Current generated files');
    expect(user).not.toContain('Synthesized service recipes');
  });

  it('includes runtime + intended commands for a synthesized service', () => {
    const recipes: HealRecipeContext[] = [
      {
        serviceId: 'app',
        runtime: 'rust',
        recipeId: 'ai-rust',
        installCommands: ['cargo fetch'],
        buildCommands: ['cargo build --release'],
        startCommand: './target/release/app',
      },
    ];
    const { user } = buildHealPrompt('linker error', files, 2, recipes);
    expect(user).toContain('Synthesized service recipes');
    expect(user).toContain('service "app" — rust (recipe ai-rust)');
    expect(user).toContain('build:   cargo build --release');
    expect(user).toContain('start:   ./target/release/app');
    // The guardrail that keeps a fix on the same runtime.
    expect(user).toContain('do not switch a service to a different runtime');
  });

  it('renders "(none)" for an interpreted recipe with no build commands', () => {
    const recipes: HealRecipeContext[] = [
      {
        serviceId: 'api',
        runtime: 'python',
        recipeId: 'ai-python',
        installCommands: ['pip install -r requirements.txt'],
        buildCommands: [],
        startCommand: 'python app.py',
      },
    ];
    const { user } = buildHealPrompt('trace', files, 1, recipes);
    expect(user).toContain('build:   (none)');
  });
});
