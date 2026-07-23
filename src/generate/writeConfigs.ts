/**
 * Renders the selected templates with their filled variables and writes the final
 * Dockerfiles, docker-compose.yml, .dockerignore (and, for Django, the migrate-then-run
 * entrypoint script) into the workspace.
 *
 * STAGE: 5 (generate) — REAL code.
 * Inputs: a `RunContext` (approved plan, detection, filled templates, workspace dir).
 * Outputs: files written to disk; returns the list of `GeneratedFile`s. That list is
 * also the audit trail AND the self-heal patch allowlist — the heal loop may only
 * modify files recorded here, never the repo's own source.
 */

import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { GeneratedFile, RunContext } from '../core/context.js';
import { buildEnvFile } from '../orchestrate/envFiles.js';
import { refinedComponentVars } from '../plan/servicePlan.js';
import { renderCompose } from '../templates/render.js';
import { OrcaError } from '../utils/errors.js';
import { readFileIfExists } from '../utils/fs.js';
import { planToComposeVars } from './composeVars.js';
import { dockerfileFor } from './dockerfileFor.js';

/** Junk that must never be COPY'd into an image (mirrors the golden samples). */
const DOCKERIGNORE = `node_modules
.git
dist
build
coverage
__pycache__
*.pyc
.venv
venv
.env
`;

/**
 * Per-runtime build-output directories that must never be COPY'd into an image: they
 * bloat the context, and a host-built artifact shadowing the in-image build can break it
 * (e.g. a local `target/` from a different libc). Appended to the base ignore set for a
 * synthesized ecosystem service. Runtimes not listed just get the base set.
 */
const RUNTIME_DOCKERIGNORE: Record<string, readonly string[]> = {
  rust: ['target'],
  go: ['bin', 'vendor'],
  jvm: ['target', 'build', '.gradle'],
  dotnet: ['bin', 'obj'],
  php: ['vendor'],
  ruby: ['.bundle', 'vendor/bundle'],
};

/** The `.dockerignore` for a synthesized service: the base set plus its runtime's outputs. */
function dockerignoreFor(runtime: string): string {
  const extra = RUNTIME_DOCKERIGNORE[runtime];
  if (extra === undefined || extra.length === 0) return DOCKERIGNORE;
  return `${DOCKERIGNORE}${extra.join('\n')}\n`;
}

/**
 * The migrate-then-run entrypoint for Django + Postgres (mirrors the hand-verified
 * golden sample): wait for the db socket, migrate, then hand off to the CMD.
 */
const DJANGO_ENTRYPOINT = `#!/bin/sh
set -e

# depends_on only waits for the db CONTAINER to start, not for Postgres to accept
# connections — the classic Django+Postgres race. Wait for the socket first, then
# migrate, then hand off to the CMD (runserver). This is the migrate-before-run fix.
POSTGRES_HOST="\${POSTGRES_HOST:-db}"
POSTGRES_PORT="\${POSTGRES_PORT:-5432}"

echo "waiting for postgres at \${POSTGRES_HOST}:\${POSTGRES_PORT}..."
until python -c "import socket,sys; s=socket.socket(); s.settimeout(2); sys.exit(0 if s.connect_ex(('\${POSTGRES_HOST}', \${POSTGRES_PORT}))==0 else 1)"; do
  sleep 1
done

echo "running migrations..."
python manage.py migrate --noinput

echo "starting server..."
exec "$@"
`;

/**
 * A minimal passthrough entrypoint for a synthesized recipe that declares an
 * `entrypointScript` but whose repo doesn't ship one. It just execs the CMD, so the
 * ENTRYPOINT the synthesizer emitted resolves to a real, executable file (a dangling
 * `COPY`/`ENTRYPOINT` would otherwise fail the build). A recipe with real pre-launch work
 * ships its own script in the repo, which this never overwrites.
 */
const PASSTHROUGH_ENTRYPOINT = `#!/bin/sh
set -e

# ORCA default entrypoint: no pre-launch steps declared — hand straight off to the CMD.
exec "$@"
`;

/** Repo-relative path (forward slashes) for a file inside a compose build context. */
function inContext(context: string, name: string): string {
  return context === '.' ? name : `${context.replace(/^\.\//, '')}/${name}`;
}

/**
 * Render every config for the approved plan and write it into the workspace.
 * Existing repo files are only ever shadowed inside ORCA's temp copy — the
 * original repo is never touched.
 */
export async function writeConfigs(ctx: RunContext): Promise<GeneratedFile[]> {
  const { detection, plan } = ctx;
  if (detection === undefined || plan === undefined) {
    throw new OrcaError('writeConfigs called before detection/plan were populated.', 'INTERNAL');
  }
  const filled = ctx.filled ?? {};

  const generated: GeneratedFile[] = [];
  const write = async (relPath: string, contents: string, kind: GeneratedFile['kind']) => {
    await writeFile(join(ctx.workspaceDir, relPath), contents, 'utf8');
    generated.push({ path: relPath, kind });
  };

  const contextsSeen = new Set<string>();
  for (const role of ['backend', 'frontend'] as const) {
    const component = role === 'backend' ? detection.backend : detection.frontend;
    const node = plan.services.find((s) => s.id === role);
    if (component === null || node === undefined || node.source.type !== 'build') continue;

    const vars = refinedComponentVars(component, role, filled);
    // Seed stacks render their hand-verified template; the `dockerfileFor` seam is
    // where ecosystem/inferred components will synthesize instead (open-role work).
    await write(
      inContext(node.source.context, node.source.dockerfile),
      dockerfileFor({ kind: 'template', vars }),
      'dockerfile'
    );

    // One .dockerignore per build context (roles can share a context).
    if (!contextsSeen.has(node.source.context)) {
      contextsSeen.add(node.source.context);
      await write(inContext(node.source.context, '.dockerignore'), DOCKERIGNORE, 'dockerignore');
    }

    // The Dockerfile COPYs the entrypoint script; supply ORCA's default only when
    // the repo doesn't ship its own (a repo-provided script is app source — keep it).
    if (vars.entrypointScript !== undefined) {
      const relPath = inContext(node.source.context, vars.entrypointScript);
      if ((await readFileIfExists(join(ctx.workspaceDir, relPath))) === null) {
        await write(relPath, DJANGO_ENTRYPOINT, 'entrypoint');
        await chmod(join(ctx.workspaceDir, relPath), 0o755);
      }
    }
  }

  // Ecosystem/inferred 'service' nodes: synthesize a Dockerfile from the recipe the
  // plan carried inline on the build source. The recipe travels with the node (not by
  // id lookup), so AI-inferred `ai-*` recipes synthesize the same way. One
  // .dockerignore per context.
  for (const node of plan.services) {
    if (node.kind !== 'service' || node.source.type !== 'build' || !node.source.recipe) continue;
    const { recipe } = node.source;

    await write(
      inContext(node.source.context, node.source.dockerfile),
      dockerfileFor({ kind: 'recipe', recipe }),
      'dockerfile'
    );
    if (!contextsSeen.has(node.source.context)) {
      contextsSeen.add(node.source.context);
      await write(
        inContext(node.source.context, '.dockerignore'),
        dockerignoreFor(recipe.runtime),
        'dockerignore'
      );
    }

    // The synthesizer emits `COPY <entrypointScript>` + `ENTRYPOINT` when the recipe
    // declares one. Supply a passthrough default so that COPY resolves, unless the repo
    // already ships the script (then it's app source — keep it, never overwrite).
    if (recipe.entrypointScript !== undefined && recipe.entrypointScript !== '') {
      const relPath = inContext(node.source.context, recipe.entrypointScript);
      if ((await readFileIfExists(join(ctx.workspaceDir, relPath))) === null) {
        await write(relPath, PASSTHROUGH_ENTRYPOINT, 'entrypoint');
        await chmod(join(ctx.workspaceDir, relPath), 0o755);
      }
    }
  }

  // AI-inferred app env: same selection the plan used to decide `env_file`, so the
  // file exists exactly when the compose file references it.
  if (ctx.inferredEnv !== undefined) {
    const envText = buildEnvFile(ctx.inferredEnv, plan);
    if (envText !== '') await write('.env', envText, 'env');
  }

  await write('docker-compose.yml', renderCompose(planToComposeVars(plan)), 'compose');

  ctx.generatedFiles.push(...generated);
  return generated;
}
