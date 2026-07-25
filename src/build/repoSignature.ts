/**
 * The repo signature + shape that key a learned self-heal override (Phase F). A signature
 * identifies *which repo* an override belongs to; the shape describes *what ORCA decided
 * that repo is* (languages, frameworks, matched recipes) and is the invalidation guard —
 * if the repo's detected recipe shape changes, a stored override for its signature is
 * treated as stale (see `docs/universal-understanding-plan.md` Phase F).
 *
 * DESIGN (reviewed): the signature is keyed on repo IDENTITY ALONE, so there is exactly
 * one override slot per repo and a re-heal overwrites it cleanly. The recipe fingerprint
 * is stored on the record and validated on retrieval rather than folded into the key, so
 * invalidation is explicit ("found an override, but the recipe changed → discard") and
 * directly testable, matching the default precedence: trust a stored override, but drop
 * it the moment the repo's detected recipe id changes.
 *
 * PHASE: F (recipe-aware self-heal) — REAL code. Pure: no I/O, no AI. Recipe-agnostic —
 * it reads whatever recipe ids the plan carries and never hardcodes a specific recipe.
 *
 * STAGE: 5 (build) — self-heal persistence.
 */

import { createHash } from 'node:crypto';

import type { RunContext } from '../core/context.js';

/** What ORCA decided a repo is — the fields a learned override is validated against. */
export interface RepoShape {
  /** Normalized, human-readable repo identity (the value the signature hashes). */
  repoId: string;
  /** Detected languages, sorted. */
  languages: string[];
  /** Detected frontend/backend frameworks, sorted. */
  frameworks: string[];
  /**
   * One token per built service, sorted and de-duplicated: the node's `recipeId` when it
   * has one (ecosystem/inferred/`ai-*`), else a synthetic `seed:<kind>:<framework>` for a
   * seed-stack template node. This is the invalidation key — a changed set means the repo
   * changed shape.
   */
  recipeFingerprint: string[];
}

/**
 * Normalize a repo URL or local path into a stable identity string. Git URLs collapse to
 * `host/owner/repo` (scheme, credentials, and a trailing `.git` stripped, lower-cased);
 * local paths are kept as-is apart from trailing slashes, since a path is already the
 * stable thing the user re-runs against. Deterministic and side-effect free.
 */
export function normalizeRepoId(repoUrl: string): string {
  const raw = repoUrl.trim();
  const scp = /^git@([^:]+):(.+)$/.exec(raw); // scp-like: git@github.com:owner/repo.git
  const isUrl = scp !== null || /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
  if (!isUrl) return raw.replace(/\/+$/, ''); // local path — preserve case
  const hostPath = scp ? `${scp[1]}/${scp[2]}` : raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  return hostPath
    .replace(/^[^@/]+@/, '') // strip user@ credentials
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

/** The signature (store key) for a repo identity: a hex SHA-256 of its normalized id. */
export function signatureFor(repoId: string): string {
  return createHash('sha256').update(repoId).digest('hex');
}

/** The recipe fingerprint: one sorted token per built service (see `RepoShape`). */
export function recipeFingerprint(ctx: RunContext): string[] {
  const tokens = new Set<string>();
  for (const node of ctx.plan?.services ?? []) {
    if (node.source.type !== 'build') continue;
    if (node.source.recipeId !== undefined && node.source.recipeId !== '') {
      tokens.add(node.source.recipeId);
      continue;
    }
    // A seed-stack template node carries no recipe id; derive one from ITS OWN
    // component's framework (via componentRootDir, not the singular compat field) so N
    // same-role nodes don't collapse into one token — a monorepo with 3 backends must
    // invalidate when ANY of the 3 changes shape, not just the primary. rootDir is part
    // of the token for the same reason: two same-framework nodes would otherwise
    // produce an identical token and the Set would silently dedupe them to one.
    const component = ctx.detection?.components.find((c) => c.rootDir === node.componentRootDir);
    tokens.add(`seed:${node.kind}:${node.componentRootDir ?? '?'}:${component?.framework ?? 'unknown'}`);
  }
  return [...tokens].sort();
}

/** Assemble the full shape (identity + descriptors) for the current run. */
export function repoShapeFrom(ctx: RunContext): RepoShape {
  const detection = ctx.detection;
  // Every detected component's framework, not just the primary frontend/backend's — a
  // monorepo with 3 Express services should invalidate a stored override if any of the
  // 3 changes framework, not just whichever one .backend happens to resolve to.
  const frameworks: string[] = [];
  for (const component of detection?.components ?? []) {
    if (component.framework !== 'unknown') frameworks.push(component.framework);
  }
  return {
    repoId: normalizeRepoId(ctx.repoUrl),
    languages: [...(detection?.languages ?? [])].sort(),
    frameworks: [...new Set(frameworks)].sort(),
    recipeFingerprint: recipeFingerprint(ctx),
  };
}
