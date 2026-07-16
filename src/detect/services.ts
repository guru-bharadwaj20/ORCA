/**
 * Detects backing services (Postgres / MongoDB / Redis) the app needs, inferred from
 * dependencies: pg/sequelize/prisma/psycopg2 -> postgres, mongoose/pymongo -> mongodb,
 * redis/ioredis -> redis. NO AI.
 *
 * STAGE: 2 (detect) — REAL code.
 * Inputs: an absolute component root path (or the whole repo).
 * Outputs: the list of `DetectedDatabase`s the app depends on.
 */

import { readAllDependencies } from './manifest.js';
import type { DatabaseEngine, DetectedDatabase } from './types.js';

const DEFAULT_DB_PORT: Record<DatabaseEngine, number> = {
  postgres: 5432,
  mongodb: 27017,
  redis: 6379,
};

/**
 * Client libraries that reveal each engine, across both ecosystems. Sequelize and
 * Prisma are multi-database ORMs; within ORCA's supported stacks they are treated
 * as a Postgres signal (MongoDB apps in scope use mongoose/mongodb directly).
 */
const ENGINE_LIBRARIES: Record<DatabaseEngine, string[]> = {
  postgres: [
    'pg',
    'pg-promise',
    'postgres',
    'sequelize',
    'prisma',
    'psycopg2',
    'psycopg2-binary',
    'psycopg',
    'asyncpg',
  ],
  mongodb: ['mongoose', 'mongodb', 'pymongo', 'mongoengine', 'motor', 'djongo'],
  redis: ['redis', 'ioredis', 'django-redis', 'aioredis'],
};

/** Map known client libraries in the manifest to their database engine + default port. */
export async function detectServices(componentPath: string): Promise<DetectedDatabase[]> {
  const deps = new Set(await readAllDependencies(componentPath));
  const found: DetectedDatabase[] = [];

  for (const engine of Object.keys(ENGINE_LIBRARIES) as DatabaseEngine[]) {
    const library = ENGINE_LIBRARIES[engine].find((lib) => deps.has(lib));
    if (library !== undefined) {
      found.push({ engine, defaultPort: DEFAULT_DB_PORT[engine], detectedFrom: library });
    }
  }

  return found;
}
