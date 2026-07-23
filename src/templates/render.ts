import Handlebars from 'handlebars';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ComposeVars, DockerfileVars } from './types.js';

const templatesDir = dirname(fileURLToPath(import.meta.url));

function createEnv(): typeof Handlebars {
  const hb = Handlebars.create();

  hb.registerHelper('join', (arr: unknown, sep: unknown) =>
    Array.isArray(arr) ? arr.join(typeof sep === 'string' ? sep : ' ') : ''
  );

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

const nodeDockerfileTemplate = compileTemplate('dockerfiles/node.Dockerfile.hbs');
const pythonDockerfileTemplate = compileTemplate('dockerfiles/python.Dockerfile.hbs');
const composeTemplate = compileTemplate('compose/docker-compose.hbs');

function isPythonPackageManager(vars: DockerfileVars): boolean {
  return vars.packageManager === 'pip' || vars.packageManager === 'poetry';
}

export function renderDockerfile(vars: DockerfileVars): string {
  const template = isPythonPackageManager(vars) ? pythonDockerfileTemplate : nodeDockerfileTemplate;
  return template(vars);
}

export function renderCompose(vars: ComposeVars): string {
  return composeTemplate(vars);
}
