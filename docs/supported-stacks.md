# Supported Stacks

What ORCA can containerize today. This used to be a short, deliberately narrow list of
three stacks. It isn't any more, so the framing has changed too: ORCA now tries to place
anything it can gather real evidence about, and says how confident it is rather than
declining outright.

Adding a framework here is adding a `BuildRecipe` plus a matcher, never new control flow.
The engine behind that is described in
[`universal-understanding-plan.md`](universal-understanding-plan.md).

## Build recipes

40 recipes across eight ecosystems.

| Ecosystem | Recipes                                                                                                    |
| :-------- | :--------------------------------------------------------------------------------------------------------- |
| Node      | react, express, next, nest, angular, vite, fastify, koa, hapi, hono, remix, nuxt, sveltekit, astro, adonis |
| Python    | django, fastapi, flask, litestar, starlette, quart, sanic, bottle, streamlit                               |
| PHP       | composer, laravel, symfony                                                                                 |
| Ruby      | bundler, rails, sinatra                                                                                    |
| Go        | go modules, built into a distroless runtime image                                                          |
| Rust      | cargo                                                                                                      |
| JVM       | maven, gradle                                                                                              |
| .NET      | dotnet sdk                                                                                                 |

Each Python framework ships uv, poetry, and pip variants. The matcher picks one by which
lockfile the project actually has, because a recipe carries a single install command and
`uv sync` cannot run against a bare `requirements.txt`.

## When nothing matches

A Node or Python project whose framework has no recipe still gets a container. The bare
runtime fallback matches on a manifest alone, on the reasoning that knowing the runtime
and having a start script is enough to build something that runs. It sits last in the
registry so it can never shadow a real framework recipe.

Where the fallback declines: a directory the role detectors call a `library`, meaning no
binary, no start script, and no entry module. A workspace root holding nothing but
`{ "private": true, "workspaces": [...] }` is the usual case. Placing a service there
would produce a container that starts nothing.

## Databases

Postgres, MongoDB, and Redis, detected from dependencies and wired into the Compose file
with health checks and connection environment variables. Every service that needs one
waits on it rather than racing it.

## Package managers

Node: npm, yarn, pnpm. Python: pip, poetry, uv, pipenv. Plus each ecosystem's own, such
as composer, bundler, cargo, go modules, maven, and gradle. The taxonomy is open, so a new
one is a string and a detection rule.

## Component roles

Not everything is a web service. ORCA assigns `frontend`, `backend`, `worker`, `cli`,
`library`, and `job`. Only frontend and backend are assumed to listen, so a queue worker
or a CLI tool gets no invented port and publishes none.

## Monorepos

Handled as first class. Three Express services in one repo become three containers, each
with its own recipe and its own database wiring, rather than one service and two dropped
warnings. Workspace globs from npm, yarn, and pnpm are expanded to find them.

## Still out of scope

Kubernetes and cloud deployment. ORCA emits Docker and Compose files, nothing else.

Dynamic probing, meaning running the project's own code to observe how it behaves, is
designed and has a seam in the codebase, but is deliberately switched off. The reasoning
is in decision #2 of the plan document: static analysis, CI analysis, and AI inference are
nowhere near exhausted, and every gap closed so far has been closed without executing
anything.
