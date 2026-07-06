/**
 * Thin, typed wrappers over the `docker` and `docker compose` CLIs (via execa). This
 * is the ONLY module that shells out to docker; everything else stays testable by
 * mocking these functions.
 *
 * STAGE: 5 (build)
 * Inputs: a compose file path / project dir + command args.
 * Outputs: captured stdout/stderr + exit codes.
 */

/** The captured result of running a docker/compose command. */
export interface DockerCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

// TODO(stage-5): verify the docker daemon is reachable.
export async function assertDockerAvailable(): Promise<void> {
  throw new Error('not implemented');
}

// TODO(stage-5): run `docker compose build` in the given project dir.
export async function composeBuild(_projectDir: string): Promise<DockerCommandResult> {
  throw new Error('not implemented');
}

// TODO(stage-5): run `docker compose up -d` in the given project dir.
export async function composeUp(_projectDir: string): Promise<DockerCommandResult> {
  throw new Error('not implemented');
}

// TODO(stage-5): run `docker compose down` to tear everything down.
export async function composeDown(_projectDir: string): Promise<DockerCommandResult> {
  throw new Error('not implemented');
}

// TODO(stage-5): fetch recent logs for a service to feed the self-heal diagnosis.
export async function composeLogs(
  _projectDir: string,
  _service: string
): Promise<DockerCommandResult> {
  throw new Error('not implemented');
}
