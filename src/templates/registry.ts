/**
 * Maps a `DetectionResult` to the hand-written Handlebars templates that should be
 * rendered for it (which Dockerfile per component, the compose template, etc.).
 * The templates themselves are static, hand-authored files under this directory.
 *
 * STAGE: 1 (templates)
 * Inputs: a `DetectionResult`.
 * Outputs: the set of template descriptors to render for this repo.
 */

import type { DetectionResult } from '../detect/types.js';

/** A pointer to a Handlebars template on disk plus the role it fills. */
export interface TemplateDescriptor {
  /** Logical id, e.g. 'node.Dockerfile', 'python.Dockerfile', 'docker-compose'. */
  id: string;
  /** Absolute or package-relative path to the .hbs file. */
  path: string;
  /** What this template produces. */
  produces: 'dockerfile' | 'compose';
  /** Which component it is for (null for whole-project templates like compose). */
  role: 'frontend' | 'backend' | null;
}

// TODO(stage-1): pick the correct Dockerfile template per component based on language.
export function selectTemplates(_detection: DetectionResult): TemplateDescriptor[] {
  throw new Error('not implemented');
}

// TODO(stage-1): read and compile a Handlebars template file by descriptor.
export async function loadTemplate(_descriptor: TemplateDescriptor): Promise<HandlebarsTemplateDelegate> {
  throw new Error('not implemented');
}
