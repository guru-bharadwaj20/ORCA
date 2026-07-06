#!/bin/sh
set -e

# depends_on only waits for the db CONTAINER to start, not for Postgres to accept
# connections — the classic Django+Postgres race. Wait for the socket first, then
# migrate, then hand off to the CMD (runserver). This is the migrate-before-run fix.
POSTGRES_HOST="${POSTGRES_HOST:-db}"
POSTGRES_PORT="${POSTGRES_PORT:-5432}"

echo "waiting for postgres at ${POSTGRES_HOST}:${POSTGRES_PORT}..."
until python -c "import socket,sys; s=socket.socket(); s.settimeout(2); sys.exit(0 if s.connect_ex(('${POSTGRES_HOST}', ${POSTGRES_PORT}))==0 else 1)"; do
  sleep 1
done

echo "running migrations..."
python manage.py migrate --noinput

echo "starting server..."
exec "$@"
