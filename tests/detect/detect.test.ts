/**
 * STAGE 2 tests — static detection against fake repo trees in tests/fixtures.
 * Stubs only: real assertions land when the detectors are implemented.
 */
import { describe, it } from 'vitest';

describe('detect stage', () => {
  // TODO(stage-2): assert detectLanguages/detectPackageManager/etc. against fixtures.
  it.todo('detects a MERN repo as react + express + mongodb');
  it.todo('detects a Django + Postgres repo');
  it.todo('flags an unsupported stack with a warning and isSupported=false');
});
