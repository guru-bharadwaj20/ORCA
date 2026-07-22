export type ServiceKind = 'frontend' | 'backend' | 'database' | 'cache';

export type ServiceSource =
  { type: 'build'; context: string; dockerfile: string } | { type: 'image'; image: string };

export interface PortBinding {
  host: number;
  container: number;
  protocol: 'tcp' | 'udp';
}

export interface VolumeMount {
  source: string;
  target: string;
  kind: 'named' | 'bind' | 'anonymous';
}

export interface Healthcheck {
  test: string[];
  interval: string;
  timeout: string;
  retries: number;
  startPeriod?: string;
}

export interface ServiceDependency {
  serviceId: string;
  condition: 'service_started' | 'service_healthy' | 'service_completed_successfully';
}

export interface ServiceNode {
  id: string;
  name: string;
  kind: ServiceKind;
  source: ServiceSource;
  ports: PortBinding[];
  environment: Record<string, string>;
  dependsOn: ServiceDependency[];
  volumes: VolumeMount[];
  envFile?: string;
  healthcheck?: Healthcheck;
  command?: string;
}

export interface ServicePlan {
  projectName: string;
  services: ServiceNode[];
  networks: string[];
  volumes: string[];
  createdAt: string;
  source: 'template' | 'ai' | 'user-edited';
}
