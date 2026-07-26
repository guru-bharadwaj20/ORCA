/**
 * Node framework recipes expressed as DATA on the Phase-A `BuildRecipe` model, the
 * same way `ecosystems.ts` expresses Go/Rust/JVM/.NET. Adding a Node framework is
 * adding a row here — no new control flow, no template file.
 *
 * ORDERING IS THE POINT. The seed matchers in `recipe.ts` key off `react` / `express`,
 * which every Next.js and most NestJS repos also declare transitively-as-direct deps.
 * Matched first, a Next.js app resolves to `node-react` and gets a Vite dev server on
 * 5173 instead of `next build` + `next start` on 3000 — a real misdetection, not just
 * a coverage gap. `NODE_FRAMEWORK_RECIPES` is therefore registered AHEAD of the seed
 * set (see `recipes/index.ts`).
 *
 * `NODE_BUNDLER_RECIPES` goes the other way: `vite` is the generic bundler, not a
 * framework, so it is registered AFTER the seed set. A React+Vite app keeps its
 * existing `node-react` behavior, and `node-vite` catches the Vue/Svelte/Solid/vanilla
 * Vite repos that previously matched nothing at all.
 *
 * PHASE: B (widen deterministic detection) — REAL code, pure data.
 */

import type { RecipeEntry } from '../recipe.js';

/** Node images shared by every recipe here: full toolchain to build, slim to run. */
const NODE_IMAGES = { build: 'node:20', runtime: 'node:20-slim' } as const;

/**
 * Framework recipes, most-specific-first, registered BEFORE the seed react/express
 * matchers. Each drives the maintainer's own scripts (`npm run build` / `npm run
 * start`) rather than reimplementing the framework CLI, so a repo with a customized
 * build keeps working.
 */
export const NODE_FRAMEWORK_RECIPES: readonly RecipeEntry[] = [
  {
    // Next.js declares `react` + `react-dom` too, so this MUST precede `node-react`.
    matcher: { runtime: 'node', anyDependency: ['next'] },
    recipe: {
      id: 'node-next',
      runtime: 'node',
      packageManager: 'npm',
      dependencyFiles: ['package.json'],
      installCommands: ['npm install'],
      // `next build` writes .next/; `next start` serves it on 3000 by default.
      buildCommands: ['npm run build'],
      startCommand: 'npm run start',
      defaultPorts: [3000],
      baseImages: NODE_IMAGES,
    },
  },
  {
    // Nest's platform adapter puts `express` in the dependency list; this must precede
    // `node-express`, whose `npm run dev` would skip the required `nest build`.
    matcher: { runtime: 'node', anyDependency: ['@nestjs/core'] },
    recipe: {
      id: 'node-nest',
      runtime: 'node',
      packageManager: 'npm',
      dependencyFiles: ['package.json'],
      installCommands: ['npm install'],
      buildCommands: ['npm run build'],
      // Nest's default single-app output. Exec'd directly rather than via the
      // `start:prod` script, which not every generated project keeps.
      startCommand: 'node dist/main.js',
      defaultPorts: [3000],
      baseImages: NODE_IMAGES,
    },
  },
  {
    // Fastify's own docs run the app directly; it ships no build step and no CLI server.
    matcher: { runtime: 'node', anyDependency: ['fastify'] },
    recipe: {
      id: 'node-fastify',
      runtime: 'node',
      packageManager: 'npm',
      dependencyFiles: ['package.json'],
      installCommands: ['npm install'],
      // The maintainer's own `start` script, not `node server.js` — a guessed filename is
      // the single most common way a generated image dies at startup.
      startCommand: 'npm run start',
      defaultPorts: [3000],
      baseImages: NODE_IMAGES,
    },
  },
  {
    // Koa ships no CLI and no build step; the maintainer's script is the only start.
    matcher: { runtime: 'node', anyDependency: ['koa'] },
    recipe: {
      id: 'node-koa',
      runtime: 'node',
      packageManager: 'npm',
      dependencyFiles: ['package.json'],
      installCommands: ['npm install'],
      startCommand: 'npm run start',
      defaultPorts: [3000],
      baseImages: NODE_IMAGES,
    },
  },
  {
    // hapi ships no CLI; the maintainer's script starts the server.
    matcher: { runtime: 'node', anyDependency: ['@hapi/hapi'] },
    recipe: {
      id: 'node-hapi',
      runtime: 'node',
      packageManager: 'npm',
      dependencyFiles: ['package.json'],
      installCommands: ['npm install'],
      startCommand: 'npm run start',
      defaultPorts: [3000],
      baseImages: NODE_IMAGES,
    },
  },
  {
    // Hono runs on plain Node via @hono/node-server; no build step of its own.
    matcher: { runtime: 'node', anyDependency: ['hono'] },
    recipe: {
      id: 'node-hono',
      runtime: 'node',
      packageManager: 'npm',
      dependencyFiles: ['package.json'],
      installCommands: ['npm install'],
      startCommand: 'npm run start',
      defaultPorts: [3000],
      baseImages: NODE_IMAGES,
    },
  },
  {
    // Remix builds a server bundle; its start script serves it.
    matcher: { runtime: 'node', anyDependency: ['@remix-run/node'] },
    recipe: {
      id: 'node-remix',
      runtime: 'node',
      packageManager: 'npm',
      dependencyFiles: ['package.json'],
      installCommands: ['npm install'],
      buildCommands: ['npm run build'],
      startCommand: 'npm run start',
      defaultPorts: [3000],
      baseImages: NODE_IMAGES,
    },
  },
  {
    // Nuxt build emits .output/server; exec it directly rather than via nuxt start.
    matcher: { runtime: 'node', anyDependency: ['nuxt'] },
    recipe: {
      id: 'node-nuxt',
      runtime: 'node',
      packageManager: 'npm',
      dependencyFiles: ['package.json'],
      installCommands: ['npm install'],
      buildCommands: ['npm run build'],
      startCommand: 'node .output/server/index.mjs',
      defaultPorts: [3000],
      baseImages: NODE_IMAGES,
    },
  },
  {
    matcher: { runtime: 'node', anyDependency: ['@angular/core'] },
    recipe: {
      id: 'node-angular',
      runtime: 'node',
      packageManager: 'npm',
      dependencyFiles: ['package.json'],
      installCommands: ['npm install'],
      // No build step on purpose: `ng build` emits static assets, and the synthesizer's
      // runtime stage has no static file server to hand them to. The dev server is what
      // the seed React recipe already does, needs no extra dependency, and works.
      startCommand: 'npm run start -- --host 0.0.0.0 --port 4200',
      defaultPorts: [4200],
      baseImages: NODE_IMAGES,
    },
  },
];

/**
 * The generic Vite bundler, registered AFTER the seed set so framework-specific
 * matchers always win. `vite preview` serves the real production bundle and ships with
 * Vite itself, so the runtime stage needs no extra static server.
 */
export const NODE_BUNDLER_RECIPES: readonly RecipeEntry[] = [
  {
    matcher: { runtime: 'node', anyDependency: ['vite'] },
    recipe: {
      id: 'node-vite',
      runtime: 'node',
      packageManager: 'npm',
      dependencyFiles: ['package.json'],
      installCommands: ['npm install'],
      buildCommands: ['npm run build'],
      // `npx` resolves the locally-installed vite copied from the builder stage — no
      // network access at runtime.
      startCommand: 'npx vite preview --host 0.0.0.0 --port 4173',
      defaultPorts: [4173],
      baseImages: NODE_IMAGES,
    },
  },
];
