import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import { detectStack } from '../../src/detect/index.js';
import { planToComposeVars } from '../../src/generate/composeVars.js';
import { buildServicePlan } from '../../src/plan/servicePlan.js';
import { renderCompose } from '../../src/templates/render.js';

const fixture = (name: string): string =>
  fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

const SUPPORTED_FIXTURES = ['mern-repo', 'django-postgres-repo', 'express-dbconfig-repo'];

interface ComposeDoc {
  name?: unknown;
  services?: unknown;
  networks?: unknown;
  volumes?: unknown;
}

function isMapping(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function composeFor(name: string): Promise<{ text: string; doc: ComposeDoc }> {
  const detection = await detectStack(fixture(name));
  const plan = buildServicePlan(detection, {});
  const text = renderCompose(planToComposeVars(plan));
  return { text, doc: parseYaml(text) as ComposeDoc };
}

describe('every supported fixture renders a structurally valid compose file', () => {
  for (const name of SUPPORTED_FIXTURES) {
    it(`${name}: top-level keys are mappings, never null`, async () => {
      const { doc } = await composeFor(name);

      expect(typeof doc.name).toBe('string');
      expect(isMapping(doc.services)).toBe(true);
      expect(isMapping(doc.networks)).toBe(true);

      // Docker rejects `volumes:` with a null body ("volumes must be a mapping"),
      // so the key has to be a real mapping or absent entirely.
      if ('volumes' in doc) expect(isMapping(doc.volumes)).toBe(true);
    });

    it(`${name}: every service has a source and no null blocks`, async () => {
      const { doc } = await composeFor(name);
      const services = doc.services as Record<string, Record<string, unknown>>;

      expect(Object.keys(services).length).toBeGreaterThan(0);
      for (const [id, service] of Object.entries(services)) {
        expect(isMapping(service), `${id} should be a mapping`).toBe(true);

        const hasSource = 'image' in service || 'build' in service;
        expect(hasSource, `${id} needs an image or a build`).toBe(true);

        for (const [key, value] of Object.entries(service)) {
          expect(value, `${id}.${key} must not be null`).not.toBeNull();
        }
      }
    });

    it(`${name}: publishes each host port at most once`, async () => {
      const { doc } = await composeFor(name);
      const services = doc.services as Record<string, { ports?: string[] }>;

      const hostPorts = Object.values(services)
        .flatMap((s) => s.ports ?? [])
        .map((binding) => binding.split(':')[0]);

      expect(hostPorts).toEqual([...new Set(hostPorts)]);
    });
  }
});
