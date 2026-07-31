import Handlebars from 'handlebars';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ComposeVars } from './types.js';

const templatesDir = dirname(fileURLToPath(import.meta.url));

/**
 * Handlebars renders the COMPOSE file only. Dockerfiles are synthesized from recipes by
 * `synthesizeDockerfile` — one renderer, seed and ecosystem alike — so the `join` and
 * `exposeLines` helpers that existed for `node.Dockerfile.hbs` / `python.Dockerfile.hbs`
 * went with those templates.
 */
function createEnv(): typeof Handlebars {
  const hb = Handlebars.create();

  hb.registerHelper('quoteJoin', (arr: unknown) =>
    Array.isArray(arr) ? arr.map((x) => JSON.stringify(x)).join(', ') : ''
  );

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

const composeTemplate = compileTemplate('compose/docker-compose.hbs');

export function renderCompose(vars: ComposeVars): string {
  return composeTemplate(vars);
}
