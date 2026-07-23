import { readNodeDependencies, readPythonDependencies } from './manifest.js';
import type { FrontendFramework, BackendFramework } from './types.js';

export async function detectFrontendFramework(componentPath: string): Promise<FrontendFramework> {
  const deps = await readNodeDependencies(componentPath);
  if (deps.includes('react') || deps.includes('react-dom')) return 'react';
  return 'unknown';
}

export async function detectBackendFramework(componentPath: string): Promise<BackendFramework> {
  const nodeDeps = await readNodeDependencies(componentPath);
  if (nodeDeps.includes('express')) return 'express';

  const pythonDeps = await readPythonDependencies(componentPath);
  if (pythonDeps.includes('django')) return 'django';

  return 'unknown';
}
