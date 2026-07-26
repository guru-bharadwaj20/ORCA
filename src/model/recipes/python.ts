/**
 * Python framework recipes expressed as DATA on the Phase-A `BuildRecipe` model. Django
 * already ships as a seed recipe; this adds the other two frameworks a student or
 * hackathon repo actually uses — FastAPI (ASGI, uvicorn) and Flask (WSGI, gunicorn) —
 * each in three package-manager flavours: uv, Poetry, and plain pip.
 *
 * WHY THREE ENTRIES PER FRAMEWORK. `BuildRecipe` carries one `dependencyFiles` list and
 * one `installCommands` list, so "install with uv" and "install with pip" are different
 * recipes, not a branch inside one. Each variant is selected by its lockfile via the
 * matcher's `anyFile`, most-specific-first (uv.lock → poetry.lock → requirements.txt),
 * which is exactly how the seed Django recipe already keys off `manage.py`.
 *
 * NOTE: the matchers depend on the caller putting lockfile names in `MatchFacts.files`.
 * That is the same contract `python-django` relies on for `manage.py`.
 *
 * PHASE: B (widen deterministic detection) — REAL code, pure data + a small builder.
 */

import type { RecipeEntry } from '../recipe.js';

/** Python images: same tag for build and runtime — nothing here is compiled. */
const PYTHON_IMAGES = { build: 'python:3.12-slim', runtime: 'python:3.12-slim' } as const;

/** The framework-specific half of a Python service recipe. */
interface PythonService {
  /** Base recipe id; the pip variant keeps it verbatim, others suffix it. */
  id: string;
  /** Direct dependency that identifies the framework, e.g. "fastapi". */
  dependency: string;
  /**
   * The server binary the start command invokes. An open string, not a union: several
   * frameworks ARE their own server (`sanic`, `streamlit`), and a closed union would make
   * adding one an enum edit — the same shape the framework taxonomies now use.
   */
  server: string;
  /** Everything after the server binary, e.g. "main:app --host 0.0.0.0 --port 8000". */
  serverArgs: string;
  /** In-container port the start command binds. */
  port: number;
}

/**
 * Expand one framework into its uv / Poetry / pip recipes, in match priority order.
 *
 * The pip variant additionally installs the server itself: a messy repo pins `flask`
 * and forgets `gunicorn`, and adding it is standard containerization practice (the same
 * thing a buildpack does) rather than an invented build step. The uv and Poetry variants
 * deliberately do NOT — a lockfile-managed repo has already declared what it needs, and
 * a stray `pip install` would land outside the managed environment anyway.
 */
function pythonServiceRecipes(service: PythonService): RecipeEntry[] {
  const { id, dependency, server, serverArgs, port } = service;
  const start = `${server} ${serverArgs}`;
  const common = {
    runtime: 'python' as const,
    defaultPorts: [port],
    baseImages: PYTHON_IMAGES,
  };

  return [
    {
      matcher: { runtime: 'python', anyDependency: [dependency], anyFile: ['uv.lock'] },
      recipe: {
        ...common,
        id: `${id}-uv`,
        packageManager: 'uv',
        dependencyFiles: ['pyproject.toml', 'uv.lock'],
        // --no-install-project: the source isn't copied yet at install time (deps are
        // copied first for layer caching), so only dependencies can be resolved here.
        installCommands: ['pip install uv', 'uv sync --frozen --no-install-project'],
        // --no-sync keeps `uv run` from touching the network at container start.
        startCommand: `uv run --frozen --no-sync ${start}`,
      },
    },
    {
      matcher: { runtime: 'python', anyDependency: [dependency], anyFile: ['poetry.lock'] },
      recipe: {
        ...common,
        id: `${id}-poetry`,
        packageManager: 'poetry',
        dependencyFiles: ['pyproject.toml', 'poetry.lock'],
        installCommands: ['pip install poetry', 'poetry install --no-root --no-interaction'],
        // `poetry run` resolves the virtualenv Poetry created during install.
        startCommand: `poetry run ${start}`,
      },
    },
    {
      matcher: { runtime: 'python', anyDependency: [dependency], anyFile: ['requirements.txt'] },
      recipe: {
        ...common,
        id,
        packageManager: 'pip',
        dependencyFiles: ['requirements.txt'],
        installCommands: ['pip install -r requirements.txt', `pip install ${server}`],
        startCommand: start,
      },
    },
  ];
}

/**
 * FastAPI and Flask across uv / Poetry / pip. The module paths (`main:app`, `app:app`)
 * are each framework's documented convention and the shape scaffolding tools emit; a
 * repo that differs is corrected by the AI fill or the self-heal loop.
 */
export const PYTHON_RECIPES: readonly RecipeEntry[] = [
  ...pythonServiceRecipes({
    id: 'python-fastapi',
    dependency: 'fastapi',
    server: 'uvicorn',
    serverArgs: 'main:app --host 0.0.0.0 --port 8000',
    port: 8000,
  }),
  ...pythonServiceRecipes({
    id: 'python-flask',
    dependency: 'flask',
    server: 'gunicorn',
    serverArgs: '--bind 0.0.0.0:8000 app:app',
    port: 8000,
  }),
  ...pythonServiceRecipes({
    id: 'python-litestar',
    dependency: 'litestar',
    server: 'uvicorn',
    serverArgs: 'app:app --host 0.0.0.0 --port 8000',
    port: 8000,
  }),
  ...pythonServiceRecipes({
    id: 'python-starlette',
    dependency: 'starlette',
    server: 'uvicorn',
    serverArgs: 'main:app --host 0.0.0.0 --port 8000',
    port: 8000,
  }),
];
