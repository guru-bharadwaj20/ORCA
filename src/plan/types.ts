/**
 * Shared data contract: the service graph that ORCA shows the user for approval
 * BEFORE anything is built or run (headline feature: approve-before-build).
 *
 * STAGE: 4 (plan)
 * REAL CODE — `ServicePlan` is the single source of truth that the diagram renderer,
 * the review gate, the config generator, and the build/self-heal loop all operate on.
 *
 * Inputs (conceptual): a `DetectionResult` + AI-filled templates.
 * Outputs: a `ServicePlan` describing every container, its wiring, and startup order.
 *
 * The shape maps cleanly onto a docker-compose service so `generate/writeConfigs.ts`
 * can render it without a second modelling step.
 */

/** The kind of service a node represents. */
export type ServiceKind = 'frontend' | 'backend' | 'database' | 'cache';

/** How a service's image is obtained: built from a Dockerfile or pulled from a registry. */
export type ServiceSource =
  { type: 'build'; context: string; dockerfile: string } | { type: 'image'; image: string };

/** A published port mapping (host:container). */
export interface PortBinding {
  host: number;
  container: number;
  protocol: 'tcp' | 'udp';
}

/** A mounted volume (named volume, bind mount, or anonymous volume). */
export interface VolumeMount {
  /** Named volume or a host path; empty string for anonymous volumes. */
  source: string;
  /** Absolute path inside the container. */
  target: string;
  /** 'anonymous' = target-only volume (e.g. shielding /app/node_modules from a bind mount). */
  kind: 'named' | 'bind' | 'anonymous';
}

/** A container healthcheck used to gate `depends_on` startup ordering. */
export interface Healthcheck {
  /** Command form of the healthcheck, e.g. `["CMD", "pg_isready", "-U", "postgres"]`. */
  test: string[];
  /** e.g. "10s". */
  interval: string;
  /** e.g. "5s". */
  timeout: string;
  retries: number;
  /** Optional grace period before checks count, e.g. "20s". */
  startPeriod?: string;
}

/**
 * A dependency edge with a condition, mirroring compose's `depends_on` long form.
 * `condition` drives correct startup ordering (STAGE 6).
 */
export interface ServiceDependency {
  /** `id` of the service that must come up first. */
  serviceId: string;
  condition: 'service_started' | 'service_healthy' | 'service_completed_successfully';
}

/** A single container in the plan. */
export interface ServiceNode {
  /** Stable, unique identifier used for edges and compose keys, e.g. "backend". */
  id: string;
  /** Human-friendly display name for the diagram. */
  name: string;
  kind: ServiceKind;
  /** Where the image comes from (build vs pull). */
  source: ServiceSource;
  ports: PortBinding[];
  /** Environment variables to inject (values may reference `.env` keys). */
  environment: Record<string, string>;
  /** Services this node must start after, with their required condition. */
  dependsOn: ServiceDependency[];
  volumes: VolumeMount[];
  /**
   * Optional env file (relative to the compose file, e.g. ".env") injected via
   * compose `env_file`. Inline `environment` values take precedence, so the
   * plan-owned database wiring always wins over .env contents.
   */
  envFile?: string;
  /** Optional healthcheck; databases/caches usually have one. */
  healthcheck?: Healthcheck;
  /** Optional override command; falls back to the image/Dockerfile default. */
  command?: string;
}

/**
 * The full, reviewable plan for a run. Produced by STAGE 4 and gated by the user
 * before STAGE 5 executes anything.
 */
export interface ServicePlan {
  /** docker-compose project name; derived from the repo name. */
  projectName: string;
  /** All containers in dependency order (may still be re-sorted at generate time). */
  services: ServiceNode[];
  /** Named docker networks the services attach to. */
  networks: string[];
  /** Named volumes referenced by any service. */
  volumes: string[];
  /** ISO timestamp of when the plan was assembled. */
  createdAt: string;
  /** Where the plan came from — useful for the explainable log and audit trail. */
  source: 'template' | 'ai' | 'user-edited';
}
