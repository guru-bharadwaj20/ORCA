// Hand-written template inputs for the golden tests. These deliberately use the
// bundled samples' service names (mongo/server/client, db/web) rather than the ids
// the planner emits (db/backend/frontend), because the goldens under
// examples/*/.orca-golden/ are reference output for the templates alone.
//
// They therefore prove nothing about buildServicePlan -> planToComposeVars. That path
// is covered against real fixtures by tests/plan/composeShape.test.ts and the
// round-trip case in tests/plan/plan.test.ts; keep both in mind when changing either.
import type { ComposeVars, DockerfileVars } from '../../src/templates/types.js';

export const mernClientDockerfileVars: DockerfileVars = {
  baseImage: 'node:20-slim',
  workdir: '/app',
  packageManager: 'npm',
  dependencyFiles: ['package.json'],
  installCommand: 'npm install',
  startCommand: 'npm run dev',
  port: 5173,
};

export const mernServerDockerfileVars: DockerfileVars = {
  baseImage: 'node:20-slim',
  workdir: '/app',
  packageManager: 'npm',
  dependencyFiles: ['package.json'],
  installCommand: 'npm install',
  startCommand: 'npm run dev',
  port: 5000,
};

export const mernComposeVars: ComposeVars = {
  projectName: 'orca-mern-sample',
  networkName: 'orca-mern-net',
  namedVolumes: ['mongo-data'],
  services: [
    {
      name: 'mongo',
      kind: 'database',
      image: 'mongo:7',
      ports: ['27017:27017'],
      environment: {},
      dependsOn: [],
      volumes: ['mongo-data:/data/db'],
      healthcheck: {
        test: ['CMD', 'mongosh', '--eval', "db.adminCommand('ping')"],
        interval: '10s',
        timeout: '5s',
        retries: 5,
      },
    },
    {
      name: 'server',
      kind: 'backend',
      build: { context: './server', dockerfile: 'Dockerfile' },
      ports: ['5000:5000'],
      environment: {
        NODE_ENV: 'development',
        PORT: '5000',
        MONGO_URL: 'mongodb://mongo:27017/orca',
      },
      dependsOn: ['mongo'],
      volumes: ['./server:/app', '/app/node_modules'],
    },
    {
      name: 'client',
      kind: 'frontend',
      build: { context: './client', dockerfile: 'Dockerfile' },
      ports: ['5173:5173'],
      environment: {
        VITE_API_URL: 'http://localhost:5000',
      },
      dependsOn: ['server'],
      volumes: ['./client:/app', '/app/node_modules'],
    },
  ],
};

export const djangoDockerfileVars: DockerfileVars = {
  baseImage: 'python:3.12-slim',
  workdir: '/app',
  packageManager: 'pip',
  dependencyFiles: ['requirements.txt'],
  installCommand: 'pip install -r requirements.txt',
  startCommand: 'python manage.py runserver 0.0.0.0:8000',
  port: 8000,
  systemPackages: ['libpq-dev', 'gcc'],
  entrypointScript: 'entrypoint.sh',
};

export const djangoComposeVars: ComposeVars = {
  projectName: 'orca-django-sample',
  networkName: 'orca-django-net',
  namedVolumes: ['postgres-data'],
  services: [
    {
      name: 'db',
      kind: 'database',
      image: 'postgres:16',
      ports: ['5432:5432'],
      environment: {
        POSTGRES_DB: 'orca',
        POSTGRES_USER: 'orca',
        POSTGRES_PASSWORD: 'orca',
      },
      dependsOn: [],
      volumes: ['postgres-data:/var/lib/postgresql/data'],
      healthcheck: {
        test: ['CMD-SHELL', 'pg_isready -U orca'],
        interval: '5s',
        timeout: '5s',
        retries: 5,
      },
    },
    {
      name: 'web',
      kind: 'backend',
      build: { context: '.', dockerfile: 'Dockerfile' },
      ports: ['8000:8000'],
      environment: {
        DJANGO_DEBUG: '1',
        POSTGRES_DB: 'orca',
        POSTGRES_USER: 'orca',
        POSTGRES_PASSWORD: 'orca',
        POSTGRES_HOST: 'db',
        POSTGRES_PORT: '5432',
      },
      dependsOn: ['db'],
      volumes: ['.:/app'],
    },
  ],
};
