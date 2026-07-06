/**
 * Detects backing services (Postgres / MongoDB / Redis) the app needs, inferred from
 * dependencies: pg/sequelize/prisma/psycopg2 -> postgres, mongoose/pymongo -> mongodb,
 * redis/ioredis -> redis. NO AI.
 *
 * STAGE: 2 (detect)
 * Inputs: an absolute component root path (or the whole repo).
 * Outputs: the list of `DetectedDatabase`s the app depends on.
 */

import type { DetectedDatabase } from './types.js';

// TODO(stage-2): map known client libraries to their database engine + default port.
export async function detectServices(_componentPath: string): Promise<DetectedDatabase[]> {
  throw new Error('not implemented');
}
