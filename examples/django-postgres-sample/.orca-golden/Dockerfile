# syntax=docker/dockerfile:1
# ORCA Stage 1 — Python service (Django app), dev mode.
FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends libpq-dev gcc \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./
RUN pip install -r requirements.txt

COPY . .

EXPOSE 8000

COPY entrypoint.sh /usr/local/bin/orca-entrypoint
RUN chmod +x /usr/local/bin/orca-entrypoint
ENTRYPOINT ["/usr/local/bin/orca-entrypoint"]

CMD python manage.py runserver 0.0.0.0:8000
