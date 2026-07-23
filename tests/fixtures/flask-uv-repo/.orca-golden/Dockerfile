# syntax=docker/dockerfile:1
# ORCA synthesized image — recipe python-flask-uv (python).
FROM python:3.12-slim
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN pip install uv
RUN uv sync --frozen --no-install-project
COPY . .
EXPOSE 8000
CMD uv run --frozen --no-sync gunicorn --bind 0.0.0.0:8000 app:app
