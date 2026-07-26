/**
 * Python framework recipes: FastAPI (ASGI/uvicorn) and Flask (WSGI/gunicorn), each in
 * three package-manager flavours selected by lockfile. Asserts the variant ordering
 * (uv.lock → poetry.lock → requirements.txt), that the seed Django recipe is not
 * shadowed by registering these ahead of it, and that a framework with no resolvable
 * manifest returns null rather than a Dockerfile that cannot build.
 */
import { describe, expect, it } from 'vitest';

import type { MatchFacts } from '../../src/model/recipe.js';
import { defaultRecipeRegistry } from '../../src/model/recipes/index.js';

const registry = defaultRecipeRegistry();
const facts = (over: Partial<MatchFacts>): MatchFacts => ({
  runtime: 'python',
  dependencies: [],
  files: [],
  ...over,
});

describe('FastAPI recipes', () => {
  it('uses uvicorn and pip-installs the server for a requirements.txt repo', () => {
    const recipe = registry.match(
      facts({ dependencies: ['fastapi', 'pydantic'], files: ['requirements.txt'] })
    );
    expect(recipe?.id).toBe('python-fastapi');
    expect(recipe?.packageManager).toBe('pip');
    expect(recipe?.dependencyFiles).toEqual(['requirements.txt']);
    // A messy repo pins fastapi and forgets uvicorn — install it explicitly.
    expect(recipe?.installCommands).toEqual([
      'pip install -r requirements.txt',
      'pip install uvicorn',
    ]);
    expect(recipe?.startCommand).toBe('uvicorn main:app --host 0.0.0.0 --port 8000');
    expect(recipe?.defaultPorts).toEqual([8000]);
  });

  it('switches to Poetry install + `poetry run` when poetry.lock is present', () => {
    const recipe = registry.match(
      facts({ dependencies: ['fastapi'], files: ['pyproject.toml', 'poetry.lock'] })
    );
    expect(recipe?.id).toBe('python-fastapi-poetry');
    expect(recipe?.packageManager).toBe('poetry');
    expect(recipe?.dependencyFiles).toEqual(['pyproject.toml', 'poetry.lock']);
    expect(recipe?.installCommands).toEqual([
      'pip install poetry',
      'poetry install --no-root --no-interaction',
    ]);
    expect(recipe?.startCommand).toBe('poetry run uvicorn main:app --host 0.0.0.0 --port 8000');
  });

  it('switches to uv sync + `uv run` when uv.lock is present', () => {
    const recipe = registry.match(
      facts({ dependencies: ['fastapi'], files: ['pyproject.toml', 'uv.lock'] })
    );
    expect(recipe?.id).toBe('python-fastapi-uv');
    expect(recipe?.packageManager).toBe('uv');
    expect(recipe?.dependencyFiles).toEqual(['pyproject.toml', 'uv.lock']);
    expect(recipe?.installCommands).toEqual([
      'pip install uv',
      'uv sync --frozen --no-install-project',
    ]);
    // --no-sync so container start never reaches for the network.
    expect(recipe?.startCommand).toBe(
      'uv run --frozen --no-sync uvicorn main:app --host 0.0.0.0 --port 8000'
    );
  });
});

describe('Flask recipes', () => {
  it('uses gunicorn and pip-installs the server for a requirements.txt repo', () => {
    const recipe = registry.match(
      facts({ dependencies: ['flask', 'flask-cors'], files: ['requirements.txt'] })
    );
    expect(recipe?.id).toBe('python-flask');
    expect(recipe?.installCommands).toEqual([
      'pip install -r requirements.txt',
      'pip install gunicorn',
    ]);
    expect(recipe?.startCommand).toBe('gunicorn --bind 0.0.0.0:8000 app:app');
  });

  it('produces the Poetry and uv flavours too', () => {
    expect(
      registry.match(facts({ dependencies: ['flask'], files: ['pyproject.toml', 'poetry.lock'] }))
        ?.id
    ).toBe('python-flask-poetry');
    expect(
      registry.match(facts({ dependencies: ['flask'], files: ['pyproject.toml', 'uv.lock'] }))?.id
    ).toBe('python-flask-uv');
  });
});

describe('variant selection and seed preservation', () => {
  it('prefers the lockfile variant when a requirements.txt is also present', () => {
    // Repos routinely leave a stale requirements.txt behind after adopting a lockfile.
    expect(
      registry.match(
        facts({ dependencies: ['fastapi'], files: ['requirements.txt', 'poetry.lock'] })
      )?.id
    ).toBe('python-fastapi-poetry');
    expect(
      registry.match(facts({ dependencies: ['flask'], files: ['requirements.txt', 'uv.lock'] }))?.id
    ).toBe('python-flask-uv');
  });

  it('does not shadow the seed Django recipe', () => {
    const recipe = registry.match(
      facts({ dependencies: ['django', 'psycopg2-binary'], files: ['manage.py'] })
    );
    expect(recipe?.id).toBe('python-django');
    expect(recipe?.systemPackages).toEqual(['libpq-dev', 'gcc']);
  });

  it('returns null when the framework is present but no manifest resolves an install', () => {
    // Honest no-match (the synthesis / AI-inference signal) beats emitting a Dockerfile
    // whose `COPY requirements.txt` is guaranteed to fail. Still true with NO manifest at
    // all: there is nothing any install command could copy.
    expect(registry.match(facts({ dependencies: ['fastapi'], files: [] }))).toBeNull();
  });

  it('falls back to the pyproject bare recipe when no framework variant fits', () => {
    // A Flask repo declaring its dependencies inline in `[project.dependencies]` — no
    // lockfile, no requirements.txt — is a real shape no `python-flask` variant covers.
    // It previously matched NOTHING and detected as unsupported; the bare pyproject
    // fallback builds it correctly (`COPY pyproject.toml` + `pip install .`), which is
    // why the guarantee above is scoped to "no manifest" rather than "no framework
    // variant". The framework-specific start command is what is given up, and build
    // recovery or the AI fill supplies it.
    const recipe = registry.match(facts({ dependencies: ['flask'], files: ['pyproject.toml'] }));

    expect(recipe?.id).toBe('python-app-pyproject');
    expect(recipe?.installCommands).toEqual(['pip install .']);
    expect(recipe?.dependencyFiles).toEqual(['pyproject.toml']);
  });
});
