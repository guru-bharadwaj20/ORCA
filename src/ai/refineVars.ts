/**
 * The typed boundary between AI output and the template contract: merges validated
 * `FilledTemplateVars` onto the registry's deterministic `DockerfileVars` defaults.
 * Downstream stages (plan, generate) consume the result and never touch raw AI output.
 *
 * STAGE: 3 (ai) — REAL code.
 * Inputs: the registry defaults for a component + the AI's validated refinements.
 * Outputs: a complete, render-ready `DockerfileVars`.
 */

import type { DockerfileVars } from '../templates/types.js';
import type { FilledTemplateVars } from './schema.js';

/**
 * Field-by-field merge: an AI-supplied value overrides the default; anything the AI
 * omitted keeps the deterministic fallback. An empty `dependencyFiles` cannot override
 * the default (a Dockerfile with nothing to COPY before install would always break);
 * an empty `systemPackages` is meaningful ("none needed") and is kept.
 */
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
  if (v.port !== undefined) out.port = v.port;
  if (v.systemPackages !== undefined) out.systemPackages = v.systemPackages;
  if (v.entrypointScript !== undefined) out.entrypointScript = v.entrypointScript;

  return out;
}
