/**
 * A component's DETECTED start command must reach the Dockerfile.
 *
 * `detectEntrypoint` resolves the maintainer's actual script and stores it on
 * `DetectedComponent.entrypoint`, but `dockerfileVarsFor` used `recipe.startCommand`
 * unconditionally — so for a framework that ships no start convention, a hardcoded guess
 * beat the evidence-backed answer and the container died on `Missing script`.
 */

import { describe, it, expect } from 'vitest';

import { dockerfileVarsFor } from '../../src/templates/registry.js';
import type { DetectedComponent } from '../../src/detect/types.js';

function component(over: Partial<DetectedComponent> = {}): DetectedComponent {
  return {
    role: 'backend',
    rootDir: '.',
    language: 'javascript',
    packageManager: 'npm',
    framework: 'fastify',
    dependencies: ['fastify'],
    ports: [],
    entrypoint: null,
    ...over,
  };
}

const entrypoint = (command: string) => ({
  role: 'backend' as const,
  command,
  workingDir: '.',
  source: 'package-json-script' as const,
});

describe('start command resolution', () => {
  it('uses the detected script for a convention-less framework', () => {
    const vars = dockerfileVarsFor(component({ entrypoint: entrypoint('npm run serve') }));

    // Fastify ships no CLI. `npm run serve` is what this repo actually declares.
    expect(vars.startCommand).toBe('npm run serve');
  });

  it('falls back to a runtime convention when nothing declared one', () => {
    const vars = dockerfileVarsFor(component());

    // Never blank: an empty CMD is the one outcome that is not recoverable downstream.
    expect(vars.startCommand).toBe('npm start');
  });

  it('uses a python convention for a python component', () => {
    const vars = dockerfileVarsFor(
      component({ language: 'python', packageManager: 'pip', framework: 'unknown' })
    );

    expect(vars.startCommand).toBe('python main.py');
  });

  it('keeps the recipe command when the framework HAS a convention', () => {
    // React's recipe knows how a React dev server starts; a detected script must not
    // override a framework-correct command.
    const vars = dockerfileVarsFor(
      component({
        role: 'frontend',
        framework: 'react',
        dependencies: ['react'],
        entrypoint: entrypoint('npm run whatever'),
      })
    );

    expect(vars.startCommand).not.toBe('npm run whatever');
  });
});
