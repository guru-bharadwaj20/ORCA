import type { DockerfileVars } from '../templates/types.js';
import type { FilledTemplateVars } from './schema.js';

export function refineDockerfileVars(
  defaults: DockerfileVars,
  filled: FilledTemplateVars
): DockerfileVars {
  const v = filled.variables;
  const out: DockerfileVars = { ...defaults };

  if (v.baseImage !== undefined) out.baseImage = v.baseImage;
  if (v.workdir !== undefined) out.workdir = v.workdir;
  if (v.packageManager !== undefined) out.packageManager = v.packageManager;
  if (v.dependencyFiles !== undefined && v.dependencyFiles.length > 0) {
    out.dependencyFiles = v.dependencyFiles;
  }
  if (v.installCommand !== undefined) out.installCommand = v.installCommand;
  if (v.buildCommand !== undefined) out.buildCommand = v.buildCommand;
  if (v.startCommand !== undefined) out.startCommand = v.startCommand;
  if (v.port !== undefined) {
    out.port = v.port;
    // Keep the primary in sync with the full list when the defaults had one — replace
    // index 0 (the old primary), keep any other detected ports (e.g. a Dockerfile
    // sidecar port) as-is. Vars with no `ports` at all (older/hand-built call sites)
    // stay that way; the render fallback (`[port]`) still applies.
    if (defaults.ports !== undefined) out.ports = [v.port, ...defaults.ports.slice(1)];
  }
  if (v.systemPackages !== undefined) out.systemPackages = v.systemPackages;
  if (v.entrypointScript !== undefined) out.entrypointScript = v.entrypointScript;

  return out;
}
