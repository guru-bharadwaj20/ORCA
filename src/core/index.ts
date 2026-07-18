/**
 * Public entry for the `orca-cli` package: the pipeline + the run context/contracts
 * an embedder needs to drive a run. Importing `orca-cli` gets `runPipeline`,
 * `createRunContext`, and the shared types; the CLI bin stays a separate concern.
 *
 * STAGE: core (library surface) — REAL code.
 */

export * from './pipeline.js';
export * from './context.js';
