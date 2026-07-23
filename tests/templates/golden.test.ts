import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { renderCompose, renderDockerfile } from '../../src/templates/render.js';
import {
  djangoComposeVars,
  djangoDockerfileVars,
  mernClientDockerfileVars,
  mernComposeVars,
  mernServerDockerfileVars,
} from './sampleVars.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function normalize(text: string): string {
  return (
    text
      .replace(/\r\n/g, '\n')
      .replace(/[ \t]+$/gm, '')
      .replace(/\n+$/, '') + '\n'
  );
}

function readGolden(...segments: string[]): string {
  return readFileSync(join(repoRoot, 'examples', ...segments), 'utf8');
}

describe('golden Dockerfiles render losslessly', () => {
  it('MERN client Dockerfile matches its golden file', () => {
    const rendered = renderDockerfile(mernClientDockerfileVars);
    const golden = readGolden('mern-sample', '.orca-golden', 'client.Dockerfile');
    expect(normalize(rendered)).toBe(normalize(golden));
  });

  it('MERN server Dockerfile matches its golden file', () => {
    const rendered = renderDockerfile(mernServerDockerfileVars);
    const golden = readGolden('mern-sample', '.orca-golden', 'server.Dockerfile');
    expect(normalize(rendered)).toBe(normalize(golden));
  });

  it('Django Dockerfile matches its golden file', () => {
    const rendered = renderDockerfile(djangoDockerfileVars);
    const golden = readGolden('django-postgres-sample', '.orca-golden', 'Dockerfile');
    expect(normalize(rendered)).toBe(normalize(golden));
  });
});

describe('golden docker-compose files render losslessly', () => {
  it('MERN docker-compose.yml matches its golden file', () => {
    const rendered = renderCompose(mernComposeVars);
    const golden = readGolden('mern-sample', '.orca-golden', 'docker-compose.yml');
    expect(normalize(rendered)).toBe(normalize(golden));
  });

  it('Django docker-compose.yml matches its golden file', () => {
    const rendered = renderCompose(djangoComposeVars);
    const golden = readGolden('django-postgres-sample', '.orca-golden', 'docker-compose.yml');
    expect(normalize(rendered)).toBe(normalize(golden));
  });
});
