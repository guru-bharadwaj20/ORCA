import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { GeneratedFile, RunContext } from '../core/context.js';
import { buildEnvFile } from '../orchestrate/envFiles.js';
import { refinedComponentVars } from '../plan/servicePlan.js';
import { renderCompose, renderDockerfile } from '../templates/render.js';
import { OrcaError } from '../utils/errors.js';
import { readFileIfExists } from '../utils/fs.js';
import { planToComposeVars } from './composeVars.js';

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

function inContext(context: string, name: string): string {
  return context === '.' ? name : `${context.replace(/^\.\//, '')}/${name}`;
}

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
    await write(
      inContext(node.source.context, node.source.dockerfile),
      renderDockerfile(vars),
      'dockerfile'
    );

    if (!contextsSeen.has(node.source.context)) {
      contextsSeen.add(node.source.context);
      await write(inContext(node.source.context, '.dockerignore'), DOCKERIGNORE, 'dockerignore');
    }

    if (vars.entrypointScript !== undefined) {
      const relPath = inContext(node.source.context, vars.entrypointScript);
      if ((await readFileIfExists(join(ctx.workspaceDir, relPath))) === null) {
        await write(relPath, DJANGO_ENTRYPOINT, 'entrypoint');
        await chmod(join(ctx.workspaceDir, relPath), 0o755);
      }
    }
  }

  if (ctx.inferredEnv !== undefined) {
    const envText = buildEnvFile(ctx.inferredEnv, plan);
    if (envText !== '') await write('.env', envText, 'env');
  }

  await write('docker-compose.yml', renderCompose(planToComposeVars(plan)), 'compose');

  ctx.generatedFiles.push(...generated);
  return generated;
}
