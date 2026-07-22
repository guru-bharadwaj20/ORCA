import { readAllDependencies } from './manifest.js';
import type { DatabaseEngine, DetectedDatabase } from './types.js';

const DEFAULT_DB_PORT: Record<DatabaseEngine, number> = {
  postgres: 5432,
  mongodb: 27017,
  redis: 6379,
};

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
