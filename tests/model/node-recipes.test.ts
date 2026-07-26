/**
 * Node framework recipes and — more importantly — their ORDER in the shipped registry.
 *
 * Next.js and NestJS declare `react`/`express` in their own dependency lists, so before
 * these recipes existed a Next.js repo resolved to `node-react` (Vite dev server on
 * 5173) and a Nest repo to `node-express` (`npm run dev`, no `nest build`). Those are
 * misdetections, not gaps, so most of this file is regression assertions on priority.
 */
import { describe, expect, it } from 'vitest';

import type { MatchFacts } from '../../src/model/recipe.js';
import { ALL_RECIPES, defaultRecipeRegistry } from '../../src/model/recipes/index.js';

const registry = defaultRecipeRegistry();
const facts = (over: Partial<MatchFacts>): MatchFacts => ({
  runtime: 'node',
  dependencies: [],
  files: [],
  ...over,
});

/** Position of a recipe in the shipped priority order. */
const indexOf = (id: string): number => ALL_RECIPES.findIndex((e) => e.recipe.id === id);

describe('registry priority order', () => {
  it('places the Node framework recipes ahead of the seed react/express matchers', () => {
    expect(indexOf('node-next')).toBeLessThan(indexOf('node-react'));
    expect(indexOf('node-nest')).toBeLessThan(indexOf('node-express'));
    expect(indexOf('node-angular')).toBeLessThan(indexOf('node-react'));
  });

  it('places the generic vite bundler AFTER them, so frameworks always win', () => {
    expect(indexOf('node-vite')).toBeGreaterThan(indexOf('node-react'));
    expect(indexOf('node-vite')).toBeGreaterThan(indexOf('node-express'));
  });
});

describe('node framework recipes', () => {
  it('resolves Next.js to node-next despite react/react-dom being present', () => {
    const recipe = registry.match(
      facts({ dependencies: ['next', 'react', 'react-dom'], files: ['package.json'] })
    );
    expect(recipe?.id).toBe('node-next');
    expect(recipe?.buildCommands).toEqual(['npm run build']);
    expect(recipe?.startCommand).toBe('npm run start');
    expect(recipe?.defaultPorts).toEqual([3000]);
  });

  it('resolves NestJS to node-nest despite express being present', () => {
    const recipe = registry.match(
      facts({ dependencies: ['@nestjs/core', '@nestjs/platform-express', 'express'] })
    );
    expect(recipe?.id).toBe('node-nest');
    expect(recipe?.buildCommands).toEqual(['npm run build']);
    expect(recipe?.startCommand).toBe('node dist/main.js');
  });

  it('resolves Angular to a single-stage dev-server recipe on 4200', () => {
    const recipe = registry.match(facts({ dependencies: ['@angular/core', 'rxjs'] }));
    expect(recipe?.id).toBe('node-angular');
    // No build step: `ng build` emits static assets the synthesizer has no server for.
    expect(recipe?.buildCommands).toBeUndefined();
    expect(recipe?.startCommand).toBe('npm run start -- --host 0.0.0.0 --port 4200');
    expect(recipe?.defaultPorts).toEqual([4200]);
  });

  it('resolves a non-React Vite app (Vue) that previously matched nothing', () => {
    const recipe = registry.match(
      facts({ dependencies: ['vue', 'vite'], files: ['vite.config.js'] })
    );
    expect(recipe?.id).toBe('node-vite');
    expect(recipe?.startCommand).toBe('npx vite preview --host 0.0.0.0 --port 4173');
    expect(recipe?.defaultPorts).toEqual([4173]);
  });
});

describe('seed behavior is preserved', () => {
  it('keeps a plain React app on node-react', () => {
    expect(registry.match(facts({ dependencies: ['react', 'react-dom'] }))?.id).toBe('node-react');
  });

  it('keeps a React + Vite app on node-react, not the generic bundler recipe', () => {
    const recipe = registry.match(
      facts({ dependencies: ['react', 'react-dom', 'vite'], files: ['vite.config.ts'] })
    );
    expect(recipe?.id).toBe('node-react');
  });

  it('keeps a plain Express app on node-express', () => {
    expect(registry.match(facts({ dependencies: ['express'] }))?.id).toBe('node-express');
  });

  it('falls back to the bare node recipe when no framework matches', () => {
    // WAS `toBeNull()`. That null was the bug: a Node repo with a manifest and an
    // unrecognized framework (fastify, koa, hapi, anything bespoke) placed NOTHING and
    // detected as `isSupported=false, confidence=0` — despite ORCA already knowing the
    // runtime, the manifest, and the start script, which is all a container needs.
    const recipe = registry.match(facts({ dependencies: ['lodash'], files: ['package.json'] }));

    expect(recipe?.id).toBe('node-app');
  });

  it('never lets the bare fallback shadow a framework recipe', () => {
    // The fallback matches on a manifest alone, so its LAST position in `ALL_RECIPES` is
    // what keeps it from swallowing every Node repo. Pin that here rather than trusting
    // list order to stay correct by inspection.
    const files = ['package.json'];

    expect(registry.match(facts({ dependencies: ['next', 'react'], files }))?.id).toBe('node-next');
    expect(registry.match(facts({ dependencies: ['@nestjs/core'], files }))?.id).toBe('node-nest');
    expect(registry.match(facts({ dependencies: ['react'], files }))?.id).toBe('node-react');
    expect(registry.match(facts({ dependencies: ['express'], files }))?.id).toBe('node-express');
  });
});
