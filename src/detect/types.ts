export type Language = 'javascript' | 'typescript' | 'python' | 'unknown';

export type PackageManager = 'npm' | 'yarn' | 'pnpm' | 'pip' | 'poetry' | 'unknown';

export type FrontendFramework = 'react' | 'unknown';

export type BackendFramework = 'express' | 'django' | 'unknown';

export type DatabaseEngine = 'postgres' | 'mongodb' | 'redis';

export type ComponentRole = 'frontend' | 'backend' | 'database';

export interface DetectedPort {
  port: number;
  protocol: 'tcp' | 'udp';
  source: 'default' | 'code' | 'env' | 'dockerfile' | 'readme' | 'inferred';
}

export interface Entrypoint {
  role: ComponentRole;
  command: string;
  workingDir: string;
  source: 'package-json-script' | 'procfile' | 'manage-py' | 'readme' | 'inferred';
}

export interface DetectedComponent {
  role: Extract<ComponentRole, 'frontend' | 'backend'>;
  rootDir: string;
  language: Language;
  packageManager: PackageManager;
  framework: FrontendFramework | BackendFramework | 'unknown';
  dependencies: string[];
  ports: DetectedPort[];
  entrypoint: Entrypoint | null;
}

export interface DetectedDatabase {
  engine: DatabaseEngine;
  defaultPort: number;
  detectedFrom: string;
}

export interface DetectionWarning {
  code: string;
  message: string;
  detector: string;
}

export interface DetectionResult {
  repoPath: string;
  languages: Language[];
  packageManagers: PackageManager[];
  frontend: DetectedComponent | null;
  backend: DetectedComponent | null;
  databases: DetectedDatabase[];
  isSupported: boolean;
  confidence: number;
  warnings: DetectionWarning[];
}
