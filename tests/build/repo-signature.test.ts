import { describe, it, expect } from 'vitest';

import { repoShapeFrom } from '../../src/build/repoSignature.js';

describe('shape covers every component, not just two slots', () => {
  it('fingerprints frameworks from components[] when present', () => {
    // The N-component list is authoritative; the two legacy slots each surface only one
    // entry, so reading them would miss a third service and let a stale override survive.
    const ctx = {
      repoUrl: 'https://github.com/o/r.git',
      detection: {
        languages: ['javascript'],
        components: [{ framework: 'express' }, { framework: 'react' }, { framework: 'nestjs' }],
        frontend: { framework: 'react' },
        backend: { framework: 'express' },
      },
      plan: { services: [] },
    } as never;

    expect(repoShapeFrom(ctx).frameworks).toEqual(['express', 'nestjs', 'react']);
  });

  it('is empty when no components were detected', () => {
    // `components[]` is now the authoritative list and always present, so there is no
    // legacy frontend/backend fallback to reach for — an empty list means an empty shape.
    const ctx = {
      repoUrl: 'https://github.com/o/r.git',
      detection: { languages: ['python'], components: [] },
      plan: { services: [] },
    } as never;

    expect(repoShapeFrom(ctx).frameworks).toEqual([]);
  });

  it('drops unknown frameworks from the shape', () => {
    const ctx = {
      repoUrl: '/local/path',
      detection: { languages: [], components: [{ framework: 'unknown' }, { framework: 'gin' }] },
      plan: { services: [] },
    } as never;

    expect(repoShapeFrom(ctx).frameworks).toEqual(['gin']);
  });
});
