import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { renderCompose } from '../../src/templates/render.js';
import { djangoComposeVars, mernComposeVars } from './sampleVars.js';

describe('renderCompose produces valid YAML', () => {
  it('MERN compose parses and has the expected services + wiring', () => {
    const doc = parse(renderCompose(mernComposeVars));

    expect(doc.name).toBe('orca-mern-sample');
    expect(Object.keys(doc.services)).toEqual(['mongo', 'server', 'client']);

    expect(doc.services.mongo.image).toBe('mongo:7');
    expect(doc.services.mongo.build).toBeUndefined();
    expect(doc.services.mongo.healthcheck.test).toEqual([
      'CMD',
      'mongosh',
      '--eval',
      "db.adminCommand('ping')",
    ]);

    expect(doc.services.server.build).toEqual({ context: './server', dockerfile: 'Dockerfile' });
    expect(doc.services.server.image).toBeUndefined();
    expect(doc.services.server.depends_on).toEqual(['mongo']);
    expect(doc.services.server.ports).toEqual(['5000:5000']);
    expect(doc.services.server.environment.MONGO_URL).toBe('mongodb://mongo:27017/orca');

    expect(doc.networks['orca-mern-net'].driver).toBe('bridge');
    expect(doc.volumes).toHaveProperty('mongo-data');
  });

  it('Django compose parses and has the expected services + wiring', () => {
    const doc = parse(renderCompose(djangoComposeVars));

    expect(doc.name).toBe('orca-django-sample');
    expect(Object.keys(doc.services)).toEqual(['db', 'web']);

    expect(doc.services.db.image).toBe('postgres:16');
    expect(doc.services.db.healthcheck.test).toEqual(['CMD-SHELL', 'pg_isready -U orca']);
    expect(doc.services.db.healthcheck.retries).toBe(5);

    expect(doc.services.web.build).toEqual({ context: '.', dockerfile: 'Dockerfile' });
    expect(doc.services.web.depends_on).toEqual(['db']);
    expect(doc.services.web.environment.POSTGRES_HOST).toBe('db');

    expect(doc.networks['orca-django-net'].driver).toBe('bridge');
    expect(doc.volumes).toHaveProperty('postgres-data');
  });

  it('omits empty environment blocks (mongo has none)', () => {
    const doc = parse(renderCompose(mernComposeVars));
    expect(doc.services.mongo.environment).toBeUndefined();
  });

  it('omits the top-level volumes key entirely when there are no named volumes', () => {
    const noVolumes = { ...mernComposeVars, namedVolumes: [] };
    const rendered = renderCompose(noVolumes);
    const doc = parse(rendered);

    expect(rendered).not.toMatch(/^volumes:/m);
    expect('volumes' in doc).toBe(false);
    expect(doc.networks['orca-mern-net'].driver).toBe('bridge');
  });
});
