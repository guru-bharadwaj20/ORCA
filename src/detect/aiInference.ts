/**
 * Tier-3 (AI) build inference — the last rung of the inference ladder. Runs ONLY when
 * the deterministic and CI tiers leave the build under-determined (no matched recipe),
 * so most repos never pay for it. The model proposes a runtime + build/run commands;
 * the response is schema-validated and returned as an `ai`-sourced `Claim`, whose
 * confidence is mechanically capped below any deterministic claim (see
 * `AI_CONFIDENCE_CEILING`). Nothing here bypasses the "AI is a fallback" rule.
 *
 * STAGE: 3 (ai) / PHASE 5 — REAL code. Uses the existing router facade (Qwen→Claude,
 * cost-capped, ledgered); never a bespoke LLM path.
 */

import type { AIFacade } from '../ai/client.js';
import { InferredBuildSchema, type InferredBuild } from '../ai/schema.js';
import type { CostLedger } from '../core/context.js';
import { claim, type Claim, type Evidence } from '../model/claim.js';
import type { BuildRecipe, Runtime } from '../model/recipe.js';

/** The repo context handed to the model: tree + key file contents, already gathered. */
export interface InferenceInput {
  /** Repo-relative file paths (a pruned tree), for the model to reason over. */
  tree: string[];
  /** README text ('' when absent). */
  readme: string;
  /** Any manifest/config snippets worth grounding on (path → contents). */
  snippets: Record<string, string>;
}

/** Build the {system, user} prompt for build inference. */
export function buildInferencePrompt(input: InferenceInput): { system: string; user: string } {
  const system = [
    'You are a build-system analyst. Given a repository’s file tree and key files,',
    'determine how it is built and run. Respond with ONLY a JSON object of shape:',
    '{ "runtime": string, "packageManager"?: string, "installCommands": string[],',
    '  "buildCommands": string[], "startCommand": string, "ports": number[],',
    '  "reasoning": string[], "confidence": number }.',
    'Base every claim on concrete evidence from the provided files and list it in',
    '"reasoning". Do not invent commands a maintainer would not run.',
    '"confidence" is your own honest self-assessment (0.0-1.0) of how well the provided',
    'files actually support this inference — use a low number when you are guessing.',
  ].join('\n');

  const snippetText = Object.entries(input.snippets)
    .map(([path, body]) => `--- ${path} ---\n${body.slice(0, 2000)}`)
    .join('\n\n');

  const user = [
    'File tree:',
    input.tree.slice(0, 200).join('\n'),
    '',
    input.readme ? `README:\n${input.readme.slice(0, 3000)}` : 'README: (none)',
    '',
    snippetText ? `Key files:\n${snippetText}` : '',
  ].join('\n');

  return { system, user };
}

/** Turn a validated inference into the evidence trail behind its Claim. */
function inferenceEvidence(inferred: InferredBuild): Evidence[] {
  // Each reasoning line is one signal; weight is modest and uniform — the AI ceiling,
  // not the per-signal weight, is what bounds an AI claim's final confidence.
  return inferred.reasoning.map((signal) => ({ detector: 'ai:inference', signal, weight: 0.4 }));
}

/**
 * Infer a `BuildRecipe` for an under-determined repo via the model, validated and
 * wrapped as an `ai`-sourced `Claim`. Returns null when the model call or validation
 * fails — inference is best-effort and never fails detection. The caller supplies the
 * `AIFacade` (so this is unit-testable without the network) and the cost ledger.
 */
export async function inferBuild(
  input: InferenceInput,
  ledger: CostLedger,
  ai: AIFacade
): Promise<Claim<BuildRecipe> | null> {
  let inferred: InferredBuild;
  try {
    inferred = await ai.complete(buildInferencePrompt(input), InferredBuildSchema, ledger, {
      schemaName: 'InferredBuild',
    });
  } catch {
    return null;
  }

  const recipe: BuildRecipe = {
    id: `ai-${inferred.runtime}`,
    runtime: inferred.runtime as Runtime,
    dependencyFiles: [],
    installCommands: inferred.installCommands,
    startCommand: inferred.startCommand,
    defaultPorts: inferred.ports,
    // Inference doesn't pick base images; the synthesizer fills sane per-runtime
    // defaults. Placeholder here keeps the recipe shape valid for review.
    baseImages: { build: '', runtime: '' },
  };
  if (inferred.packageManager) {
    recipe.packageManager = inferred.packageManager as NonNullable<BuildRecipe['packageManager']>;
  }
  if (inferred.buildCommands.length > 0) recipe.buildCommands = inferred.buildCommands;

  return claim(recipe, inferenceEvidence(inferred), 'ai');
}
