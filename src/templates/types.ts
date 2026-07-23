export type PackageManager = 'npm' | 'yarn' | 'pnpm' | 'pip' | 'poetry' | 'uv';

export type ServiceKind = 'frontend' | 'backend' | 'database';

export interface DockerfileVars {
  baseImage: string;
  workdir: string;
  packageManager: PackageManager;
  dependencyFiles: string[];
  installCommand: string;
  buildCommand?: string;
  startCommand: string;
  port: number;
  systemPackages?: string[];
  entrypointScript?: string;
}

export interface ServiceSpec {
  name: string;
  kind: ServiceKind;
  image?: string;
  build?: { context: string; dockerfile: string };
  ports: string[];
  environment: Record<string, string>;
  envFile?: string;
  dependsOn: (string | { service: string; condition: string })[];
  volumes: string[];
  healthcheck?: {
    test: string[];
    interval: string;
    timeout: string;
    retries: number;
  };
}

export interface ComposeVars {
  projectName: string;
  services: ServiceSpec[];
  networkName: string;
  namedVolumes: string[];
}
