/**
 * Pure Handlebars renderer for the Stage 1 templates. Turns a `DockerfileVars` /
 * `ComposeVars` render-context into the exact text of a Dockerfile / docker-compose.yml.
 *
 * STAGE: 1 (templates) — REAL code.
 * Inputs: a fully-populated `DockerfileVars` or `ComposeVars`.
 * Outputs: the rendered file contents as a string.
 *
 * NO file I/O for OUTPUT (writing generated files to disk is generate/writeConfigs.ts,
 * a later stage). This module only READS its own `.hbs` template files, compiles them,
 * and returns strings — deterministic and side-effect free.
 */

import Handlebars from 'handlebars';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ComposeVars, DockerfileVars } from './types.js';

const templatesDir = dirname(fileURLToPath(import.meta.url));

/** Create an isolated Handlebars environment so helper registration can't leak globally. */
function createEnv(): typeof Handlebars {
  const hb = Handlebars.create();

  // Join a string[] with a separator (used for dependencyFiles / systemPackages).
  hb.registerHelper('join', (arr: unknown, sep: unknown) =>
    Array.isArray(arr) ? arr.join(typeof sep === 'string' ? sep : ' ') : ''
  );

  // Render a string[] as a JSON-style flow array WITH spaces: "a", "b", "c"
  // (used for a compose healthcheck `test`).
  hb.registerHelper('quoteJoin', (arr: unknown) =>
    Array.isArray(arr) ? arr.map((x) => JSON.stringify(x)).join(', ') : ''
  );

  // Truthy only when the value actually has entries — arrays by length, objects by key
  // count. Handlebars' built-in `if` treats an empty object/array as truthy, which would
  // emit an empty `environment:` / `volumes:` block, so guard with this instead.
  hb.registerHelper('hasItems', (v: unknown) => {
    if (Array.isArray(v)) return v.length > 0;
    if (v && typeof v === 'object') return Object.keys(v).length > 0;
    return false;
  });

  return hb;
}

const env = createEnv();

function compileTemplate(relativePath: string): HandlebarsTemplateDelegate {
  const source = readFileSync(join(templatesDir, relativePath), 'utf8');
  return env.compile(source, { noEscape: false });
}

// Compiled once and reused; templates are static files.
const nodeDockerfileTemplate = compileTemplate('dockerfiles/node.Dockerfile.hbs');
const pythonDockerfileTemplate = compileTemplate('dockerfiles/python.Dockerfile.hbs');
const composeTemplate = compileTemplate('compose/docker-compose.hbs');

/** True for the Python toolchain, inferred from the package manager. */
function isPythonPackageManager(vars: DockerfileVars): boolean {
  return vars.packageManager === 'pip' || vars.packageManager === 'poetry';
}

/**
 * Render a Dockerfile. The template is chosen from `vars.packageManager`
 * (pip/poetry -> Python/Django; npm/yarn/pnpm -> Node client/server).
 */
export function renderDockerfile(vars: DockerfileVars): string {
  const template = isPythonPackageManager(vars) ? pythonDockerfileTemplate : nodeDockerfileTemplate;
  return template(vars);
}

/** Render a full docker-compose.yml from a service graph. */
export function renderCompose(vars: ComposeVars): string {
  return composeTemplate(vars);
}
