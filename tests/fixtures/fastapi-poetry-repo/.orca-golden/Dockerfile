# syntax=docker/dockerfile:1
# ORCA synthesized image — recipe python-fastapi-poetry (python).
FROM python:3.12-slim
WORKDIR /app
COPY pyproject.toml poetry.lock ./
RUN pip install poetry
RUN poetry install --no-root --no-interaction
COPY . .
EXPOSE 8000
CMD poetry run uvicorn main:app --host 0.0.0.0 --port 8000
