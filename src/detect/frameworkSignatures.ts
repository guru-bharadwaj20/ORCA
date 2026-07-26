/**
 * Data-driven framework detection: a table mapping dependency/file markers to a
 * framework id, per runtime. This is the open-taxonomy generalization of the original
 * `framework.ts` (which hardcoded react/express/django in `if` statements). Adding a
 * framework is adding a row — the Phase-B promise.
 *
 * PHASE: B (widen deterministic detection) — REAL code, pure data + a matcher. No AI.
 * The legacy `detectFrontendFramework`/`detectBackendFramework` stay wired into the
 * pipeline; this richer detector runs alongside and feeds the reasoning trail.
 */

import type { Runtime } from '../model/recipe.js';

/** The role a framework plays, so the aggregator can slot it into the plan. */
export type FrameworkRole = 'frontend' | 'backend' | 'fullstack' | 'desktop' | 'data-app';

/** One framework's detection signature. */
export interface FrameworkSignature {
  /** Stable framework id, e.g. "nextjs", "fastapi", "gin". */
  id: string;
  runtime: Runtime;
  role: FrameworkRole;
  /** Any of these dependency names present triggers the match. */
  anyDependency?: string[];
  /** Any of these files present at the component root triggers the match. */
  anyFile?: string[];
  /** Detection weight for this signature's evidence, 0..1. */
  weight: number;
}

/**
 * The framework signature table. Ordered most-specific-first within a runtime so a
 * meta-framework (Next.js) is preferred over the library it builds on (React). Kept
 * intentionally broad per the Phase-1 spec across JS/TS, Python, Go, JVM, and .NET.
 */
export const FRAMEWORK_SIGNATURES: readonly FrameworkSignature[] = [
  // --- JavaScript / TypeScript ---
  { id: 'nextjs', runtime: 'node', role: 'fullstack', anyDependency: ['next'], weight: 0.9 },
  { id: 'nuxt', runtime: 'node', role: 'fullstack', anyDependency: ['nuxt'], weight: 0.9 },
  {
    id: 'sveltekit',
    runtime: 'node',
    role: 'fullstack',
    anyDependency: ['@sveltejs/kit'],
    weight: 0.9,
  },
  {
    id: 'angular',
    runtime: 'node',
    role: 'frontend',
    anyDependency: ['@angular/core'],
    weight: 0.9,
  },
  { id: 'nestjs', runtime: 'node', role: 'backend', anyDependency: ['@nestjs/core'], weight: 0.9 },
  {
    id: 'electron',
    runtime: 'node',
    role: 'desktop',
    anyDependency: ['electron'],
    weight: 0.85,
  },
  {
    id: 'vite',
    runtime: 'node',
    role: 'frontend',
    anyDependency: ['vite'],
    anyFile: ['vite.config.ts', 'vite.config.js'],
    weight: 0.6,
  },
  {
    id: 'react',
    runtime: 'node',
    role: 'frontend',
    anyDependency: ['react', 'react-dom'],
    weight: 0.7,
  },
  { id: 'fastify', runtime: 'node', role: 'backend', anyDependency: ['fastify'], weight: 0.9 },
  { id: 'koa', runtime: 'node', role: 'backend', anyDependency: ['koa'], weight: 0.85 },
  {
    id: 'hapi',
    runtime: 'node',
    role: 'backend',
    anyDependency: ['@hapi/hapi', 'hapi'],
    weight: 0.85,
  },
  { id: 'hono', runtime: 'node', role: 'backend', anyDependency: ['hono'], weight: 0.85 },
  {
    id: 'remix',
    runtime: 'node',
    role: 'fullstack',
    anyDependency: ['@remix-run/node', '@remix-run/react'],
    weight: 0.9,
  },
  { id: 'astro', runtime: 'node', role: 'fullstack', anyDependency: ['astro'], weight: 0.9 },
  { id: 'express', runtime: 'node', role: 'backend', anyDependency: ['express'], weight: 0.7 },

  // --- Python ---
  { id: 'django', runtime: 'python', role: 'backend', anyDependency: ['django'], weight: 0.9 },
  { id: 'fastapi', runtime: 'python', role: 'backend', anyDependency: ['fastapi'], weight: 0.9 },
  { id: 'flask', runtime: 'python', role: 'backend', anyDependency: ['flask'], weight: 0.85 },
  {
    id: 'streamlit',
    runtime: 'python',
    role: 'data-app',
    anyDependency: ['streamlit'],
    weight: 0.85,
  },

  // --- Go ---
  {
    id: 'gin',
    runtime: 'go',
    role: 'backend',
    anyDependency: ['github.com/gin-gonic/gin'],
    weight: 0.8,
  },
  {
    id: 'fiber',
    runtime: 'go',
    role: 'backend',
    anyDependency: ['github.com/gofiber/fiber'],
    weight: 0.8,
  },
  {
    id: 'echo',
    runtime: 'go',
    role: 'backend',
    anyDependency: ['github.com/labstack/echo'],
    weight: 0.8,
  },

  // --- JVM ---
  {
    id: 'spring-boot',
    runtime: 'jvm',
    role: 'backend',
    anyDependency: ['spring-boot-starter', 'org.springframework.boot'],
    weight: 0.85,
  },

  // --- .NET ---
  {
    id: 'aspnet',
    runtime: 'dotnet',
    role: 'backend',
    anyDependency: ['Microsoft.AspNetCore'],
    weight: 0.8,
  },
  {
    id: 'blazor',
    runtime: 'dotnet',
    role: 'frontend',
    anyDependency: ['Microsoft.AspNetCore.Components'],
    weight: 0.85,
  },

  // --- PHP ---
  {
    id: 'laravel',
    runtime: 'php',
    role: 'backend',
    anyDependency: ['laravel/framework'],
    weight: 0.9,
  },
  {
    id: 'symfony',
    runtime: 'php',
    role: 'backend',
    anyDependency: ['symfony/framework-bundle'],
    weight: 0.85,
  },

  // --- Ruby ---
  { id: 'rails', runtime: 'ruby', role: 'backend', anyDependency: ['rails'], weight: 0.9 },
  { id: 'sinatra', runtime: 'ruby', role: 'backend', anyDependency: ['sinatra'], weight: 0.85 },
];

/** Facts a caller supplies to `matchFrameworks` (from manifest + file listing). */
export interface FrameworkFacts {
  runtime: Runtime;
  dependencies: readonly string[];
  files: readonly string[];
}

/** A matched framework with the concrete markers that justified it. */
export interface FrameworkMatch {
  id: string;
  role: FrameworkRole;
  weight: number;
  /** The specific dependency/file markers observed, for the reasoning trail. */
  markers: string[];
}

/**
 * True when a dependency name satisfies a marker. Matching is deliberately narrow to
 * avoid false positives (`flask` must NOT match `flask-cors`, `next` must NOT match
 * `next-auth`):
 *   - exact:        marker === dep
 *   - module path:  dep starts with `marker/` (Go's `.../gin` → `.../gin/v2`)
 *   - starter tree: dep starts with `marker-` ONLY when the marker is itself a
 *                   `-starter` prefix (Spring's `spring-boot-starter` → `-web`).
 */
function dependencyMatches(dep: string, marker: string): boolean {
  if (dep === marker) return true;
  if (dep.startsWith(`${marker}/`)) return true; // Go module path (.../gin/v2)
  if (dep.startsWith(`${marker}.`)) return true; // .NET namespace (Microsoft.AspNetCore.Mvc)
  if (marker.endsWith('-starter') && dep.startsWith(`${marker}-`)) return true; // Spring starter tree
  return false;
}

/**
 * Every framework whose signature the facts satisfy, most-specific (highest weight)
 * first. Returns all matches (not just the best) so the aggregator can reason about
 * meta-frameworks vs. their underlying libraries.
 */
export function matchFrameworks(facts: FrameworkFacts): FrameworkMatch[] {
  const matches: FrameworkMatch[] = [];
  for (const sig of FRAMEWORK_SIGNATURES) {
    if (sig.runtime !== facts.runtime) continue;
    const markers: string[] = [];
    for (const dep of sig.anyDependency ?? []) {
      if (facts.dependencies.some((d) => dependencyMatches(d, dep))) markers.push(dep);
    }
    for (const file of sig.anyFile ?? []) {
      if (facts.files.includes(file)) markers.push(file);
    }
    if (markers.length > 0) {
      matches.push({ id: sig.id, role: sig.role, weight: sig.weight, markers });
    }
  }
  return matches.sort((a, b) => b.weight - a.weight);
}
